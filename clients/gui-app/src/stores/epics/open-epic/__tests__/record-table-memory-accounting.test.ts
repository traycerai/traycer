import { describe, expect, it } from "vitest";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import type { ChatRecordDelta } from "@traycer-clients/shared/host-transport/chat-records-stream-client";
import {
  createRecordTable,
  type RecordTablePlane,
} from "../runtime/record-table";
import { createChatRecordTable } from "../runtime/chat-record-table";

const EPIC_ID = "epic-record-table-memory-accounting";

function chatRecord(
  overrides: Partial<ChatRecordSummaryV11>,
): ChatRecordSummaryV11 {
  return {
    chatId: "chat-accounting",
    ownerUserId: "owner-accounting",
    originHostId: "host-accounting",
    title: "Initial",
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    archivedAt: null,
    runSettingsSummary: "claude",
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    ...overrides,
  };
}

describe("record table retained-row accounting", () => {
  it("charges an accepted upsert and replacement, ignores a stale replay, and releases on removal", () => {
    const table = createChatRecordTable({
      getCurrentUserId: () => null,
      onBeforePublish: () => undefined,
      now: () => 0,
    });

    expect(table.retainedRowSize()).toEqual({
      rawBytes: 0,
      estimatedHeapBytes: 0,
    });

    const first: ChatRecordDelta = {
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatRecord({ title: "First row", revision: 1 }),
    };
    expect(table.applyDelta(first)).not.toBeNull();
    const firstSize = table.retainedRowSize();
    expect(firstSize.rawBytes).toBeGreaterThan(0);
    expect(firstSize.estimatedHeapBytes).toBeGreaterThan(0);

    const staleReplay: ChatRecordDelta = {
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatRecord({
        title: `stale replay ${"old/".repeat(100)}`,
        revision: 1,
      }),
    };
    expect(table.applyDelta(staleReplay)).toBeNull();
    expect(table.retainedRowSize()).toEqual(firstSize);

    const replacement: ChatRecordDelta = {
      kind: "upsert",
      epicId: EPIC_ID,
      record: chatRecord({
        title: `accepted replacement ${"new/".repeat(100)}`,
        revision: 2,
      }),
    };
    expect(table.applyDelta(replacement)).not.toBeNull();
    const replacedSize = table.retainedRowSize();
    expect(replacedSize.rawBytes).toBeGreaterThan(firstSize.rawBytes);
    expect(replacedSize.estimatedHeapBytes).toBeGreaterThan(
      firstSize.estimatedHeapBytes,
    );

    const removal: ChatRecordDelta = {
      kind: "remove",
      epicId: EPIC_ID,
      chatId: "chat-accounting",
      reason: "deleted",
    };
    expect(table.applyDelta(removal)).not.toBeNull();
    const removedSize = table.retainedRowSize();
    expect(removedSize.rawBytes).toBeGreaterThan(0);
    expect(removedSize.estimatedHeapBytes).toBeGreaterThan(0);
    expect(table.applyDelta(removal)).toBeNull();
    expect(table.retainedRowSize()).toEqual(removedSize);
  });

  it("charges a retained removal for a never-held row and releases it when retractions are forgotten", () => {
    interface Row {
      readonly id: string;
      readonly revision: number;
      readonly payload: string;
    }
    const emptySlice: readonly Row[] = [];
    const plane: RecordTablePlane<Row, readonly Row[]> = {
      rowKey: (row) => row.id,
      retractionIdOf: (row) => row.id,
      isVisibleToUser: () => true,
      supersedesOnSnapshot: (candidate, held) =>
        candidate.revision > held.revision,
      supersedesOnUpsert: (candidate, held) =>
        candidate.revision > held.revision,
      recency: null,
      buildSlice: (rows) => rows,
      slicesEq: (left, right) => left.length === right.length,
      emptySlice,
    };
    const table = createRecordTable(plane, {
      getCurrentUserId: () => null,
      onBeforePublish: () => undefined,
      onRowServed: () => undefined,
      onUpsertAdmitted: () => undefined,
      onRemoval: () => false,
    });
    const baseline = table.retainedRowSize();

    const publication = table.applyRemoval("never-held", "deleted");
    expect(publication).not.toBeNull();
    expect(publication?.retractions).toEqual({ "never-held": "deleted" });
    const retained = table.retainedRowSize();
    expect(retained.rawBytes).toBeGreaterThan(baseline.rawBytes);
    expect(retained.estimatedHeapBytes).toBeGreaterThan(
      baseline.estimatedHeapBytes,
    );

    expect(table.applyRemoval("never-held", "deleted")).toBeNull();
    expect(table.retainedRowSize()).toEqual(retained);

    table.forgetRetractions();
    expect(table.retainedRowSize()).toEqual(baseline);
  });
});
