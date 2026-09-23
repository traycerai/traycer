/**
 * `agentIdentity.state.subscribe` rows applied through the SHARED record-table
 * algorithm - the consumer whose absorbing removals made a path-only row key
 * unusable.
 *
 * The identity lane has no production replica yet, so this drives the real
 * identity lane adapter into `createRecordTable` configured exactly as the epic
 * lane replica configures it (row key = retraction id = the lane's `rowId`,
 * strict revision guard). A removal there is terminal: nothing ever re-admits a
 * retracted key. Keyed by path alone, rename A to B and back, or delete and
 * recreate A, left the second A suppressed for the life of the epoch. Keyed by
 * `(path, incarnation)`, each life of a path is its own key and the second A is
 * held.
 *
 * Every frame is parsed through the real wire schema, so fixture drift fails at
 * construction.
 */
import { describe, expect, it } from "vitest";
import { agentIdentityStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/agent-identity/state-subscribe";
import {
  createIdentityStateLaneAdapter,
  identityDocumentRowId,
  type IdentityStateLaneEvent,
  type IdentityStateRow,
} from "@traycer-clients/shared/identity-lanes";
import type {
  IdentityStateDeltaFrame,
  IdentityStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/identity-state-stream-client";
import type {
  AdapterHost,
  RecordRow,
} from "@traycer-clients/shared/replica-runtime";
import { createRecordTable, type RecordTable } from "../runtime/record-table";

type HeldRow = RecordRow<IdentityStateRow>;

/** The paths of the document and blob rows the table currently holds. */
interface HeldPaths {
  readonly documents: readonly string[];
  readonly files: readonly string[];
}

const EMPTY_HELD_PATHS: HeldPaths = { documents: [], files: [] };

function createIdentityTable(): RecordTable<HeldRow, HeldPaths> {
  return createRecordTable<HeldRow, HeldPaths>(
    {
      rowKey: (row) => row.rowId,
      retractionIdOf: (row) => row.rowId,
      isVisibleToUser: () => true,
      supersedesOnSnapshot: (candidate, held) =>
        candidate.revision > held.revision,
      supersedesOnUpsert: (candidate, held) =>
        candidate.revision > held.revision,
      recency: null,
      buildSlice: (rows) => ({
        documents: rows.flatMap((held) =>
          held.row.kind === "document" ? [held.row.row.path] : [],
        ),
        files: rows.flatMap((held) =>
          held.row.kind === "file" ? [held.row.row.path] : [],
        ),
      }),
      slicesEq: (a, b) =>
        JSON.stringify(a.documents) === JSON.stringify(b.documents) &&
        JSON.stringify(a.files) === JSON.stringify(b.files),
      emptySlice: EMPTY_HELD_PATHS,
    },
    {
      getCurrentUserId: () => null,
      onBeforePublish: () => {},
      onRowServed: () => {},
      onUpsertAdmitted: () => {},
      onRemoval: () => false,
    },
  );
}

/**
 * The identity lane adapter, attached to a host that applies every
 * transaction it emits to `table` - the same mapping the epic lane replica
 * makes (`remove` → `applyRemoval`, `upsert` → `applyUpsert`).
 */
function attachAdapterTo(
  table: RecordTable<HeldRow, HeldPaths>,
): IdentityStateStreamCallbacks {
  const opened: IdentityStateStreamCallbacks[] = [];
  const adapter = createIdentityStateLaneAdapter({
    identityId: "identity_1",
    streamClientFactory: (_identityId, streamCallbacks) => {
      opened.push(streamCallbacks);
      return { close: () => {} };
    },
    readAppliedCursor: () => null,
    isDisposed: () => false,
  });
  const host: AdapterHost<IdentityStateLaneEvent> = {
    environment: {
      clock: { now: () => 0 },
      scheduler: {
        schedule: () => ({ cancel: () => {} }),
        scheduleMicrotask: () => {},
      },
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
    },
    emit: (event) => {
      if (event.kind !== "record-transaction") return;
      for (const change of event.changes) {
        if (change.kind === "remove") {
          table.applyRemoval(change.rowId, "deleted");
        } else {
          table.applyUpsert(change.row, "complete");
        }
      }
    },
    reportResume: () => {},
    reportStatus: () => {},
    requestReplacement: () => {},
  };
  adapter.attach(host);
  const callbacks = opened.at(0);
  if (callbacks === undefined) {
    throw new Error("adapter never opened its stream");
  }
  return callbacks;
}

interface Removal {
  readonly population: "document" | "file";
  readonly path: string;
  readonly incarnation: string;
}

function delta(
  seq: number,
  upserts: {
    readonly documents: readonly { path: string; incarnation: string }[];
    readonly files: readonly { path: string; incarnation: string }[];
  },
  removals: readonly Removal[],
): IdentityStateDeltaFrame {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "delta",
    authorityEpoch: "epoch-1",
    seq,
    documentUpserts: upserts.documents.map(({ path, incarnation }) => ({
      path,
      incarnation,
      // A markdown fragment is named after its path, so a rename back to A
      // lands on the same fragment name the first A had.
      shardRoomId: "shard-a",
      fragmentName: `identity-file:${path}`,
      updatedAt: seq,
      provenance: "user_session",
      revision: 1,
    })),
    fileUpserts: upserts.files.map(({ path, incarnation }) => ({
      path,
      incarnation,
      entry: {
        v: 1,
        kind: "blob",
        current: {
          // The same bytes every time: the hash cannot tell two lives apart.
          sha256: "a".repeat(64),
          byteLength: 12,
          mediaType: "image/png",
          createdAt: seq,
          createdBy: "user-1",
          producer: { type: "agent", chatId: "chat-1" },
        },
        status: "available",
      },
      revision: 1,
    })),
    removals: removals.map((removal) => ({ ...removal, revision: 2 })),
    identity: null,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "delta") throw new Error("fixture drift: delta");
  return parsed;
}

describe("identity index rows through the shared record table", () => {
  it("holds a document renamed away and back again", () => {
    const table = createIdentityTable();
    const lane = attachAdapterTo(table);

    lane.onDelta(
      delta(
        1,
        { documents: [{ path: "a.md", incarnation: "a1" }], files: [] },
        [],
      ),
    );
    // A → B, then B → A: each rename is one envelope carrying the
    // destination's fresh life and the source's removal.
    lane.onDelta(
      delta(
        2,
        { documents: [{ path: "b.md", incarnation: "b1" }], files: [] },
        [{ population: "document", path: "a.md", incarnation: "a1" }],
      ),
    );
    lane.onDelta(
      delta(
        3,
        { documents: [{ path: "a.md", incarnation: "a2" }], files: [] },
        [{ population: "document", path: "b.md", incarnation: "b1" }],
      ),
    );

    expect(table.current()).toEqual({ documents: ["a.md"], files: [] });
  });

  it("holds a blob deleted and recreated from the same bytes", () => {
    const table = createIdentityTable();
    const lane = attachAdapterTo(table);

    lane.onDelta(
      delta(
        1,
        { documents: [], files: [{ path: "logo.png", incarnation: "f1" }] },
        [],
      ),
    );
    lane.onDelta(
      delta(2, { documents: [], files: [] }, [
        { population: "file", path: "logo.png", incarnation: "f1" },
      ]),
    );
    expect(table.current()).toEqual({ documents: [], files: [] });

    lane.onDelta(
      delta(
        3,
        { documents: [], files: [{ path: "logo.png", incarnation: "f2" }] },
        [],
      ),
    );

    expect(table.current()).toEqual({ documents: [], files: ["logo.png"] });
  });

  it("control: the table never re-admits a retracted key, whatever its revision", () => {
    // Why the key has to carry the incarnation. With a path-only key both lives
    // of `a.md` would be this one row, and its second life would be refused.
    const table = createIdentityTable();
    const lane = attachAdapterTo(table);
    lane.onDelta(
      delta(
        1,
        { documents: [{ path: "a.md", incarnation: "a1" }], files: [] },
        [],
      ),
    );
    lane.onDelta(
      delta(2, { documents: [], files: [] }, [
        { population: "document", path: "a.md", incarnation: "a1" },
      ]),
    );

    const firstLife = identityDocumentRowId("a.md", "a1");
    expect(table.isRetracted(firstLife)).toBe(true);
    table.applyUpsert(
      {
        rowId: firstLife,
        revision: 99,
        row: {
          kind: "document",
          row: {
            path: "a.md",
            incarnation: "a1",
            shardRoomId: "shard-a",
            fragmentName: "identity-file:a.md",
            updatedAt: 3,
            provenance: "user_session",
            revision: 99,
          },
        },
      },
      "complete",
    );
    expect(table.current()).toEqual({ documents: [], files: [] });
  });
});
