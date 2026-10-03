/**
 * `RecordTable.batch` (`record-table.ts`): one `buildSlice`/publish per
 * envelope of several `applyUpsert`/`applyRemoval` calls, with per-row
 * admission (revision guard, retraction, ingest fence) unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatRecordRemovalReason } from "@traycer/protocol/host/epic/chat-records";
import {
  createRecordTable,
  type RecordTable,
  type RecordTablePlane,
} from "../runtime/record-table";

interface Row {
  readonly id: string;
  readonly revision: number;
  readonly value: string;
}

function row(id: string, revision: number, value: string): Row {
  return { id, revision, value };
}

function makeTable(onBuildSlice: () => void): RecordTable<Row, readonly Row[]> {
  const plane: RecordTablePlane<Row, readonly Row[]> = {
    rowKey: (r) => r.id,
    retractionIdOf: (r) => r.id,
    isVisibleToUser: () => true,
    supersedesOnSnapshot: (candidate, held) =>
      candidate.revision > held.revision,
    supersedesOnUpsert: (candidate, held) => candidate.revision > held.revision,
    recency: null,
    buildSlice: (visibleRows) => {
      onBuildSlice();
      return [...visibleRows].sort((a, b) => a.id.localeCompare(b.id));
    },
    slicesEq: (a, b) => a.length === b.length && a.every((r, i) => r === b[i]),
    emptySlice: [],
  };
  return createRecordTable(plane, {
    getCurrentUserId: () => null,
    onBeforePublish: () => undefined,
    onRowServed: () => undefined,
    onUpsertAdmitted: () => undefined,
    onRemoval: () => false,
  });
}

const REMOVED: ChatRecordRemovalReason = "deleted";

describe("RecordTable.batch - one recompute for the whole envelope", () => {
  it("calls buildSlice exactly once for several admitted upserts, and every inner call is inert", () => {
    let buildSliceCalls = 0;
    const table = makeTable(() => {
      buildSliceCalls += 1;
    });

    let innerA: unknown;
    let innerB: unknown;
    let innerC: unknown;
    const publication = table.batch(() => {
      innerA = table.applyUpsert(row("a", 1, "a"), "complete");
      innerB = table.applyUpsert(row("b", 1, "b"), "complete");
      innerC = table.applyUpsert(row("c", 1, "c"), "complete");
    });

    expect(innerA).toBeNull();
    expect(innerB).toBeNull();
    expect(innerC).toBeNull();
    expect(buildSliceCalls).toBe(1);
    expect(publication?.slice.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the revision guard sequential within one batch", () => {
    // A later call in the SAME batch must still be judged against what an
    // earlier call in that batch just admitted - batching defers the PUBLISH,
    // not the admission order.
    const table = makeTable(() => undefined);
    table.applyUpsert(row("a", 5, "seed"), "complete");

    let replayResult: unknown;
    const publication = table.batch(() => {
      table.applyUpsert(row("a", 9, "first"), "complete");
      // A replay at revision 9 - equal to what THIS BATCH just wrote, not to
      // the pre-batch seed - must still be rejected.
      replayResult = table.applyUpsert(row("a", 9, "replay"), "complete");
    });

    expect(replayResult).toBeNull();
    expect(publication?.slice.find((r) => r.id === "a")?.value).toBe("first");
  });

  it("protects a row admitted mid-batch from a snapshot fenced before the batch began", () => {
    const table = makeTable(() => undefined);
    const fenceBeforeBatch = table.ingestSeq();

    table.batch(() => {
      table.applyUpsert(row("a", 1, "a"), "complete");
      table.applyUpsert(row("b", 1, "b"), "complete");
    });

    // An answer dispatched before the batch cannot know about either row, so
    // its omission of both must not retract them - exactly as an unbatched
    // apply would honor rule 1's carried-and-omitted fence.
    const publication = table.applySnapshot([], fenceBeforeBatch);
    expect(publication).toBeNull();
    expect(table.current().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("absorbs a removal issued after its row's upsert in the same batch, terminally", () => {
    const table = makeTable(() => undefined);

    let removalResult: unknown;
    let resurrectResult: unknown;
    const publication = table.batch(() => {
      table.applyUpsert(row("a", 1, "a"), "complete");
      removalResult = table.applyRemoval("a", REMOVED);
      // Terminal within the batch too: nothing after the removal resurrects it.
      resurrectResult = table.applyUpsert(row("a", 2, "a"), "complete");
    });

    expect(removalResult).toBeNull();
    expect(resurrectResult).toBeNull();
    expect(publication?.slice.map((r) => r.id)).toEqual([]);
    expect(publication?.retractions).toEqual({ a: REMOVED });
    expect(table.isRetracted("a")).toBe(true);
  });

  it("returns null and never calls buildSlice when nothing inside the batch was admitted", () => {
    const buildSliceSpy = vi.fn();
    const table = makeTable(buildSliceSpy);
    table.applyUpsert(row("a", 5, "a"), "complete");
    buildSliceSpy.mockClear();

    let staleResult: unknown;
    const publication = table.batch(() => {
      // Equal revision to what is already held - rejected before recompute,
      // exactly as an unbatched applyUpsert never calls buildSlice for one.
      staleResult = table.applyUpsert(row("a", 5, "stale"), "complete");
    });

    expect(staleResult).toBeNull();
    expect(publication).toBeNull();
    expect(buildSliceSpy).not.toHaveBeenCalled();
  });
});
