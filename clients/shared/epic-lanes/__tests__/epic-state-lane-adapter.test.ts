import { describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import type {
  AdapterHost,
  AdapterStatus,
  LaneCursor,
  ResumeOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type {
  EpicStateDeltaFrame,
  EpicStateResumedFrame,
  EpicStateSnapshotFrame,
  EpicStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import {
  ARTIFACT_TOMBSTONE_REMOVE_REASON,
  artifactRowId,
  artifactTombstoneRowId,
  commentThreadRowId,
  EPIC_META_ROW_ID,
  ROLE_CLAIMS_ROW_ID,
} from "../epic-state-rows";
import { EPIC_STATE_LANE_ID, type EpicStateLaneEvent } from "../lane-events";
import {
  createEpicStateLaneAdapter,
  type EpicStateLaneAdapterSources,
  type EpicStateLaneStreamClient,
  type EpicStateStreamClientFactory,
} from "../epic-state-lane-adapter";

/**
 * `epic.state.subscribe@1.0` adapter - records-lane decode, lane strip/stamp,
 * resume/replacement signalling, and generation-guard dropping.
 *
 * Every server frame fed to the adapter is built by parsing a plain object
 * through the REAL wire schema and narrowing on `kind` - never hand-typed -
 * so a fixture that drifts from the contract fails at construction rather
 * than passing silently. See the module's own note on two independently
 * green halves of a wire contract both being wrong together.
 */

// ─── Frame builders (parsed through the real schema) ───────────────────────

function snapshotFrame(
  overrides: Partial<{
    authorityEpoch: string;
    position: number;
    basis: "cold" | "authorityEpochChanged" | "resumeTooOld";
    reconciledWithCloud: boolean;
  }>,
): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    authorityEpoch: overrides.authorityEpoch ?? "epoch-1",
    position: overrides.position ?? 0,
    basis: overrides.basis ?? "cold",
    reconciledWithCloud: overrides.reconciledWithCloud ?? false,
    epicMeta: { revision: 0, meta: { title: "Epic Title", updatedAt: 1000 } },
    artifactRecords: [],
    deletedArtifacts: [],
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "snapshot") throw new Error("fixture drift: snapshot");
  return parsed;
}

/**
 * `reconciledWithCloud` is REQUIRED on `resumed`, and that is the one field a
 * resuming client cannot carry over from its previous session: rows are row
 * state and survive the gap by definition, but trust describes the SERVING
 * HOST'S replica, which may have restarted seed-only since the cursor was
 * persisted. Defaulted here rather than made a parameter on every call site,
 * with the one test that cares passing it explicitly.
 */
function resumedFrame(
  authorityEpoch: string,
  position: number,
  reconciledWithCloud: boolean,
): EpicStateResumedFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "resumed",
    authorityEpoch,
    position,
    reconciledWithCloud,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "resumed") throw new Error("fixture drift: resumed");
  return parsed;
}

interface ArtifactRecordFixtureOverrides {
  readonly id?: string;
  readonly revision?: number;
  readonly parentId?: string | null;
}

// Named rather than inferred, because the overrides interfaces below have to
// reference these shapes and `ReturnType<typeof fn>` is banned by this repo's
// type-safety rules - in tests as well as in production.
interface ArtifactRecordFixture {
  readonly kind: "spec";
  readonly id: string;
  readonly folderName: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdManually: boolean;
  readonly parentId: string | null;
  readonly revision: number;
}

interface DeletedArtifactRecordFixture {
  readonly kind: "spec";
  readonly id: string;
  readonly title: string;
  readonly deletedAt: string;
  readonly revision: number;
}

interface CommentThreadRecordFixture {
  readonly threadId: string;
  readonly resolved: boolean;
  readonly createdAt: number;
  readonly comments: readonly unknown[];
  readonly data: { readonly createdByUserId: string };
  readonly artifactId: string;
  readonly revision: number;
}

function artifactRecordFixture(
  overrides: ArtifactRecordFixtureOverrides,
): ArtifactRecordFixture {
  return {
    kind: "spec" as const,
    id: overrides.id ?? "artifact-1",
    folderName: "artifact-1",
    title: "An Artifact",
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: true,
    parentId: overrides.parentId ?? null,
    revision: overrides.revision ?? 1,
  };
}

// `artifactRoomId` is deliberately absent: `epicDeletedArtifactRecordSchema`
// `.omit()`s it, so a fixture that included it would be stripped on `.parse()`
// and no longer match what the adapter actually receives.
function deletedArtifactRecordFixture(
  id: string,
  revision: number,
): DeletedArtifactRecordFixture {
  return {
    kind: "spec" as const,
    id,
    title: "A Deleted Artifact",
    deletedAt: "2026-08-29T00:00:00.000Z",
    revision,
  };
}

function commentThreadRecordFixture(
  artifactId: string,
  threadId: string,
  revision: number,
): CommentThreadRecordFixture {
  return {
    threadId,
    resolved: false,
    createdAt: 1000,
    comments: [],
    data: { createdByUserId: "user-1" },
    artifactId,
    revision,
  };
}

interface DeltaFrameOverrides {
  readonly authorityEpoch?: string;
  readonly seq?: number;
  readonly artifactUpserts?: readonly ArtifactRecordFixture[];
  readonly artifactTombstones?: readonly DeletedArtifactRecordFixture[];
  readonly commentThreadUpserts?: readonly CommentThreadRecordFixture[];
  readonly commentThreadRemovals?: readonly {
    artifactId: string;
    threadId: string;
    revision: number;
  }[];
  readonly epicMeta?: {
    revision: number;
    meta: Partial<{ title: string; updatedAt: number }>;
  } | null;
  readonly roleClaims?: { revision: number; claims: unknown[] } | null;
}

function deltaFrame(overrides: DeltaFrameOverrides): EpicStateDeltaFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
    kind: "delta",
    authorityEpoch: overrides.authorityEpoch ?? "epoch-1",
    seq: overrides.seq ?? 1,
    artifactUpserts: overrides.artifactUpserts ?? [],
    artifactTombstones: overrides.artifactTombstones ?? [],
    commentThreadUpserts: overrides.commentThreadUpserts ?? [],
    commentThreadRemovals: overrides.commentThreadRemovals ?? [],
    epicMeta: overrides.epicMeta === undefined ? null : overrides.epicMeta,
    roleClaims:
      overrides.roleClaims === undefined ? null : overrides.roleClaims,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "delta") throw new Error("fixture drift: delta");
  return parsed;
}

// ─── Fakes ──────────────────────────────────────────────────────────────

interface FakeStreamClient extends EpicStateLaneStreamClient {
  readonly closeCalls: number;
}

interface FakeHandle {
  readonly callbacks: EpicStateStreamCallbacks;
  readonly resumeProvider: () => EpicLaneCursor | null;
  readonly client: FakeStreamClient;
}

function createFakeStreamClientFactory(): {
  readonly factory: EpicStateStreamClientFactory;
  readonly handles: () => readonly FakeHandle[];
  readonly latest: () => FakeHandle;
} {
  const handles: FakeHandle[] = [];
  const factory: EpicStateStreamClientFactory = (
    _epicId,
    callbacks,
    resumeProvider,
  ) => {
    let closeCalls = 0;
    const client: FakeStreamClient = {
      get closeCalls() {
        return closeCalls;
      },
      close: () => {
        closeCalls += 1;
      },
    };
    handles.push({ callbacks, resumeProvider, client });
    return client;
  };
  return {
    factory,
    handles: () => handles,
    latest: () => {
      const handle = handles.at(-1);
      if (handle === undefined) throw new Error("factory not invoked");
      return handle;
    },
  };
}

function createFakeRuntimeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule: () => ({ cancel: () => {} }),
      scheduleMicrotask: () => {},
    },
    logger: {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

/**
 * Every channel a host receives - `emit`, `reportResume`, `reportStatus`,
 * `requestReplacement` - appended into ONE ordered log, because order between
 * those channels is load-bearing (e.g. `reportResume` before the snapshot's
 * rows).
 */
type LogEntry =
  | { readonly channel: "emit"; readonly event: EpicStateLaneEvent }
  | { readonly channel: "reportResume"; readonly outcome: ResumeOutcome }
  | { readonly channel: "reportStatus"; readonly status: AdapterStatus }
  | {
      readonly channel: "requestReplacement";
      readonly reason: string;
    };

function createRecordingHost(): {
  readonly host: AdapterHost<EpicStateLaneEvent>;
  readonly log: readonly LogEntry[];
} {
  const log: LogEntry[] = [];
  const host: AdapterHost<EpicStateLaneEvent> = {
    environment: createFakeRuntimeEnvironment(),
    emit: (event) => log.push({ channel: "emit", event }),
    reportResume: (outcome) => log.push({ channel: "reportResume", outcome }),
    reportStatus: (status) => log.push({ channel: "reportStatus", status }),
    requestReplacement: (reason) =>
      log.push({ channel: "requestReplacement", reason }),
  };
  return { host, log };
}

function emittedEvents(log: readonly LogEntry[]): EpicStateLaneEvent[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "emit" }> =>
        entry.channel === "emit",
    )
    .map((entry) => entry.event);
}

function replacementReasons(log: readonly LogEntry[]): string[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "requestReplacement" }> =>
        entry.channel === "requestReplacement",
    )
    .map((entry) => entry.reason);
}

function createSources(
  streamClientFactory: EpicStateStreamClientFactory,
  readAppliedCursor: (() => LaneCursor | null) | undefined,
  isDisposed: (() => boolean) | undefined,
): EpicStateLaneAdapterSources {
  return {
    epicId: "epic-1",
    streamClientFactory,
    readAppliedCursor: readAppliedCursor ?? (() => null),
    isDisposed: isDisposed ?? (() => false),
  };
}

// ─── resumeOffer() and wire resume strip/stamp ─────────────────────────────

describe("createEpicStateLaneAdapter - resume offer", () => {
  it("cold open: resumeOffer() is null and the wire resumeProvider answers null (not undefined)", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    expect(adapter.resumeOffer()).toBeNull();
    const wireResume = latest().resumeProvider();
    expect(wireResume).toBeNull();
    expect(wireResume === undefined).toBe(false);
  });

  it("strips lane on the wire resume and stamps it back on every emitted cursor", () => {
    const applied: LaneCursor = {
      authorityEpoch: "e1",
      lane: EPIC_STATE_LANE_ID,
      position: 7,
    };
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, () => applied, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const offer = adapter.resumeOffer();
    expect(offer).toEqual({ kind: "cursor", cursor: applied });

    const wireResume = latest().resumeProvider();
    expect(wireResume).toEqual({ authorityEpoch: "e1", position: 7 });
    expect(Object.keys(wireResume ?? {})).not.toContain("lane");

    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "e1", position: 9, basis: "cold" }),
    );
    latest().callbacks.onDelta(
      deltaFrame({
        authorityEpoch: "e1",
        seq: 10,
        epicMeta: { revision: 1, meta: { title: "Renamed" } },
      }),
    );
    latest().callbacks.onResumed(resumedFrame("e1", 11, true));

    const resumeOutcomes = log
      .filter(
        (entry): entry is Extract<LogEntry, { channel: "reportResume" }> =>
          entry.channel === "reportResume",
      )
      .map((entry) => entry.outcome);
    // Watermark on the snapshot's reseed outcome.
    expect(resumeOutcomes[0]).toEqual({
      kind: "reseeded",
      reason: "no-offer",
      watermark: {
        authorityEpoch: "e1",
        lane: EPIC_STATE_LANE_ID,
        position: 9,
      },
    });
    // `resumed`'s `from` cursor.
    expect(resumeOutcomes[1]).toEqual({
      kind: "resumed",
      from: { authorityEpoch: "e1", lane: EPIC_STATE_LANE_ID, position: 11 },
    });
    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshotEvent === undefined ||
      snapshotEvent.kind !== "record-snapshot"
    ) {
      throw new Error("expected a record-snapshot event");
    }
    expect(snapshotEvent.watermark).toEqual({
      authorityEpoch: "e1",
      lane: EPIC_STATE_LANE_ID,
      position: 9,
    });
    const deltaEvent = emittedEvents(log).find(
      (event) => event.kind === "record-transaction",
    );
    expect(deltaEvent?.cursor).toEqual({
      authorityEpoch: "e1",
      lane: EPIC_STATE_LANE_ID,
      position: 10,
    });
  });

  it("a cursor for a foreign lane fails closed: resumeOffer() and the wire resume are both null", () => {
    const foreignCursor: LaneCursor = {
      authorityEpoch: "e1",
      lane: "epic.status.subscribe@1",
      position: 3,
    };
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, () => foreignCursor, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    expect(adapter.resumeOffer()).toBeNull();
    expect(latest().resumeProvider()).toBeNull();
  });
});

// ─── Snapshot basis -> reportResume + requestReplacement ───────────────────

describe("createEpicStateLaneAdapter - snapshot basis", () => {
  it("basis 'cold' -> reseeded/no-offer, and requestReplacement is never called", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));

    expect(log[0]).toEqual({
      channel: "reportResume",
      outcome: {
        kind: "reseeded",
        reason: "no-offer",
        watermark: {
          authorityEpoch: "epoch-1",
          lane: EPIC_STATE_LANE_ID,
          position: 0,
        },
      },
    });
    expect(replacementReasons(log)).toEqual([]);
  });

  it("basis 'resumeTooOld' -> requestReplacement('resume-too-old') exactly once", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ basis: "resumeTooOld" }));

    expect(replacementReasons(log)).toEqual(["resume-too-old"]);
  });

  it("basis 'authorityEpochChanged' -> requestReplacement('authority-epoch-changed') exactly once", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ basis: "authorityEpochChanged" }),
    );

    expect(replacementReasons(log)).toEqual(["authority-epoch-changed"]);
  });
});

// ─── resumed frame ──────────────────────────────────────────────────────────

describe("createEpicStateLaneAdapter - resumed frame", () => {
  it("reports resumed/from, emits only the restated trust, and never requests replacement", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onResumed(resumedFrame("epoch-1", 5, true));

    // Trust follows the acknowledgement and NOTHING else does: no rows travel
    // on a resume, because the client keeping what it holds is the point. See
    // `resumedFrame` for why trust is the one exception.
    expect(log).toEqual([
      {
        channel: "reportResume",
        outcome: {
          kind: "resumed",
          from: {
            authorityEpoch: "epoch-1",
            lane: EPIC_STATE_LANE_ID,
            position: 5,
          },
        },
      },
      {
        channel: "emit",
        event: {
          kind: "record-trust",
          authorityEpoch: "epoch-1",
          trust: "reconciled-with-cloud",
        },
      },
    ]);
    expect(
      emittedEvents(log).filter((event) => event.kind !== "record-trust"),
    ).toEqual([]);
    expect(replacementReasons(log)).toEqual([]);
  });
});

// ─── Snapshot row decode ────────────────────────────────────────────────────

describe("createEpicStateLaneAdapter - snapshot row decode", () => {
  it("decodes artifacts, tombstones, comment threads and role claims into the right row keys", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const frame = snapshotFrame({ basis: "cold" });
    const withRows = epicStateSubscribeServerFrameSchemaV10.parse({
      ...frame,
      artifactRecords: [artifactRecordFixture({ id: "a1", revision: 3 })],
      deletedArtifacts: [deletedArtifactRecordFixture("a2", 4)],
      commentThreads: [commentThreadRecordFixture("a1", "t1", 2)],
      roleClaims: { revision: 1, claims: [] },
    });
    if (withRows.kind !== "snapshot") throw new Error("fixture drift");
    latest().callbacks.onSnapshot(withRows);

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshotEvent === undefined ||
      snapshotEvent.kind !== "record-snapshot"
    ) {
      throw new Error("expected a record-snapshot event");
    }
    const rowIds = snapshotEvent.rows.map((row) => row.rowId);
    expect(rowIds).toContain(artifactRowId("a1"));
    expect(rowIds).toContain(artifactTombstoneRowId("a2"));
    expect(rowIds).toContain(commentThreadRowId("a1", "t1"));
    expect(rowIds).toContain(ROLE_CLAIMS_ROW_ID);
  });

  it("carries the role-claims row even when claims is empty", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshotEvent === undefined ||
      snapshotEvent.kind !== "record-snapshot"
    ) {
      throw new Error("expected a record-snapshot event");
    }
    const roleClaimsRow = snapshotEvent.rows.find(
      (row) => row.rowId === ROLE_CLAIMS_ROW_ID,
    );
    expect(roleClaimsRow).toBeDefined();
    if (roleClaimsRow?.row.kind !== "role-claims") {
      throw new Error("expected a role-claims row");
    }
    expect(roleClaimsRow.row.claims).toEqual([]);
  });
});

// ─── Trust ──────────────────────────────────────────────────────────────────

describe("createEpicStateLaneAdapter - trust", () => {
  it("reconciledWithCloud true -> 'reconciled-with-cloud'; false -> 'seed-only'", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ reconciledWithCloud: true }));
    const first = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (first === undefined || first.kind !== "record-snapshot") {
      throw new Error("expected a record-snapshot event");
    }
    expect(first.trust).toBe("reconciled-with-cloud");

    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-2", reconciledWithCloud: false }),
    );
    const events = emittedEvents(log).filter(
      (event) => event.kind === "record-snapshot",
    );
    const second = events[1];
    if (second === undefined || second.kind !== "record-snapshot") {
      throw new Error("expected a second record-snapshot event");
    }
    expect(second.trust).toBe("seed-only");
  });
});

// ─── cause: initial vs reseed ───────────────────────────────────────────────

describe("createEpicStateLaneAdapter - cause", () => {
  it("first lead frame on an attachment is 'initial'; a later snapshot is 'reseed'; detach() resets it", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));
    latest().callbacks.onSnapshot(
      snapshotFrame({
        authorityEpoch: "epoch-2",
        basis: "authorityEpochChanged",
      }),
    );

    const snapshots = emittedEvents(log).filter(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshots[0]?.kind !== "record-snapshot" ||
      snapshots[1]?.kind !== "record-snapshot"
    ) {
      throw new Error("expected two record-snapshot events");
    }
    expect(snapshots[0].cause).toBe("initial");
    expect(snapshots[1].cause).toBe("reseed");

    adapter.detach("disposed");
    adapter.attach(host);
    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));

    const afterDetach = emittedEvents(log).filter(
      (event) => event.kind === "record-snapshot",
    );
    const third = afterDetach[2];
    if (third === undefined || third.kind !== "record-snapshot") {
      throw new Error("expected a third record-snapshot event");
    }
    expect(third.cause).toBe("initial");
  });

  it("resumed also counts as the lead frame for cause tracking (a later snapshot is 'reseed')", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onResumed(resumedFrame("epoch-1", 1, true));
    latest().callbacks.onSnapshot(
      snapshotFrame({
        authorityEpoch: "epoch-2",
        basis: "authorityEpochChanged",
      }),
    );

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshotEvent === undefined ||
      snapshotEvent.kind !== "record-snapshot"
    ) {
      throw new Error("expected a record-snapshot event");
    }
    expect(snapshotEvent.cause).toBe("reseed");
  });
});

// ─── Delta decode ───────────────────────────────────────────────────────────

describe("createEpicStateLaneAdapter - delta decode", () => {
  it("tombstones a live artifact and upserts its tombstone atomically, in one changes array at one revision", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDelta(
      deltaFrame({
        artifactTombstones: [deletedArtifactRecordFixture("a1", 5)],
      }),
    );

    const transactions = emittedEvents(log).filter(
      (event) => event.kind === "record-transaction",
    );
    expect(transactions).toHaveLength(1);
    const [transaction] = transactions;
    if (
      transaction === undefined ||
      transaction.kind !== "record-transaction"
    ) {
      throw new Error("expected exactly one record-transaction event");
    }
    expect(transaction.changes).toEqual([
      {
        kind: "remove",
        rowId: artifactRowId("a1"),
        revision: 5,
        reason: ARTIFACT_TOMBSTONE_REMOVE_REASON,
      },
      {
        kind: "upsert",
        row: {
          rowId: artifactTombstoneRowId("a1"),
          revision: 5,
          row: {
            kind: "artifact-tombstone",
            record: deletedArtifactRecordFixture("a1", 5),
          },
        },
      },
    ]);
  });

  it("an epicMeta-only delta emits exactly one record-transaction whose changes is one upsert at EPIC_META_ROW_ID carrying epic-meta-patch", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onDelta(
      deltaFrame({
        authorityEpoch: "epoch-1",
        seq: 3,
        epicMeta: { revision: 7, meta: { title: "New Title" } },
      }),
    );

    const events = emittedEvents(log);
    expect(events).toEqual([
      {
        kind: "record-transaction",
        cursor: {
          authorityEpoch: "epoch-1",
          lane: EPIC_STATE_LANE_ID,
          position: 3,
        },
        changes: [
          {
            kind: "upsert",
            row: {
              rowId: EPIC_META_ROW_ID,
              revision: 7,
              row: { kind: "epic-meta-patch", meta: { title: "New Title" } },
            },
          },
        ],
        barrier: null,
      },
    ]);
    // No separate meta event exists anywhere in the log - the patch travels
    // as a row inside the transaction, not as a standalone arm.
    expect(
      events.filter((event) => event.kind !== "record-transaction"),
    ).toEqual([]);
  });

  it("the snapshot's meta row is whole ('epic-meta'); the delta's is a patch ('epic-meta-patch') - the distinction survives the adapter", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));
    latest().callbacks.onDelta(
      deltaFrame({
        authorityEpoch: "epoch-1",
        seq: 1,
        epicMeta: { revision: 1, meta: { title: "Patched" } },
      }),
    );

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshotEvent === undefined ||
      snapshotEvent.kind !== "record-snapshot"
    ) {
      throw new Error("expected a record-snapshot event");
    }
    const snapshotMetaRow = snapshotEvent.rows.find(
      (row) => row.rowId === EPIC_META_ROW_ID,
    );
    expect(snapshotMetaRow?.row.kind).toBe("epic-meta");

    const transaction = emittedEvents(log).find(
      (event) => event.kind === "record-transaction",
    );
    if (
      transaction === undefined ||
      transaction.kind !== "record-transaction"
    ) {
      throw new Error("expected a record-transaction event");
    }
    const deltaMetaChange = transaction.changes.find(
      (change) =>
        change.kind === "upsert" && change.row.rowId === EPIC_META_ROW_ID,
    );
    if (deltaMetaChange === undefined || deltaMetaChange.kind !== "upsert") {
      throw new Error("expected an upsert change at EPIC_META_ROW_ID");
    }
    expect(deltaMetaChange.row.row.kind).toBe("epic-meta-patch");
  });

  it("a snapshot's record-snapshot carries exactly one row at EPIC_META_ROW_ID whose revision and meta echo the frame verbatim", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const frame = epicStateSubscribeServerFrameSchemaV10.parse({
      ...snapshotFrame({ basis: "cold" }),
      epicMeta: {
        revision: 42,
        meta: { title: "Exact Title", updatedAt: 999 },
      },
    });
    if (frame.kind !== "snapshot") throw new Error("fixture drift");
    latest().callbacks.onSnapshot(frame);

    const snapshotEvent = emittedEvents(log).find(
      (event) => event.kind === "record-snapshot",
    );
    if (
      snapshotEvent === undefined ||
      snapshotEvent.kind !== "record-snapshot"
    ) {
      throw new Error("expected a record-snapshot event");
    }
    const metaRows = snapshotEvent.rows.filter(
      (row) => row.rowId === EPIC_META_ROW_ID,
    );
    expect(metaRows).toEqual([
      {
        rowId: EPIC_META_ROW_ID,
        revision: 42,
        row: {
          kind: "epic-meta",
          meta: { title: "Exact Title", updatedAt: 999 },
        },
      },
    ]);
  });
});

// ─── Generation guard ───────────────────────────────────────────────────────

describe("createEpicStateLaneAdapter - generation guard", () => {
  it("a frame from a generation retired by detach() is dropped", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const stale = latest().callbacks;
    adapter.detach("disposed");

    stale.onSnapshot(snapshotFrame({ basis: "cold" }));
    stale.onDelta(
      deltaFrame({ epicMeta: { revision: 1, meta: { title: "x" } } }),
    );
    stale.onResumed(resumedFrame("epoch-1", 1, true));
    stale.onConnectionStatus("closed", { kind: "caller" });

    expect(log).toEqual([]);
  });

  it("a frame from a generation retired by closeTransport() is dropped", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const stale = latest().callbacks;
    adapter.closeTransport();

    stale.onSnapshot(snapshotFrame({ basis: "cold" }));

    expect(log).toEqual([]);
  });

  it("openTransport() after closeTransport() opens a fresh generation that decodes normally", () => {
    const { factory, latest, handles } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    adapter.closeTransport();
    adapter.openTransport();

    expect(handles()).toHaveLength(2);
    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));

    expect(
      emittedEvents(log).some((event) => event.kind === "record-snapshot"),
    ).toBe(true);
  });

  it("isDisposed() returning true makes every callback inert", () => {
    let disposed = false;
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(
        factory,
        () => null,
        () => disposed,
      ),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    disposed = true;
    latest().callbacks.onSnapshot(snapshotFrame({ basis: "cold" }));

    expect(log).toEqual([]);
  });
});

/**
 * The seed-trust marker, and the frame that exists because nothing else could
 * carry it.
 *
 * A background reconcile commits no row, so a `delta` envelope has nothing to
 * carry (and refuses to be empty), and a re-`snapshot` would have to claim a
 * `basis` that is not true. Before `trustChanged` existed, a seed-served client
 * labelled its data stale for the life of the subscription - found end to end
 * by the capture/replay harness, with both halves green in isolation.
 */
describe("createEpicStateLaneAdapter - seed trust", () => {
  it("labels a snapshot from the wire's boolean, both ways", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(
        factory,
        () => null,
        () => false,
      ),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ basis: "cold", reconciledWithCloud: false }),
    );
    latest().callbacks.onSnapshot(
      snapshotFrame({ basis: "cold", reconciledWithCloud: true }),
    );

    const trusts = emittedEvents(log)
      .filter((event) => event.kind === "record-snapshot")
      .map((event) => (event.kind === "record-snapshot" ? event.trust : null));
    expect(trusts).toEqual(["seed-only", "reconciled-with-cloud"]);
  });

  it("emits a trust event when the marker flips, and no snapshot with it", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(
        factory,
        () => null,
        () => false,
      ),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ basis: "cold", reconciledWithCloud: false }),
    );
    const parsed = epicStateSubscribeServerFrameSchemaV10.parse({
      kind: "trustChanged",
      authorityEpoch: "epoch-1",
      reconciledWithCloud: true,
      hasBinaryPayload: false,
    });
    if (parsed.kind !== "trustChanged") {
      throw new Error("fixture drift: trustChanged");
    }
    latest().callbacks.onTrustChanged(parsed);

    const events = emittedEvents(log);
    const trustEvents = events.filter((event) => event.kind === "record-trust");
    expect(trustEvents).toEqual([
      {
        kind: "record-trust",
        authorityEpoch: "epoch-1",
        trust: "reconciled-with-cloud",
      },
    ]);
    // It cost nothing else: no reseed, no envelope, no lane position.
    expect(
      events.filter((event) => event.kind === "record-snapshot"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === "record-transaction"),
    ).toEqual([]);
    expect(replacementReasons(log)).toEqual([]);
  });

  it("restates trust on a resume, because a resuming client cannot carry it", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStateLaneAdapter(
      createSources(
        factory,
        () => null,
        () => false,
      ),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    // Rows are row state and survive the gap by definition. Trust describes the
    // SERVING HOST'S replica, which may have restarted seed-only since the
    // cursor was persisted - so a client that kept its old value would resume
    // believing it is reconciled against a host that is not.
    latest().callbacks.onResumed(resumedFrame("epoch-1", 7, false));

    const events = emittedEvents(log);
    expect(events).toEqual([
      {
        kind: "record-trust",
        authorityEpoch: "epoch-1",
        trust: "seed-only",
      },
    ]);
    // Still no rows, which is the whole point of a resume.
    expect(events.filter((event) => event.kind === "record-snapshot")).toEqual(
      [],
    );
    expect(replacementReasons(log)).toEqual([]);
  });
});
