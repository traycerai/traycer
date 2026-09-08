/**
 * The ticket's exit line, made executable at the HEAD level: identical epic
 * content, driven through both heads into the same composition, compared as
 * WHOLE projected values.
 *
 * ## What this test is, and what it is not
 *
 * The exit criterion is projection-level - "indistinguishable to the projection
 * layer from the legacy adapter on identical epic content" - and the contract
 * test for it drives real adapters end to end. This is the DIAGNOSTIC beneath
 * that one: it removes the transport, the adapters and the runtime, leaves only
 * the two heads and the one composition they share, and so answers a different
 * question. The end-to-end test says whether the property holds; this one says
 * WHICH head is wrong when it does not.
 *
 * Both are wanted. A single end-to-end test that fails tells you the epic looks
 * different, not that (say) the lane's tombstone decode dropped a status.
 *
 * ## Why this can be a strict whole-value comparison
 *
 * Because the tail is not duplicated. `composeEpicProjection` owns the unions,
 * the dead-mutation sweep, the role-claim visibility filter, the optimistic
 * overlay and the tree, and BOTH heads feed it. So the only thing two adapters
 * can differ on is what they put in - which is exactly what is compared here.
 * If someone later gives the lane path its own projector, this test keeps
 * passing right up until the two implementations drift, which is why the
 * structural property matters more than the assertion.
 *
 * ## The one field that is NOT equal, stated rather than hidden
 *
 * `artifactRoomId`. `epicArtifactRecordSchema` OMITS it from every arm, because
 * room routing is not the lane's addressing model: a body is attached by
 * ARTIFACT ID over `artifact.subscribe`, under an authority epoch, and there is
 * no room name to carry. Synthesising one would be a fabricated authority-side
 * fact. So the comparison normalises that single field and then asserts, on the
 * legacy side, that it was genuinely populated - otherwise the normalisation
 * would be silently absorbing any future divergence as well as this one.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import type { EpicStateSubscribeServerFrameV10 } from "@traycer/protocol/host/epic/state-subscribe";
import type { EpicStateRow } from "@traycer-clients/shared/epic-lanes";
import {
  EPIC_META_ROW_ID,
  EPIC_STATE_LANE_ID,
  ROLE_CLAIMS_ROW_ID,
  artifactRowId,
  artifactTombstoneRowId,
} from "@traycer-clients/shared/epic-lanes";
import type { RecordRow } from "@traycer-clients/shared/replica-runtime";
import {
  composeEpicProjection,
  ensureMap,
  getEpicMap,
  readEpicRawProjectionSources,
  RECORD_PLANE_COVERS_BOTH,
  type ProjectionInputs,
} from "@/stores/epics/open-epic/projection-helpers";
import { createEpicStateLaneAdapter } from "@traycer-clients/shared/epic-lanes";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import {
  createEpicLaneStateReplica,
  laneRawProjectionSources,
} from "@/stores/epics/open-epic/runtime/epic-lane-state-replica";
import { EMPTY_PENDING_OVERLAY } from "@/stores/epics/open-epic/pending-metadata-overlay";
import {
  EMPTY_CHATS_SLICE,
  EMPTY_TERMINAL_AGENTS_SLICE,
  type ArtifactsSlice,
  type EpicProjectedSlices,
} from "@/stores/epics/open-epic/types";

const EPOCH = "epoch-equiv";
const VIEWER = "user-a";

/**
 * The adapter host's environment. Inert on purpose: the records adapter reads
 * nothing off it on the snapshot path, and a real clock or scheduler here would
 * be a nondeterminism this comparison has no use for.
 */
const TEST_ENVIRONMENT: RuntimeEnvironment = {
  clock: { now: () => 0 },
  scheduler: {
    schedule: () => ({ cancel: () => {} }),
    scheduleMicrotask: (callback: () => void) => {
      callback();
    },
  },
  logger: {
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
};

/**
 * ONE description of an epic's content. Both heads are materialised from this
 * and nothing else, so "identical epic content" is a property of the fixture
 * rather than of two hand-kept-in-sync literals.
 */
interface EpicContent {
  readonly title: string;
  readonly updatedAt: number;
  readonly artifacts: readonly {
    readonly id: string;
    readonly kind: "spec" | "ticket";
    readonly title: string;
    readonly folderName: string;
    readonly parentId: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly createdManually: boolean;
    readonly artifactRoomId: string;
    readonly status: number;
    readonly assignee: string;
  }[];
  readonly deleted: readonly {
    readonly id: string;
    readonly kind: "spec" | "ticket";
    readonly title: string;
    readonly deletedAt: string;
    readonly status: number;
  }[];
}

const CONTENT: EpicContent = {
  title: "Equivalence epic",
  updatedAt: 4_242,
  artifacts: [
    {
      id: "spec-root",
      kind: "spec",
      title: "Root spec",
      folderName: "root-spec",
      parentId: null,
      createdAt: 100,
      updatedAt: 200,
      createdManually: true,
      artifactRoomId: "room-1",
      status: 0,
      assignee: "",
    },
    {
      id: "ticket-child",
      kind: "ticket",
      title: "Child ticket",
      folderName: "child-ticket",
      parentId: "spec-root",
      createdAt: 300,
      updatedAt: 400,
      createdManually: false,
      artifactRoomId: "room-2",
      status: 1,
      assignee: "someone",
    },
    {
      // An orphan: its parent does not exist, so the tree must promote it to a
      // root. The promotion happens in the SHARED tail, so both heads must
      // agree on it for free - which is the point.
      id: "spec-orphan",
      kind: "spec",
      title: "Orphan spec",
      folderName: "orphan-spec",
      parentId: "does-not-exist",
      createdAt: 500,
      updatedAt: 600,
      createdManually: true,
      artifactRoomId: "room-3",
      status: 0,
      assignee: "",
    },
  ],
  deleted: [
    {
      id: "ticket-gone",
      kind: "ticket",
      title: "Deleted ticket",
      deletedAt: "2026-02-02T00:00:00.000Z",
      status: 2,
    },
    {
      id: "spec-gone",
      kind: "spec",
      title: "Deleted spec",
      deletedAt: "2026-02-03T00:00:00.000Z",
      status: 0,
    },
  ],
};

// ─── Head A: the `@1` root Y.Doc ──────────────────────────────────────────

function seedLegacyDoc(content: EpicContent): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const epic = getEpicMap(doc);
    epic.set("title", content.title);
    epic.set("updatedAt", content.updatedAt);
    const artifacts = ensureMap(epic, "artifacts");
    for (const artifact of content.artifacts) {
      const entry = new Y.Map<unknown>();
      entry.set("id", artifact.id);
      entry.set("kind", artifact.kind);
      entry.set("title", artifact.title);
      entry.set("folderName", artifact.folderName);
      entry.set("parentId", artifact.parentId);
      entry.set("createdAt", artifact.createdAt);
      entry.set("updatedAt", artifact.updatedAt);
      entry.set("createdManually", artifact.createdManually);
      entry.set("artifactRoomId", artifact.artifactRoomId);
      if (artifact.kind === "ticket") entry.set("status", artifact.status);
      artifacts.set(artifact.id, entry);
    }
    const deleted = ensureMap(epic, "deletedArtifacts");
    for (const tombstone of content.deleted) {
      const entry = new Y.Map<unknown>();
      entry.set("id", tombstone.id);
      entry.set("kind", tombstone.kind);
      entry.set("title", tombstone.title);
      entry.set("deletedAt", tombstone.deletedAt);
      if (tombstone.kind === "ticket") entry.set("status", tombstone.status);
      deleted.set(tombstone.id, entry);
    }
  });
  return doc;
}

// ─── Head B: `epic.state.subscribe@1.0` rows ──────────────────────────────

/**
 * The same content as a real snapshot frame, parsed by the real schema.
 *
 * Built as ONE frame rather than row by row so the wire's own completeness
 * rules apply: a snapshot that forgot the claim set or the metadata would fail
 * construction here rather than produce a half-populated head that happened to
 * compare equal on the fields the fixture bothered to set.
 */
function snapshotFrame(
  content: EpicContent,
): Extract<EpicStateSubscribeServerFrameV10, { kind: "snapshot" }> {
  const parsed: EpicStateSubscribeServerFrameV10 =
    epicStateSubscribeServerFrameSchemaV10.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch: EPOCH,
      basis: "cold",
      position: 1,
      reconciledWithCloud: true,
      artifactRecords: content.artifacts.map((artifact, index) =>
        artifact.kind === "ticket"
          ? {
              kind: "ticket",
              id: artifact.id,
              folderName: artifact.folderName,
              title: artifact.title,
              createdAt: artifact.createdAt,
              updatedAt: artifact.updatedAt,
              createdManually: artifact.createdManually,
              parentId: artifact.parentId,
              assignee: artifact.assignee,
              status: artifact.status,
              revision: index + 1,
            }
          : {
              kind: "spec",
              id: artifact.id,
              folderName: artifact.folderName,
              title: artifact.title,
              createdAt: artifact.createdAt,
              updatedAt: artifact.updatedAt,
              createdManually: artifact.createdManually,
              parentId: artifact.parentId,
              revision: index + 1,
            },
      ),
      deletedArtifacts: content.deleted.map((tombstone, index) =>
        tombstone.kind === "ticket"
          ? {
              kind: "ticket",
              id: tombstone.id,
              title: tombstone.title,
              deletedAt: tombstone.deletedAt,
              status: tombstone.status,
              revision: index + 1,
            }
          : {
              kind: "spec",
              id: tombstone.id,
              title: tombstone.title,
              deletedAt: tombstone.deletedAt,
              revision: index + 1,
            },
      ),
      commentThreads: [],
      roleClaims: { revision: 1, claims: [] },
      epicMeta: {
        revision: 1,
        meta: { title: content.title, updatedAt: content.updatedAt },
      },
    });
  if (parsed.kind !== "snapshot") throw new Error("expected a snapshot frame");
  return parsed;
}

/** The same frame, decoded to rows by hand - the HEAD path's input. */
function laneSnapshotRows(
  content: EpicContent,
): readonly RecordRow<EpicStateRow>[] {
  const parsed = snapshotFrame(content);
  const rows: RecordRow<EpicStateRow>[] = [];
  for (const record of parsed.artifactRecords) {
    rows.push({
      rowId: artifactRowId(record.id),
      revision: record.revision,
      row: { kind: "artifact", record },
    });
  }
  for (const record of parsed.deletedArtifacts) {
    rows.push({
      rowId: artifactTombstoneRowId(record.id),
      revision: record.revision,
      row: { kind: "artifact-tombstone", record },
    });
  }
  rows.push({
    rowId: ROLE_CLAIMS_ROW_ID,
    revision: parsed.roleClaims.revision,
    row: { kind: "role-claims", claims: parsed.roleClaims.claims },
  });
  rows.push({
    rowId: EPIC_META_ROW_ID,
    revision: parsed.epicMeta.revision,
    row: { kind: "epic-meta", meta: parsed.epicMeta.meta },
  });
  return rows;
}

// ─── The comparison ───────────────────────────────────────────────────────

/**
 * The composition inputs, identical for both heads.
 *
 * `RECORD_PLANE_COVERS_BOTH` is the post-cutover configuration and the only one
 * in which the comparison means anything: with the doc arms live, head A would
 * carry chats and terminal agents head B structurally cannot have, and the
 * difference would be the configuration rather than the decode.
 */
const INPUTS: ProjectionInputs = {
  chatRecords: EMPTY_CHATS_SLICE,
  tuiAgentRecords: EMPTY_TERMINAL_AGENTS_SLICE,
  pendingOverlay: EMPTY_PENDING_OVERLAY,
  reportDeadMutations: null,
  docArm: RECORD_PLANE_COVERS_BOTH,
};

/** The one field the lane cannot carry, zeroed so the rest can be compared. */
function withoutRoomIds(artifacts: ArtifactsSlice): ArtifactsSlice {
  const byId = Object.fromEntries(
    artifacts.allIds.map((id) => [
      id,
      { ...artifacts.byId[id], artifactRoomId: null },
    ]),
  );
  return { byId, allIds: artifacts.allIds };
}

function normalized(projection: EpicProjectedSlices): EpicProjectedSlices {
  return { ...projection, artifacts: withoutRoomIds(projection.artifacts) };
}

function legacyProjection(): EpicProjectedSlices {
  const doc = seedLegacyDoc(CONTENT);
  return composeEpicProjection(
    readEpicRawProjectionSources(doc, VIEWER),
    VIEWER,
    INPUTS,
  );
}

function laneProjection(): EpicProjectedSlices {
  const replica = createEpicLaneStateReplica({
    getCurrentUserId: () => VIEWER,
    isDisposed: () => false,
    onChanged: () => {},
  });
  replica.apply({
    kind: "record-snapshot",
    watermark: { authorityEpoch: EPOCH, lane: EPIC_STATE_LANE_ID, position: 1 },
    rows: laneSnapshotRows(CONTENT),
    trust: "reconciled-with-cloud",
    cause: "initial",
  });
  return composeEpicProjection(
    laneRawProjectionSources(replica.slices()),
    VIEWER,
    INPUTS,
  );
}

// ─── The contract half: through the REAL adapter ──────────────────────────

/**
 * Drive the same content through the REAL `epic.state.subscribe@1.0` adapter.
 *
 * The head test above hands `RecordRow`s straight to the replica, which is what
 * makes it a diagnostic - it isolates the replica and the composition. This one
 * adds the piece that test deliberately skips: the adapter's own decode, which
 * is where the snapshot's four populations become rows, where the role-claim and
 * metadata singletons are synthesised onto every snapshot, and where a
 * tombstone's two key spaces are minted. A defect in any of those is invisible
 * to the head test and visible here.
 *
 * The stream client is a fake, and only the stream client: the adapter, the
 * replica, the composition and the frame schema are all real, and the frame is
 * the one `laneSnapshotRows` already parsed - so both halves of this file are
 * driven from one description of one epic.
 */
function laneProjectionThroughAdapter(): EpicProjectedSlices {
  const replica = createEpicLaneStateReplica({
    getCurrentUserId: () => VIEWER,
    isDisposed: () => false,
    onChanged: () => {},
  });
  const captured: { callbacks: EpicStateStreamCallbacks | null } = {
    callbacks: null,
  };
  const adapter = createEpicStateLaneAdapter({
    epicId: "epic-1",
    streamClientFactory: (_epicId, callbacks) => {
      captured.callbacks = callbacks;
      return { close: () => {} };
    },
    readAppliedCursor: () => replica.appliedCursor(),
    isDisposed: () => false,
  });
  adapter.attach({
    environment: TEST_ENVIRONMENT,
    emit: (event) => {
      replica.apply(event);
    },
    reportResume: () => {},
    reportStatus: () => {},
    requestReplacement: () => {},
  });
  const callbacks = captured.callbacks;
  if (callbacks === null) throw new Error("adapter never opened a client");
  callbacks.onSnapshot(snapshotFrame(CONTENT));
  return composeEpicProjection(
    laneRawProjectionSources(replica.slices()),
    VIEWER,
    INPUTS,
  );
}

describe("the exit line, end to end: identical content through BOTH adapters", () => {
  it("the real lane adapter's decode projects identically to the @1 doc head", () => {
    // The ticket's exit criterion, at the level it is written for. Whole
    // values, one normalised field, same fixture as the head test.
    expect(normalized(laneProjectionThroughAdapter())).toEqual(
      normalized(legacyProjection()),
    );
  });

  it("agrees with the head-level path, so a failure localises to the adapter", () => {
    // If this ever fails while the head test passes, the defect is in the
    // adapter's decode and nowhere else - which is the whole reason both exist.
    expect(laneProjectionThroughAdapter()).toEqual(laneProjection());
  });

  it("the adapter really ran - the replica holds the watermark the frame carried", () => {
    // Anti-vacuity: without this, a factory that never invoked `onSnapshot`
    // would leave both sides empty and the equality above would pass on two
    // empty projections.
    const projection = laneProjectionThroughAdapter();
    expect(projection.artifacts.allIds.slice().sort()).toEqual([
      "spec-orphan",
      "spec-root",
      "ticket-child",
    ]);
    expect(projection.deletedArtifacts.allIds.slice().sort()).toEqual([
      "spec-gone",
      "ticket-gone",
    ]);
  });
});

describe("lane and legacy heads are indistinguishable to the projection layer", () => {
  it("produces byte-identical WHOLE projections on identical epic content", () => {
    const legacy = legacyProjection();
    const lane = laneProjection();

    // The whole value, not a field-by-field walk: a comparison that enumerated
    // fields would pass over a slice someone adds later, which is the failure
    // mode a projection-level exit criterion exists to catch.
    expect(normalized(lane)).toEqual(normalized(legacy));
  });

  it("the room-id normalisation is not vacuous - the legacy head really carries them", () => {
    const legacy = legacyProjection();
    const roomIds = legacy.artifacts.allIds.map(
      (id) => legacy.artifacts.byId[id].artifactRoomId,
    );
    // If this ever went all-null, the equality above would still pass while
    // proving nothing about the field it deliberately excludes.
    expect(roomIds).toEqual(["room-1", "room-2", "room-3"]);
    expect(
      laneProjection().artifacts.allIds.every(
        (id) => laneProjection().artifacts.byId[id].artifactRoomId === null,
      ),
    ).toBe(true);
  });

  it("agrees on the derived tree, including the orphan promotion neither head computes", () => {
    const legacy = legacyProjection();
    const lane = laneProjection();
    // Built in the SHARED tail from the artifacts each head produced, so
    // agreement here is a statement about the decode, not about the tree code.
    expect(lane.tree).toEqual(legacy.tree);
    // The orphan is promoted to a root rather than dropped, on both.
    expect(lane.tree.rootIds.slice().sort()).toEqual([
      "spec-orphan",
      "spec-root",
    ]);
    expect(lane.tree.childrenByParent["spec-root"]).toEqual(["ticket-child"]);
  });

  it("agrees on tombstones, including the status only two kinds carry", () => {
    const legacy = legacyProjection();
    const lane = laneProjection();
    expect(lane.deletedArtifacts).toEqual(legacy.deletedArtifacts);
    expect(lane.deletedArtifacts.byId["ticket-gone"].status).toBe(2);
    // A spec has no status on either head - a lane decode that defaulted it to
    // 0 would compare unequal here rather than silently render a Todo chip.
    expect(lane.deletedArtifacts.byId["spec-gone"].status).toBeNull();
  });

  it("catches a divergence rather than absorbing it", () => {
    // The guard on the guard: perturb ONE field on one head and the whole-value
    // comparison must fail. Without this, a normalisation that quietly widened
    // would leave the suite green over a real difference.
    const legacy = legacyProjection();
    const lane = laneProjection();
    const perturbed: EpicProjectedSlices = {
      ...lane,
      epic: { ...lane.epic, title: `${lane.epic.title} (drifted)` },
    };
    expect(normalized(perturbed)).not.toEqual(normalized(legacy));
  });
});
