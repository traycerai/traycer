/**
 * The records lane's read model, pinned against the rules that read backwards
 * from each other.
 *
 * Every frame here is built through the REAL schema's `.parse()` rather than as
 * a hand literal. That is the fixture standard this branch settled on and it
 * has already paid for itself twice: a fixture that constructs cleanly against
 * a stale shape passes against a stale adapter, and the failure surfaces as a
 * green suite. When a contract field becomes required, construction fails here
 * instead of the assertion passing for the wrong reason.
 */
import { describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import type { EpicStateSubscribeServerFrameV10 } from "@traycer/protocol/host/epic/state-subscribe";
import type {
  EpicStateLaneEvent,
  EpicStateRow,
} from "@traycer-clients/shared/epic-lanes";
import {
  ARTIFACT_TOMBSTONE_REMOVE_REASON,
  EPIC_META_ROW_ID,
  EPIC_STATE_LANE_ID,
  ROLE_CLAIMS_ROW_ID,
  artifactRowId,
  artifactTombstoneRowId,
  commentThreadRowId,
} from "@traycer-clients/shared/epic-lanes";
import type {
  LaneCursor,
  RecordRow,
} from "@traycer-clients/shared/replica-runtime";
import {
  createEpicLaneStateReplica,
  type EpicLaneStateReplica,
} from "../epic-lane-state-replica";
import { selectLaneCommentThreads } from "@/hooks/comments/use-lane-comment-threads";

const EPOCH = "epoch-1";

/**
 * Parse a server frame through the REAL `@1.0` union - superRefine included, so
 * the "a delta must carry a change" invariant runs on every fixture - and
 * narrow it to the arm the caller asked for. The private per-arm schemas are
 * not exported; going through the union is stricter anyway.
 */
function parseSnapshotFrame(
  raw: unknown,
): Extract<EpicStateSubscribeServerFrameV10, { kind: "snapshot" }> {
  const frame = epicStateSubscribeServerFrameSchemaV10.parse(raw);
  if (frame.kind !== "snapshot") {
    throw new Error(`expected a snapshot frame, got ${frame.kind}`);
  }
  return frame;
}

function parseDeltaFrame(
  raw: unknown,
): Extract<EpicStateSubscribeServerFrameV10, { kind: "delta" }> {
  const frame = epicStateSubscribeServerFrameSchemaV10.parse(raw);
  if (frame.kind !== "delta") {
    throw new Error(`expected a delta frame, got ${frame.kind}`);
  }
  return frame;
}

function cursorAt(position: number, epoch: string): LaneCursor {
  return { authorityEpoch: epoch, lane: EPIC_STATE_LANE_ID, position };
}

/** A live artifact row, built through the wire schema so the shape is real. */
function artifactRow(overrides: {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly parentId: string | null;
}): RecordRow<EpicStateRow> {
  const frame = parseSnapshotFrame({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: EPOCH,
    basis: "cold",
    position: 0,
    reconciledWithCloud: true,
    artifactRecords: [
      {
        kind: "spec",
        id: overrides.id,
        folderName: `${overrides.id}-folder`,
        title: overrides.title,
        createdAt: 1,
        updatedAt: 2,
        createdManually: true,
        parentId: overrides.parentId,
        revision: overrides.revision,
      },
    ],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: { revision: 1, meta: { title: "Epic", updatedAt: 10 } },
  });
  const record = frame.artifactRecords[0];
  return {
    rowId: artifactRowId(record.id),
    revision: record.revision,
    row: { kind: "artifact", record },
  };
}

function snapshotEvent(args: {
  readonly rows: readonly RecordRow<EpicStateRow>[];
  readonly position: number;
  readonly epoch: string;
  readonly trust: "seed-only" | "reconciled-with-cloud";
  readonly cause: "initial" | "reseed";
}): EpicStateLaneEvent {
  return {
    kind: "record-snapshot",
    watermark: cursorAt(args.position, args.epoch),
    rows: args.rows,
    trust: args.trust,
    cause: args.cause,
  };
}

/**
 * A snapshot's metadata and claim rows, which the adapter emits on EVERY
 * snapshot - an epic with no claims is a fact the snapshot states, and omitting
 * the row would leave a previous epoch's set renderable.
 */
function metaRows(args: {
  readonly title: string;
  readonly updatedAt: number;
  readonly revision: number;
}): readonly RecordRow<EpicStateRow>[] {
  return [
    {
      rowId: ROLE_CLAIMS_ROW_ID,
      revision: 1,
      row: { kind: "role-claims", claims: [] },
    },
    {
      rowId: EPIC_META_ROW_ID,
      revision: args.revision,
      row: {
        kind: "epic-meta",
        meta: { title: args.title, updatedAt: args.updatedAt },
      },
    },
  ];
}

function newReplica(): {
  readonly replica: EpicLaneStateReplica;
  readonly changes: () => number;
} {
  let changed = 0;
  const replica = createEpicLaneStateReplica({
    getCurrentUserId: () => "user-a",
    isDisposed: () => false,
    onChanged: () => {
      changed += 1;
    },
  });
  return { replica, changes: () => changed };
}

describe("epic.state.subscribe read model - applied cursor", () => {
  it("advances only after the whole envelope is applied, and reports the snapshot's own watermark", () => {
    const { replica } = newReplica();
    expect(replica.appliedCursor()).toBeNull();

    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "A", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 7,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    // The snapshot's high-water mark, carried on the frame rather than inferred
    // from a first delta a quiet epic may never send.
    expect(replica.appliedCursor()).toEqual(cursorAt(7, EPOCH));
  });

  it("does NOT advance on a delta the replica ignored as a duplicate", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        position: 7,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    const outcome = replica.apply({
      kind: "record-transaction",
      // At the watermark, not past it: a replay.
      cursor: cursorAt(7, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: artifactRow({
            id: "a",
            title: "A",
            revision: 1,
            parentId: null,
          }),
        },
      ],
      barrier: null,
    });

    expect(outcome).toEqual({ kind: "ignored", reason: "duplicate" });
    // The whole point: a resume built on this cursor asks the host to continue
    // from work this client finished, never from work it skipped.
    expect(replica.appliedCursor()).toEqual(cursorAt(7, EPOCH));
    expect(replica.slices().artifacts.allIds).toEqual([]);
  });
});

describe("epic.state.subscribe read model - row rules", () => {
  it("upserts only on a strictly greater revision", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "First", revision: 5, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(2, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: artifactRow({
            id: "a",
            title: "Equal revision",
            revision: 5,
            parentId: null,
          }),
        },
      ],
      barrier: null,
    });
    expect(replica.slices().artifacts.byId.a.title).toBe("First");

    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(3, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: artifactRow({
            id: "a",
            title: "Greater revision",
            revision: 6,
            parentId: null,
          }),
        },
      ],
      barrier: null,
    });
    expect(replica.slices().artifacts.byId.a.title).toBe("Greater revision");
  });

  it("absorbs a removal REGARDLESS of revision, and keeps the tombstone renderable", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "Live", revision: 9, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    const tombstoneFrame = parseDeltaFrame({
      kind: "delta",
      hasBinaryPayload: false,
      authorityEpoch: EPOCH,
      seq: 2,
      artifactUpserts: [],
      artifactTombstones: [
        {
          kind: "spec",
          id: "a",
          title: "Live",
          deletedAt: "2026-01-01T00:00:00.000Z",
          // LOWER than the upsert already applied. It must still remove.
          revision: 3,
        },
      ],
      commentThreadUpserts: [],
      commentThreadRemovals: [],
      roleClaims: null,
      epicMeta: null,
    });
    const tombstone = tombstoneFrame.artifactTombstones[0];

    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(2, EPOCH),
      changes: [
        {
          kind: "remove",
          rowId: artifactRowId("a"),
          revision: tombstone.revision,
          reason: ARTIFACT_TOMBSTONE_REMOVE_REASON,
        },
        {
          kind: "upsert",
          row: {
            rowId: artifactTombstoneRowId("a"),
            revision: tombstone.revision,
            row: { kind: "artifact-tombstone", record: tombstone },
          },
        },
      ],
      barrier: null,
    });

    // Both halves of one tombstone, in one envelope: the live row is gone and
    // the deleted-artifact affordance keeps its title.
    expect(replica.slices().artifacts.allIds).toEqual([]);
    expect(replica.slices().deletedArtifacts.byId.a.title).toBe("Live");

    // Terminal and absorbing: no later upsert resurrects it, at any revision.
    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(3, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: artifactRow({
            id: "a",
            title: "Resurrected",
            revision: 99,
            parentId: null,
          }),
        },
      ],
      barrier: null,
    });
    expect(replica.slices().artifacts.allIds).toEqual([]);
  });

  it("REPLACES on epic-meta and MERGES on epic-meta-patch", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: metaRows({ title: "Original", updatedAt: 10, revision: 1 }),
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );
    expect(replica.slices().epicHeader).toEqual({
      title: "Original",
      updatedAt: 10,
    });

    // A patch carrying ONLY `updatedAt`. Installing it wholesale would drop the
    // title the host deliberately did not restate.
    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(2, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: {
            rowId: EPIC_META_ROW_ID,
            revision: 2,
            row: { kind: "epic-meta-patch", meta: { updatedAt: 20 } },
          },
        },
      ],
      barrier: null,
    });
    expect(replica.slices().epicHeader).toEqual({
      title: "Original",
      updatedAt: 20,
    });

    // A whole row REPLACES, so a title the host has since forgotten does not
    // survive it.
    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(3, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: {
            rowId: EPIC_META_ROW_ID,
            revision: 3,
            row: {
              kind: "epic-meta",
              meta: { title: "Renamed", updatedAt: 30 },
            },
          },
        },
      ],
      barrier: null,
    });
    expect(replica.slices().epicHeader).toEqual({
      title: "Renamed",
      updatedAt: 30,
    });
  });

  it("drops a metadata patch that has nothing to merge onto", () => {
    const { replica } = newReplica();
    // No snapshot has established the entity, so a partial is not an EpicMeta.
    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(1, EPOCH),
      changes: [
        {
          kind: "upsert",
          row: {
            rowId: EPIC_META_ROW_ID,
            revision: 1,
            row: { kind: "epic-meta-patch", meta: { updatedAt: 20 } },
          },
        },
      ],
      barrier: null,
    });
    expect(replica.slices().epicHeader).toEqual({ title: "", updatedAt: 0 });
  });

  it("emits an AUTHORITATIVELY EMPTY thread list for a known artifact, so the selector never falls back to a stale poll", () => {
    // `selectLaneCommentThreads` already draws the distinction: a missing key
    // means "the lane has said nothing about this artifact" and sends the
    // caller to the poll, an empty array means "the lane says there are none".
    // Only the SELECTOR knew that - the producer emitted a key exclusively for
    // artifacts that had threads, so a collaborator deleting an artifact's last
    // thread took its key away, which read as lane silence and left the deleted
    // thread rendered from the last poll until an unrelated refresh.
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "Live", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    // THE REDDENING ASSERTION. `hasOwn`, not truthiness: the whole point is
    // that a present-and-empty entry is a different answer from an absent one,
    // and every other way of asking collapses them.
    const { byArtifactId } = replica.slices().commentThreads;
    expect(Object.hasOwn(byArtifactId, "a")).toBe(true);
    expect(byArtifactId["a"]).toEqual([]);

    // The PRODUCER's own output through the real selector, rather than a
    // hand-built keyed empty in the selector's unit test. The selector has
    // always understood this state; nothing produced it, and that gap is
    // invisible to a test that constructs the input it wants.
    expect(selectLaneCommentThreads(byArtifactId, "a")).toEqual([]);
    expect(selectLaneCommentThreads(byArtifactId, "never-seen")).toBeNull();
  });

  it("says nothing about an artifact the lane has never seen", () => {
    // The control. Seeding an empty array for EVERY id asked about would make
    // the lane claim authority over artifacts it has no rows for, which turns
    // the poll fallback off for surfaces the lane genuinely cannot answer.
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [...metaRows({ title: "Epic", updatedAt: 10, revision: 1 })],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    expect(
      Object.hasOwn(replica.slices().commentThreads.byArtifactId, "never-seen"),
    ).toBe(false);
  });

  it("groups comment threads by artifact, passing the wire row through by reference", () => {
    const { replica } = newReplica();
    const frame = parseSnapshotFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch: EPOCH,
      basis: "cold",
      position: 1,
      reconciledWithCloud: true,
      artifactRecords: [],
      deletedArtifacts: [],
      commentThreads: [
        {
          artifactId: "art-1",
          threadId: "t-1",
          resolved: false,
          createdAt: 5,
          comments: [],
          data: { createdByUserId: "user-a" },
          revision: 1,
        },
      ],
      roleClaims: { revision: 1, claims: [] },
      epicMeta: { revision: 1, meta: { title: "Epic", updatedAt: 10 } },
    });
    const thread = frame.commentThreads[0];

    replica.apply(
      snapshotEvent({
        rows: [
          {
            rowId: commentThreadRowId(thread.artifactId, thread.threadId),
            revision: thread.revision,
            row: { kind: "comment-thread", record: thread },
          },
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    const grouped = replica.slices().commentThreads.byArtifactId["art-1"];
    expect(grouped).toHaveLength(1);
    // Not copied: the lane row IS the wire shape the poll returns, so a
    // recompute that touched an artifact must not churn every thread object.
    expect(grouped[0]).toBe(thread);
  });

  it("leaves the lane's artifactRoomId null, because the wire row omits it", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "A", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );
    // The one projected field the two heads cannot agree on. Stated, not
    // papered over: a body is attached by artifact id over `artifact.subscribe`
    // on this arm, so there is no room name to carry and synthesising one would
    // be a fabricated authority-side fact.
    expect(replica.slices().artifacts.byId.a.artifactRoomId).toBeNull();
  });
});

describe("epic.state.subscribe read model - epoch and trust", () => {
  it("asks for replacement on a delta from another epoch, and does not rebuild itself", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "A", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    const outcome = replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(2, "epoch-2"),
      changes: [],
      barrier: null,
    });

    expect(outcome).toEqual({
      kind: "requires-replacement",
      reason: "authority-epoch-changed",
    });
    // The runtime drives the rebuild, so two lanes reporting one epoch change
    // coalesce into one replacement rather than racing two.
    expect(replica.slices().artifacts.allIds).toEqual(["a"]);
    expect(replica.appliedCursor()).toEqual(cursorAt(1, EPOCH));
  });

  it("overwrites trust with no revision guard, and drops one from a foreign epoch", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        position: 1,
        epoch: EPOCH,
        trust: "seed-only",
        cause: "initial",
      }),
    );
    expect(replica.trust()).toBe("seed-only");

    replica.apply({
      kind: "record-trust",
      authorityEpoch: EPOCH,
      trust: "reconciled-with-cloud",
    });
    expect(replica.trust()).toBe("reconciled-with-cloud");

    const foreign = replica.apply({
      kind: "record-trust",
      authorityEpoch: "epoch-2",
      trust: "seed-only",
    });
    expect(foreign).toEqual({ kind: "ignored", reason: "epoch-mismatch" });
    expect(replica.trust()).toBe("reconciled-with-cloud");
  });

  it("clears the watermark, the epoch and the trust on reset", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "A", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 4,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    replica.reset({ origin: "authority", reason: "manifest-changed" });

    // A replica that kept its watermark would offer a resume into a position
    // space that has been replaced; one that kept its trust would label the
    // next host's seed bytes with the previous host's verdict.
    expect(replica.appliedCursor()).toBeNull();
    expect(replica.authorityEpoch()).toBeNull();
    expect(replica.trust()).toBeNull();
    expect(replica.slices().artifacts.allIds).toEqual([]);
  });

  it("forgets absorbed retractions when the POSITION SPACE is replaced, so the new authority's rows are not censored by the old one's tombstones", () => {
    // Rule 3 of `record-table.ts` makes a removal absorbing "for the life of
    // the session", and justifies it with an ordering argument about ONE store:
    // "the host applies a removal before it emits one, so a response that still
    // carries the row was necessarily issued before the retraction". An
    // authority-epoch replacement is exactly the event that ends that argument
    // - the replacement may be a different replica, on a different host, whose
    // store legitimately still holds the row.
    //
    // `reset` emptied the rows and left the filter, so the replacement's first
    // authoritative snapshot was censored by the replica it replaced, and the
    // row stayed absent for the whole session with nothing anywhere saying why.
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "Live", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );
    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(2, EPOCH),
      changes: [
        {
          kind: "remove",
          rowId: artifactRowId("a"),
          revision: 2,
          reason: ARTIFACT_TOMBSTONE_REMOVE_REASON,
        },
      ],
      barrier: null,
    });
    expect(replica.slices().artifacts.allIds).toEqual([]);

    replica.reset({ origin: "authority", reason: "authority-epoch-changed" });
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "Live", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: "epoch-2",
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    // THE REDDENING ASSERTION.
    expect(replica.slices().artifacts.allIds).toEqual(["a"]);
  });

  it("KEEPS them across a same-authority reseed, where the ordering argument still holds", () => {
    // The control, and it is the reason this is a predicate rather than an
    // unconditional clear. `resume-too-old` is the same host and the same epoch
    // re-serving after a compaction, so a poll answer issued before the removal
    // can still be in flight - which is the case the absorbing rule exists for.
    // Clearing here would resurrect a row seconds after its tab said it was
    // gone.
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "Live", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );
    replica.apply({
      kind: "record-transaction",
      cursor: cursorAt(2, EPOCH),
      changes: [
        {
          kind: "remove",
          rowId: artifactRowId("a"),
          revision: 2,
          reason: ARTIFACT_TOMBSTONE_REMOVE_REASON,
        },
      ],
      barrier: null,
    });

    replica.reset({ origin: "authority", reason: "resume-too-old" });
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "Live", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );

    expect(replica.slices().artifacts.allIds).toEqual([]);
  });

  it("retracts a row a later snapshot omits", () => {
    const { replica } = newReplica();
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "A", revision: 1, parentId: null }),
          artifactRow({ id: "b", title: "B", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 1,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "initial",
      }),
    );
    expect(replica.slices().artifacts.allIds.slice().sort()).toEqual([
      "a",
      "b",
    ]);

    // A lane snapshot is the authority's COMPLETE row set at its watermark, so
    // an omission is a deletion - unlike a poll answer, whose omissions are
    // fenced against what the client ingested since it was issued.
    replica.apply(
      snapshotEvent({
        rows: [
          artifactRow({ id: "a", title: "A", revision: 1, parentId: null }),
          ...metaRows({ title: "Epic", updatedAt: 10, revision: 1 }),
        ],
        position: 2,
        epoch: EPOCH,
        trust: "reconciled-with-cloud",
        cause: "reseed",
      }),
    );
    expect(replica.slices().artifacts.allIds).toEqual(["a"]);
  });
});
