import { describe, expect, it } from "vitest";
import { agentIdentityStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/agent-identity/state-subscribe";
import type {
  AdapterHost,
  AdapterStatus,
  LaneCursor,
  ResumeOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type {
  IdentityStateDeltaFrame,
  IdentityStateHostStateFrame,
  IdentityStateResumedFrame,
  IdentityStateSnapshotFrame,
  IdentityStateStreamCallbacks,
} from "@traycer-clients/shared/host-transport/identity-state-stream-client";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import {
  IDENTITY_RECORD_ROW_ID,
  IDENTITY_ROW_REMOVE_REASON,
  identityDocumentRowId,
  identityFileRowId,
} from "../identity-state-rows";
import {
  identityStateLaneId,
  type IdentityStateLaneEvent,
} from "../lane-events";
import {
  createIdentityStateLaneAdapter,
  type IdentityStateLaneAdapterSources,
  type IdentityStateLaneStreamClient,
  type IdentityStateStreamClientFactory,
} from "../identity-state-lane-adapter";

/**
 * `agentIdentity.state.subscribe@1.0` adapter - index-lane decode, lane
 * strip/stamp, resume/replacement signalling, the shard arm, and
 * generation-guard dropping.
 *
 * Every server frame fed to the adapter is built by parsing a plain object
 * through the REAL wire schema and narrowing on `kind` - never hand-typed - so a
 * fixture that drifts from the contract fails at construction rather than
 * passing silently.
 */

const IDENTITY_ID = "identity-1";
const LANE_ID = identityStateLaneId(IDENTITY_ID);
const SHA = "a".repeat(64);

// ─── Frame builders (parsed through the real schema) ───────────────────────

interface IdentityFixture {
  readonly title: string;
  readonly description: string | null;
  readonly evolution: {
    readonly intervalTurns: number;
    readonly reviewHarnessId: null;
    readonly reviewModel: string | null;
    readonly reviewReasoningEffort: string | null;
  };
}

// Named rather than inferred: `ReturnType<typeof fn>` is banned by this repo's
// type-safety rules, in tests as well as in production.
function identityFixture(title: string): IdentityFixture {
  return {
    title,
    description: null,
    evolution: {
      intervalTurns: 0,
      reviewHarnessId: null,
      reviewModel: null,
      reviewReasoningEffort: null,
    },
  };
}

/**
 * The incarnation the plain fixtures mint for a path: one life per path, which
 * is all a test that is not ABOUT incarnations needs. The incarnation tests
 * below name theirs explicitly.
 */
function incarnationOf(path: string): string {
  return `inc:${path}`;
}

interface DocumentRowFixture {
  readonly path: string;
  readonly incarnation: string;
  readonly shardRoomId: string;
  readonly fragmentName: string;
  readonly updatedAt: number;
  readonly provenance: "agent";
  readonly revision: number;
}

function documentRowFixture(
  path: string,
  revision: number,
): DocumentRowFixture {
  return documentRowAt(path, incarnationOf(path), revision);
}

function documentRowAt(
  path: string,
  incarnation: string,
  revision: number,
): DocumentRowFixture {
  return {
    path,
    incarnation,
    shardRoomId: "shard-a",
    fragmentName: "doc",
    updatedAt: 1000,
    provenance: "agent",
    revision,
  };
}

interface FileRowFixture {
  readonly path: string;
  readonly incarnation: string;
  readonly entry: {
    readonly v: number;
    readonly kind: string;
    readonly current: {
      readonly sha256: string;
      readonly byteLength: number;
      readonly mediaType: string;
      readonly createdAt: number;
      readonly createdBy: string;
      readonly producer: { readonly type: "agent"; readonly chatId: string };
    };
    readonly status: string;
  };
  readonly revision: number;
}

function fileRowFixture(path: string, revision: number): FileRowFixture {
  return fileRowAt(path, incarnationOf(path), revision);
}

function fileRowAt(
  path: string,
  incarnation: string,
  revision: number,
): FileRowFixture {
  return {
    path,
    incarnation,
    entry: {
      v: 1,
      kind: "blob",
      current: {
        sha256: SHA,
        byteLength: 12,
        mediaType: "application/octet-stream",
        createdAt: 1000,
        createdBy: "user-1",
        producer: { type: "agent", chatId: "chat-1" },
      },
      status: "available",
    },
    revision,
  };
}

interface SnapshotOverrides {
  readonly authorityEpoch?: string;
  readonly position?: number;
  readonly basis?: "cold" | "authorityEpochChanged" | "resumeTooOld";
  readonly reconciledWithCloud?: boolean;
  readonly identityRevision?: number;
  readonly documents?: readonly DocumentRowFixture[];
  readonly files?: readonly FileRowFixture[];
  readonly shards?: readonly {
    shardRoomId: string;
    state: "ready" | "retrying" | "unavailable";
  }[];
}

function snapshotFrame(
  overrides: SnapshotOverrides,
): IdentityStateSnapshotFrame {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    authorityEpoch: overrides.authorityEpoch ?? "epoch-1",
    position: overrides.position ?? 0,
    basis: overrides.basis ?? "cold",
    reconciledWithCloud: overrides.reconciledWithCloud ?? false,
    identity: {
      revision: overrides.identityRevision ?? 1,
      identity: identityFixture("An Identity"),
    },
    documents: overrides.documents ?? [],
    files: overrides.files ?? [],
    shards: overrides.shards ?? [],
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "snapshot") throw new Error("fixture drift: snapshot");
  return parsed;
}

function resumedFrame(
  authorityEpoch: string,
  position: number,
  reconciledWithCloud: boolean,
  shards: readonly {
    shardRoomId: string;
    state: "ready" | "retrying" | "unavailable";
  }[],
): IdentityStateResumedFrame {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "resumed",
    authorityEpoch,
    position,
    reconciledWithCloud,
    shards,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "resumed") throw new Error("fixture drift: resumed");
  return parsed;
}

interface DeltaOverrides {
  readonly authorityEpoch?: string;
  readonly seq?: number;
  readonly documentUpserts?: readonly DocumentRowFixture[];
  readonly fileUpserts?: readonly FileRowFixture[];
  readonly removals?: readonly {
    population: "document" | "file";
    path: string;
    incarnation: string;
    revision: number;
  }[];
  readonly identity?: {
    revision: number;
    identity: { title?: string; description?: string | null };
  } | null;
}

function deltaFrame(overrides: DeltaOverrides): IdentityStateDeltaFrame {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "delta",
    authorityEpoch: overrides.authorityEpoch ?? "epoch-1",
    seq: overrides.seq ?? 1,
    documentUpserts: overrides.documentUpserts ?? [],
    fileUpserts: overrides.fileUpserts ?? [],
    removals: overrides.removals ?? [],
    identity: overrides.identity === undefined ? null : overrides.identity,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "delta") throw new Error("fixture drift: delta");
  return parsed;
}

function hostStateFrame(
  authorityEpoch: string,
  reconciledWithCloud: boolean,
  shards: readonly {
    shardRoomId: string;
    state: "ready" | "retrying" | "unavailable";
  }[],
): IdentityStateHostStateFrame {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "hostStateChanged",
    authorityEpoch,
    reconciledWithCloud,
    shards,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "hostStateChanged") {
    throw new Error("fixture drift: hostStateChanged");
  }
  return parsed;
}

// ─── Fakes ──────────────────────────────────────────────────────────────

interface FakeStreamClient extends IdentityStateLaneStreamClient {
  readonly closeCalls: number;
}

interface FakeHandle {
  readonly identityId: string;
  readonly callbacks: IdentityStateStreamCallbacks;
  readonly resumeProvider: () => EpicLaneCursor | null;
  readonly client: FakeStreamClient;
}

function createFakeStreamClientFactory(): {
  readonly factory: IdentityStateStreamClientFactory;
  readonly handles: () => readonly FakeHandle[];
  readonly latest: () => FakeHandle;
} {
  const handles: FakeHandle[] = [];
  const factory: IdentityStateStreamClientFactory = (
    identityId,
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
    handles.push({ identityId, callbacks, resumeProvider, client });
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
 * Every channel a host receives appended into ONE ordered log, because order
 * between those channels is load-bearing - `reportResume` before the snapshot's
 * rows, and the shard event AFTER them.
 */
type LogEntry =
  | { readonly channel: "emit"; readonly event: IdentityStateLaneEvent }
  | { readonly channel: "reportResume"; readonly outcome: ResumeOutcome }
  | { readonly channel: "reportStatus"; readonly status: AdapterStatus }
  | { readonly channel: "requestReplacement"; readonly reason: string };

function createRecordingHost(): {
  readonly host: AdapterHost<IdentityStateLaneEvent>;
  readonly log: readonly LogEntry[];
} {
  const log: LogEntry[] = [];
  const host: AdapterHost<IdentityStateLaneEvent> = {
    environment: createFakeRuntimeEnvironment(),
    emit: (event) => log.push({ channel: "emit", event }),
    reportResume: (outcome) => log.push({ channel: "reportResume", outcome }),
    reportStatus: (status) => log.push({ channel: "reportStatus", status }),
    requestReplacement: (reason) =>
      log.push({ channel: "requestReplacement", reason }),
  };
  return { host, log };
}

function emittedEvents(
  log: readonly LogEntry[],
): readonly IdentityStateLaneEvent[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "emit" }> =>
        entry.channel === "emit",
    )
    .map((entry) => entry.event);
}

function replacementReasons(log: readonly LogEntry[]): readonly string[] {
  return log
    .filter(
      (entry): entry is Extract<LogEntry, { channel: "requestReplacement" }> =>
        entry.channel === "requestReplacement",
    )
    .map((entry) => entry.reason);
}

function createSources(
  streamClientFactory: IdentityStateStreamClientFactory,
  readAppliedCursor: (() => LaneCursor | null) | undefined,
  isDisposed: (() => boolean) | undefined,
): IdentityStateLaneAdapterSources {
  return {
    identityId: IDENTITY_ID,
    streamClientFactory,
    readAppliedCursor: readAppliedCursor ?? (() => null),
    isDisposed: isDisposed ?? (() => false),
  };
}

// ─── resumeOffer() and wire resume strip/stamp ─────────────────────────────

describe("createIdentityStateLaneAdapter - resume offer", () => {
  it("cold open: resumeOffer() is null and the wire resumeProvider answers null (not undefined)", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    expect(adapter.resumeOffer()).toBeNull();
    const wireResume = latest().resumeProvider();
    expect(wireResume).toBeNull();
    // `resume` is REQUIRED AND NULLABLE on the open request, so "start from the
    // beginning" and "I forgot to send a cursor" stay different requests.
    expect(wireResume === undefined).toBe(false);
  });

  it("strips lane on the wire resume and stamps it back on every emitted cursor", () => {
    const applied: LaneCursor = {
      authorityEpoch: "e1",
      lane: LANE_ID,
      position: 7,
    };
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, () => applied, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    expect(adapter.resumeOffer()).toEqual({ kind: "cursor", cursor: applied });

    const wireResume = latest().resumeProvider();
    expect(wireResume).toEqual({ authorityEpoch: "e1", position: 7 });
    expect(Object.keys(wireResume ?? {})).not.toContain("lane");

    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "e1", position: 9 }),
    );
    latest().callbacks.onDelta(
      deltaFrame({
        authorityEpoch: "e1",
        seq: 10,
        identity: { revision: 2, identity: { title: "Renamed" } },
      }),
    );

    const events = emittedEvents(log);
    const snapshot = events[0];
    if (snapshot.kind !== "record-snapshot") throw new Error("no snapshot");
    expect(snapshot.watermark).toEqual({
      authorityEpoch: "e1",
      lane: LANE_ID,
      position: 9,
    });
    const transaction = events.find(
      (event) => event.kind === "record-transaction",
    );
    if (transaction?.kind !== "record-transaction") {
      throw new Error("no transaction");
    }
    expect(transaction.cursor).toEqual({
      authorityEpoch: "e1",
      lane: LANE_ID,
      position: 10,
    });
  });

  it("refuses a cursor minted on ANOTHER identity's lane", () => {
    // The failure this guards is identity-specific and silent: both cursors are
    // well-formed, and offering the other identity's position would ask the host
    // to resume THIS index from a number that means nothing in its domain.
    const foreign: LaneCursor = {
      authorityEpoch: "e1",
      lane: identityStateLaneId("identity-2"),
      position: 7,
    };
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, () => foreign, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    expect(adapter.resumeOffer()).toBeNull();
    expect(latest().resumeProvider()).toBeNull();
  });
});

// ─── Snapshot decode ───────────────────────────────────────────────────────

describe("createIdentityStateLaneAdapter - snapshot", () => {
  it("reports the reseed outcome BEFORE the rows, and the shards after them", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({
        position: 4,
        shards: [{ shardRoomId: "shard-a", state: "ready" }],
      }),
    );

    expect(log.map((entry) => entry.channel)).toEqual([
      "reportResume",
      "emit",
      "emit",
    ]);
    const [snapshot, shardEvent] = emittedEvents(log);
    expect(snapshot.kind).toBe("record-snapshot");
    expect(shardEvent).toEqual({
      kind: "identity-shard-availability",
      authorityEpoch: "epoch-1",
      shards: [{ shardRoomId: "shard-a", state: "ready" }],
    });
  });

  it("decodes the identity record and both row populations under disjoint keys", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const frame = snapshotFrame({
      identityRevision: 3,
      documents: [documentRowFixture("SOUL.md", 5)],
      // The same PATH in both populations: nothing on the wire forbids it, and
      // the two keys must not collide - which is the whole point of the prefix.
      files: [fileRowFixture("SOUL.md", 6)],
    });
    latest().callbacks.onSnapshot(frame);

    const [snapshot] = emittedEvents(log);
    if (snapshot.kind !== "record-snapshot") throw new Error("no snapshot");
    expect(snapshot.cause).toBe("initial");
    expect(snapshot.trust).toBe("seed-only");
    expect(snapshot.rows).toEqual([
      {
        rowId: IDENTITY_RECORD_ROW_ID,
        revision: 3,
        row: { kind: "identity", identity: frame.identity.identity },
      },
      {
        rowId: identityDocumentRowId("SOUL.md", incarnationOf("SOUL.md")),
        revision: 5,
        row: { kind: "document", row: frame.documents[0] },
      },
      {
        rowId: identityFileRowId("SOUL.md", incarnationOf("SOUL.md")),
        revision: 6,
        row: { kind: "file", row: frame.files[0] },
      },
    ]);
    expect(identityDocumentRowId("SOUL.md", incarnationOf("SOUL.md"))).not.toBe(
      identityFileRowId("SOUL.md", incarnationOf("SOUL.md")),
    );
  });

  it("labels the second snapshot of an attachment a reseed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({}));
    latest().callbacks.onSnapshot(snapshotFrame({ position: 1 }));

    const causes = emittedEvents(log)
      .filter((event) => event.kind === "record-snapshot")
      .map((event) =>
        event.kind === "record-snapshot" ? event.cause : "unreachable",
      );
    expect(causes).toEqual(["initial", "reseed"]);
  });

  it("asks for a replacement only on the two FAILURE bases", () => {
    const cases: readonly {
      basis: "cold" | "resumeTooOld" | "authorityEpochChanged";
      expected: readonly string[];
    }[] = [
      { basis: "cold", expected: [] },
      { basis: "resumeTooOld", expected: ["resume-too-old"] },
      {
        basis: "authorityEpochChanged",
        expected: ["authority-epoch-changed"],
      },
    ];
    for (const testCase of cases) {
      const { factory, latest } = createFakeStreamClientFactory();
      const adapter = createIdentityStateLaneAdapter(
        createSources(factory, undefined, undefined),
      );
      const { host, log } = createRecordingHost();
      adapter.attach(host);
      latest().callbacks.onSnapshot(snapshotFrame({ basis: testCase.basis }));
      expect(replacementReasons(log)).toEqual(testCase.expected);
    }
  });
});

// ─── Resumed and hostStateChanged ──────────────────────────────────────────

describe("createIdentityStateLaneAdapter - lead and host-state frames", () => {
  it("resumed carries no rows but re-states trust and shards", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onResumed(
      resumedFrame("e1", 12, true, [
        { shardRoomId: "shard-a", state: "retrying" },
      ]),
    );

    expect(log[0]).toEqual({
      channel: "reportResume",
      outcome: {
        kind: "resumed",
        from: { authorityEpoch: "e1", lane: LANE_ID, position: 12 },
      },
    });
    expect(emittedEvents(log)).toEqual([
      {
        kind: "record-trust",
        authorityEpoch: "e1",
        trust: "reconciled-with-cloud",
      },
      {
        kind: "identity-shard-availability",
        authorityEpoch: "e1",
        shards: [{ shardRoomId: "shard-a", state: "retrying" }],
      },
    ]);
  });

  it("hostStateChanged re-emits both facts and no rows", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onHostStateChanged(
      hostStateFrame("e1", false, [
        { shardRoomId: "shard-a", state: "unavailable" },
      ]),
    );

    expect(emittedEvents(log)).toEqual([
      { kind: "record-trust", authorityEpoch: "e1", trust: "seed-only" },
      {
        kind: "identity-shard-availability",
        authorityEpoch: "e1",
        shards: [{ shardRoomId: "shard-a", state: "unavailable" }],
      },
    ]);
    // No cursor is minted: a shard flip and a trust flip consume no lane
    // position, so nothing here may advance a resume point.
    expect(
      log.filter((entry) => entry.channel === "reportResume"),
    ).toHaveLength(0);
  });
});

// ─── Delta decode ──────────────────────────────────────────────────────────

describe("createIdentityStateLaneAdapter - delta", () => {
  it("maps every change field, and removes by the population the WIRE named", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const frame = deltaFrame({
      seq: 4,
      identity: { revision: 9, identity: { title: "Renamed" } },
      documentUpserts: [documentRowFixture("skills/a/SKILL.md", 11)],
      fileUpserts: [fileRowFixture("skills/a/logo.png", 12)],
      removals: [
        {
          population: "document",
          path: "old.md",
          incarnation: incarnationOf("old.md"),
          revision: 13,
        },
        // Same path, other population: a client re-deriving which map a path
        // belongs to would remove the wrong row here.
        {
          population: "file",
          path: "old.md",
          incarnation: incarnationOf("old.md"),
          revision: 14,
        },
      ],
    });
    latest().callbacks.onDelta(frame);

    const [transaction] = emittedEvents(log);
    if (transaction.kind !== "record-transaction") {
      throw new Error("no transaction");
    }
    expect(transaction.barrier).toBeNull();
    expect(transaction.changes).toEqual([
      {
        kind: "upsert",
        row: {
          rowId: IDENTITY_RECORD_ROW_ID,
          revision: 9,
          // A PATCH, not a whole record: installing this wholesale would drop
          // the description the host deliberately did not restate.
          row: { kind: "identity-patch", identity: { title: "Renamed" } },
        },
      },
      {
        kind: "upsert",
        row: {
          rowId: identityDocumentRowId(
            "skills/a/SKILL.md",
            incarnationOf("skills/a/SKILL.md"),
          ),
          revision: 11,
          row: { kind: "document", row: frame.documentUpserts[0] },
        },
      },
      {
        kind: "upsert",
        row: {
          rowId: identityFileRowId(
            "skills/a/logo.png",
            incarnationOf("skills/a/logo.png"),
          ),
          revision: 12,
          row: { kind: "file", row: frame.fileUpserts[0] },
        },
      },
      {
        kind: "remove",
        rowId: identityDocumentRowId("old.md", incarnationOf("old.md")),
        revision: 13,
        reason: IDENTITY_ROW_REMOVE_REASON,
      },
      {
        kind: "remove",
        rowId: identityFileRowId("old.md", incarnationOf("old.md")),
        revision: 14,
        reason: IDENTITY_ROW_REMOVE_REASON,
      },
    ]);
  });

  it("emits a delta under an epoch the adapter has not seen, verbatim", () => {
    // The adapter does not enforce the epoch - the replica's own check answers
    // `requires-replacement`, and enforcing it here too would put one invariant
    // in two places and let the adapter fabricate a rebuild for a frame the host
    // is about to correct with a snapshot.
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "e1" }));
    latest().callbacks.onDelta(
      deltaFrame({
        authorityEpoch: "e2",
        seq: 1,
        documentUpserts: [documentRowFixture("a.md", 1)],
      }),
    );

    const transaction = emittedEvents(log).find(
      (event) => event.kind === "record-transaction",
    );
    if (transaction?.kind !== "record-transaction") {
      throw new Error("no transaction");
    }
    expect(transaction.cursor.authorityEpoch).toBe("e2");
    expect(replacementReasons(log)).toEqual([]);
  });
});

// ─── Generation guard and transport lifecycle ──────────────────────────────

describe("createIdentityStateLaneAdapter - generation guard", () => {
  it("drops every frame from a socket the adapter has superseded", () => {
    const { factory, handles, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);
    const stale = latest();

    adapter.closeTransport();
    adapter.openTransport();
    expect(handles()).toHaveLength(2);
    expect(stale.client.closeCalls).toBe(1);

    stale.callbacks.onSnapshot(snapshotFrame({ position: 99 }));
    stale.callbacks.onDelta(
      deltaFrame({ seq: 99, documentUpserts: [documentRowFixture("a.md", 1)] }),
    );
    stale.callbacks.onConnectionStatus("closed", null);

    expect(log).toHaveLength(0);
  });

  it("drops frames once the consumer reports itself disposed", () => {
    let disposed = false;
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, () => disposed),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    disposed = true;
    latest().callbacks.onSnapshot(snapshotFrame({}));
    latest().callbacks.onHostStateChanged(hostStateFrame("e1", true, []));

    expect(log).toHaveLength(0);
  });

  it("detach resets the lead marker, so the next attach's snapshot is initial again", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const first = createRecordingHost();
    adapter.attach(first.host);
    latest().callbacks.onSnapshot(snapshotFrame({}));
    adapter.detach("superseded");

    const second = createRecordingHost();
    adapter.attach(second.host);
    latest().callbacks.onSnapshot(snapshotFrame({}));

    const [snapshot] = emittedEvents(second.log);
    if (snapshot.kind !== "record-snapshot") throw new Error("no snapshot");
    expect(snapshot.cause).toBe("initial");
  });

  it("opens the wire subscription against the identity it was built for", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host } = createRecordingHost();
    adapter.attach(host);

    expect(latest().identityId).toBe(IDENTITY_ID);
    expect(adapter.descriptor.laneId).toBe(LANE_ID);
    expect(adapter.descriptor.kind).toBe("lane");
  });

  it("forwards transport status, naming a close reason only on a close", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onConnectionStatus("open", null);
    latest().callbacks.onConnectionStatus("closed", { kind: "caller" });

    const statuses = log
      .filter(
        (entry): entry is Extract<LogEntry, { channel: "reportStatus" }> =>
          entry.channel === "reportStatus",
      )
      .map((entry) => entry.status);
    expect(statuses).toEqual([
      { connection: "open", closeReason: null },
      { connection: "closed", closeReason: { kind: "caller" } },
    ]);
  });
});

// ─── Incarnations: one key per LIFE of a path ─────────────────────────────

describe("createIdentityStateLaneAdapter - incarnation keys", () => {
  /** Every change the adapter emitted, in order, across all transactions. */
  function emittedChanges(
    log: readonly LogEntry[],
  ): readonly { kind: string; rowId: string }[] {
    return emittedEvents(log).flatMap((event) =>
      event.kind === "record-transaction"
        ? event.changes.map((change) => ({
            kind: change.kind,
            rowId: change.kind === "upsert" ? change.row.rowId : change.rowId,
          }))
        : [],
    );
  }

  it("keys a rename back to a path apart from the life that rename removed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    // A, renamed to B, renamed back to A - each rename one envelope carrying the
    // destination's fresh life and the source's removal.
    latest().callbacks.onDelta(
      deltaFrame({ seq: 1, documentUpserts: [documentRowAt("a.md", "a1", 1)] }),
    );
    latest().callbacks.onDelta(
      deltaFrame({
        seq: 2,
        documentUpserts: [documentRowAt("b.md", "b1", 1)],
        removals: [
          {
            population: "document",
            path: "a.md",
            incarnation: "a1",
            revision: 2,
          },
        ],
      }),
    );
    latest().callbacks.onDelta(
      deltaFrame({
        seq: 3,
        documentUpserts: [documentRowAt("a.md", "a2", 1)],
        removals: [
          {
            population: "document",
            path: "b.md",
            incarnation: "b1",
            revision: 2,
          },
        ],
      }),
    );

    const firstA = identityDocumentRowId("a.md", "a1");
    const secondA = identityDocumentRowId("a.md", "a2");
    expect(emittedChanges(log)).toEqual([
      { kind: "upsert", rowId: firstA },
      { kind: "upsert", rowId: identityDocumentRowId("b.md", "b1") },
      { kind: "remove", rowId: firstA },
      { kind: "upsert", rowId: secondA },
      { kind: "remove", rowId: identityDocumentRowId("b.md", "b1") },
    ]);
    // The tombstone the first rename left names the first life only.
    expect(secondA).not.toBe(firstA);
  });

  it("keys a blob recreated from the same bytes apart from the one deleted", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createIdentityStateLaneAdapter(
      createSources(factory, undefined, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    // Same path, same sha256: nothing but the incarnation tells the lives apart.
    latest().callbacks.onDelta(
      deltaFrame({ seq: 1, fileUpserts: [fileRowAt("logo.png", "f1", 1)] }),
    );
    latest().callbacks.onDelta(
      deltaFrame({
        seq: 2,
        removals: [
          {
            population: "file",
            path: "logo.png",
            incarnation: "f1",
            revision: 2,
          },
        ],
      }),
    );
    latest().callbacks.onDelta(
      deltaFrame({ seq: 3, fileUpserts: [fileRowAt("logo.png", "f2", 1)] }),
    );

    expect(emittedChanges(log)).toEqual([
      { kind: "upsert", rowId: identityFileRowId("logo.png", "f1") },
      { kind: "remove", rowId: identityFileRowId("logo.png", "f1") },
      { kind: "upsert", rowId: identityFileRowId("logo.png", "f2") },
    ]);
  });

  it("never aliases two (path, incarnation) pairs, whatever either half contains", () => {
    // Both halves are free-form; a plain join would make these two pairs one key.
    expect(identityDocumentRowId("a#b", "c")).not.toBe(
      identityDocumentRowId("a", "b#c"),
    );
    expect(identityDocumentRowId('a","b', "c")).not.toBe(
      identityDocumentRowId("a", 'b","c'),
    );
    expect(identityDocumentRowId("x", "1")).not.toBe(
      identityFileRowId("x", "1"),
    );
  });
});
