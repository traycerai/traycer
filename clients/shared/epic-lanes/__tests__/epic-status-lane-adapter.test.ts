import { describe, expect, it } from "vitest";
import { epicStatusSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/status-subscribe";
import type {
  AdapterHost,
  AdapterStatus,
  ControlEvent,
  ResumeOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
  EpicStatusTransitionFrame,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import {
  createEpicStatusLaneAdapter,
  type EpicStatusLaneAdapterSources,
  type EpicStatusLaneStreamClient,
  type EpicStatusStreamClientFactory,
} from "../epic-status-lane-adapter";

/**
 * `epic.status.subscribe@1.0` adapter - control-lane decode, the false-clean
 * dirty guard, snapshot emission order, replacement signalling (migration
 * completion vs a bare epoch change), and the security-epoch fold.
 *
 * Every server frame is built by `.parse()`-ing through the real wire schema
 * and narrowing on `kind`, never hand-typed.
 */

// ─── Frame builders (parsed through the real schema) ───────────────────────

interface SnapshotOverrides {
  readonly authorityEpoch?: string;
  readonly securityEpoch?: number;
  readonly permissionRole?: "owner" | "editor" | "viewer" | null;
  readonly cloudSyncStatus?: "connected" | "reconnecting" | "disconnected";
  readonly dirty?: boolean | null;
  readonly migration?:
    | {
        state: "running";
        progress: null | {
          phase: "prepare" | "upload" | "finalize";
          chunksDone: number;
          chunksTotal: number;
        };
      }
    | { state: "failed"; reason: string }
    | { state: "notAllowed" }
    | null;
  readonly deletion?:
    | { state: "unknown" }
    | { state: "none" }
    | {
        state: "deleted";
        attribution: {
          deletedByDisplayName: string | null;
          deletedByTraycerUserId: string | null;
        };
      };
}

function snapshotFrame(overrides: SnapshotOverrides): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    authorityEpoch: overrides.authorityEpoch ?? "epoch-1",
    securityEpoch: overrides.securityEpoch ?? 0,
    permissionRole:
      overrides.permissionRole === undefined ? null : overrides.permissionRole,
    cloudSyncStatus: overrides.cloudSyncStatus ?? "disconnected",
    dirty: overrides.dirty === undefined ? null : overrides.dirty,
    migration: overrides.migration === undefined ? null : overrides.migration,
    deletion: overrides.deletion ?? { state: "unknown" },
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "snapshot") throw new Error("fixture drift: snapshot");
  return parsed;
}

function permissionChangedFrame(
  authorityEpoch: string,
  securityEpoch: number,
  permissionRole: "owner" | "editor" | "viewer" | null,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "permissionChanged",
    authorityEpoch,
    securityEpoch,
    permissionRole,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "permissionChanged") throw new Error("fixture drift");
  return parsed;
}

function dirtyChangedFrame(
  authorityEpoch: string,
  dirty: boolean,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "dirtyChanged",
    authorityEpoch,
    dirty,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "dirtyChanged") throw new Error("fixture drift");
  return parsed;
}

function epicDeletedFrame(authorityEpoch: string): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "epicDeleted",
    authorityEpoch,
    attribution: { deletedByDisplayName: "Ada", deletedByTraycerUserId: "u-1" },
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "epicDeleted") throw new Error("fixture drift");
  return parsed;
}

function migrationStartedFrame(
  authorityEpoch: string,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "migrationStarted",
    authorityEpoch,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "migrationStarted") throw new Error("fixture drift");
  return parsed;
}

function migrationProgressFrame(
  authorityEpoch: string,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "migrationProgress",
    authorityEpoch,
    phase: "upload",
    chunksDone: 1,
    chunksTotal: 4,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "migrationProgress") throw new Error("fixture drift");
  return parsed;
}

function migrationFailedFrame(
  authorityEpoch: string,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "migrationFailed",
    authorityEpoch,
    reason: "disk full",
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "migrationFailed") throw new Error("fixture drift");
  return parsed;
}

function migrationNotAllowedFrame(
  authorityEpoch: string,
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "migrationNotAllowed",
    authorityEpoch,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "migrationNotAllowed") throw new Error("fixture drift");
  return parsed;
}

function cloudSyncStatusFrame(
  authorityEpoch: string,
  status: "connected" | "reconnecting" | "disconnected",
): EpicStatusTransitionFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV10.parse({
    kind: "cloudSyncStatus",
    authorityEpoch,
    status,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "cloudSyncStatus") throw new Error("fixture drift");
  return parsed;
}

// ─── Fakes ──────────────────────────────────────────────────────────────

interface FakeStreamClient extends EpicStatusLaneStreamClient {
  readonly closeCalls: number;
}

interface FakeHandle {
  readonly callbacks: EpicStatusStreamCallbacks;
}

function createFakeStreamClientFactory(): {
  readonly factory: EpicStatusStreamClientFactory;
  readonly handles: () => readonly FakeHandle[];
  readonly latest: () => FakeHandle;
} {
  const handles: FakeHandle[] = [];
  const factory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    let closeCalls = 0;
    const client: FakeStreamClient = {
      get closeCalls() {
        return closeCalls;
      },
      close: () => {
        closeCalls += 1;
      },
    };
    handles.push({ callbacks });
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
    clock: { now: () => 5000 },
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

type LogEntry =
  | { readonly channel: "emit"; readonly event: ControlEvent }
  | { readonly channel: "reportResume"; readonly outcome: ResumeOutcome }
  | { readonly channel: "reportStatus"; readonly status: AdapterStatus }
  | { readonly channel: "requestReplacement"; readonly reason: string };

function createRecordingHost(): {
  readonly host: AdapterHost<ControlEvent>;
  readonly log: readonly LogEntry[];
} {
  const log: LogEntry[] = [];
  const host: AdapterHost<ControlEvent> = {
    environment: createFakeRuntimeEnvironment(),
    emit: (event) => log.push({ channel: "emit", event }),
    reportResume: (outcome) => log.push({ channel: "reportResume", outcome }),
    reportStatus: (status) => log.push({ channel: "reportStatus", status }),
    requestReplacement: (reason) =>
      log.push({ channel: "requestReplacement", reason }),
  };
  return { host, log };
}

function emittedEvents(log: readonly LogEntry[]): ControlEvent[] {
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

/**
 * The full log, unfiltered, as one ordered token per entry - `emit:<kind>` or
 * `requestReplacement:<reason>`. `emittedEvents` and `replacementReasons`
 * above each filter to one channel, which is exactly what throws away the
 * ORDER between a replacement request and the emits around it - the fact the
 * snapshot-emission-order test below exists to pin.
 */
function timeline(log: readonly LogEntry[]): string[] {
  return log.map((entry) => {
    switch (entry.channel) {
      case "emit":
        return `emit:${entry.event.kind}`;
      case "requestReplacement":
        return `requestReplacement:${entry.reason}`;
      case "reportResume":
        return `reportResume:${entry.outcome.kind}`;
      case "reportStatus":
        return `reportStatus:${entry.status.connection}`;
    }
  });
}

function createSources(
  streamClientFactory: EpicStatusStreamClientFactory,
  isDisposed: (() => boolean) | undefined,
): EpicStatusLaneAdapterSources {
  return {
    epicId: "epic-1",
    environment: createFakeRuntimeEnvironment(),
    streamClientFactory,
    isDisposed: isDisposed ?? (() => false),
  };
}

// ─── The false-clean guard ──────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - the false-clean dirty guard", () => {
  it("snapshot dirty:null emits NO aggregate-dirty event at all", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ dirty: null }));

    const dirtyEvents = emittedEvents(log).filter(
      (event) => event.kind === "aggregate-dirty",
    );
    expect(dirtyEvents).toHaveLength(0);
  });

  it("a following dirtyChanged frame after a null-dirty snapshot emits aggregate-dirty", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ dirty: null }));
    latest().callbacks.onTransition(dirtyChangedFrame("epoch-1", true));

    const dirtyEvents = emittedEvents(log).filter(
      (event) => event.kind === "aggregate-dirty",
    );
    expect(dirtyEvents).toEqual([{ kind: "aggregate-dirty", dirty: true }]);
  });

  it("snapshot dirty:false DOES emit aggregate-dirty/dirty:false", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ dirty: false }));

    const dirtyEvents = emittedEvents(log).filter(
      (event) => event.kind === "aggregate-dirty",
    );
    expect(dirtyEvents).toEqual([{ kind: "aggregate-dirty", dirty: false }]);
  });
});

// ─── Snapshot emission order ────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - snapshot emission order", () => {
  it("the snapshot BOUNDARY first, then permission-changed, cloud-sync-status, dirty, migration, epic-deleted", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({
        permissionRole: "editor",
        cloudSyncStatus: "connected",
        dirty: true,
        migration: { state: "running", progress: null },
        deletion: {
          state: "deleted",
          attribution: {
            deletedByDisplayName: "Ada",
            deletedByTraycerUserId: "u-1",
          },
        },
      }),
    );

    expect(emittedEvents(log).map((event) => event.kind)).toEqual([
      // FIRST, and it is not one more flattened fact. Flattening a snapshot
      // into ordinary events drops the fact that a snapshot happened at all,
      // and that fact is not recoverable downstream - a lane delta and a lane
      // snapshot arrive as the same event kinds. The legacy arm never had to
      // say it separately because ONE function landed the snapshot and adopted
      // its role; this lane has no such function, and without this event the
      // open cycle's freshness latch is never set, so every write on the lane
      // arm is refused before dispatch for the life of the session.
      //
      // Before the CONTENTS because it is what makes this cycle's answer
      // authoritative and they are that answer's contents.
      "control-snapshot-complete",
      "permission-changed",
      "cloud-sync-status",
      "aggregate-dirty",
      "migration",
      "epic-deleted",
    ]);
  });
});

// ─── Deletion projection ─────────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - deletion projection", () => {
  it("deletion.state 'unknown' and 'none' each emit zero epic-deleted events", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ deletion: { state: "unknown" } }),
    );
    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-2", deletion: { state: "none" } }),
    );

    expect(
      emittedEvents(log).filter((event) => event.kind === "epic-deleted"),
    ).toEqual([]);
  });

  it("deletion.state 'deleted' emits epic-deleted with both attribution fields verbatim, including both null", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({
        deletion: {
          state: "deleted",
          attribution: {
            deletedByDisplayName: null,
            deletedByTraycerUserId: null,
          },
        },
      }),
    );

    const deletedEvents = emittedEvents(log).filter(
      (event) => event.kind === "epic-deleted",
    );
    expect(deletedEvents).toEqual([
      {
        kind: "epic-deleted",
        deletedByDisplayName: null,
        deletedByTraycerUserId: null,
      },
    ]);
  });

  it("epicDeleted transition frame emits epic-deleted verbatim", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({}));
    latest().callbacks.onTransition(epicDeletedFrame("epoch-1"));

    const deletedEvents = emittedEvents(log).filter(
      (event) => event.kind === "epic-deleted",
    );
    expect(deletedEvents).toEqual([
      {
        kind: "epic-deleted",
        deletedByDisplayName: "Ada",
        deletedByTraycerUserId: "u-1",
      },
    ]);
  });
});

// ─── canWrite ────────────────────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - canWrite", () => {
  it.each([
    { role: "owner" as const, canWrite: true },
    { role: "editor" as const, canWrite: true },
    { role: "viewer" as const, canWrite: false },
    { role: null, canWrite: false },
  ])("role $role -> canWrite $canWrite", ({ role, canWrite }) => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ permissionRole: role }));

    const permissionEvent = emittedEvents(log).find(
      (event) => event.kind === "permission-changed",
    );
    if (
      permissionEvent === undefined ||
      permissionEvent.kind !== "permission-changed"
    ) {
      throw new Error("expected a permission-changed event");
    }
    expect(permissionEvent.canWrite).toBe(canWrite);
  });
});

// ─── observedAuthorityEpoch ──────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - observedAuthorityEpoch", () => {
  it("is null before the first frame, then the epoch, and survives detach()", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host } = createRecordingHost();

    expect(adapter.observedAuthorityEpoch()).toBeNull();

    adapter.attach(host);
    expect(adapter.observedAuthorityEpoch()).toBeNull();

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-9" }));
    expect(adapter.observedAuthorityEpoch()).toBe("epoch-9");

    adapter.detach("disposed");
    expect(adapter.observedAuthorityEpoch()).toBe("epoch-9");
  });
});

// ─── Replacement reasons ─────────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - replacement signalling", () => {
  it("the first snapshot never requests a replacement", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-1" }));

    expect(replacementReasons(log)).toEqual([]);
  });

  it("a second snapshot with a different epoch after a migration:running snapshot -> migration-completed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({
        authorityEpoch: "epoch-1",
        migration: { state: "running", progress: null },
      }),
    );
    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-2" }));

    expect(replacementReasons(log)).toEqual(["migration-completed"]);
  });

  it("the same epoch change with no migration in flight -> authority-epoch-changed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-1" }));
    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-2" }));

    expect(replacementReasons(log)).toEqual(["authority-epoch-changed"]);
  });

  it("migrationStarted then an epoch-changed snapshot -> migration-completed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-1" }));
    latest().callbacks.onTransition(migrationStartedFrame("epoch-1"));
    latest().callbacks.onTransition(migrationProgressFrame("epoch-1"));
    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-2" }));

    expect(replacementReasons(log)).toEqual(["migration-completed"]);
  });

  it("migrationFailed then an epoch-changed snapshot -> authority-epoch-changed (a failed attempt is not in flight)", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-1" }));
    latest().callbacks.onTransition(migrationStartedFrame("epoch-1"));
    latest().callbacks.onTransition(migrationFailedFrame("epoch-1"));
    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-2" }));

    expect(replacementReasons(log)).toEqual(["authority-epoch-changed"]);
  });

  it("migrationNotAllowed then an epoch-changed snapshot -> authority-epoch-changed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-1" }));
    latest().callbacks.onTransition(migrationStartedFrame("epoch-1"));
    latest().callbacks.onTransition(migrationNotAllowedFrame("epoch-1"));
    latest().callbacks.onSnapshot(snapshotFrame({ authorityEpoch: "epoch-2" }));

    expect(replacementReasons(log)).toEqual(["authority-epoch-changed"]);
  });
});

// ─── Security epoch fold ─────────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - security epoch fold", () => {
  it("the first observation never requests a replacement", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(snapshotFrame({ securityEpoch: 3 }));

    expect(replacementReasons(log)).toEqual([]);
  });

  it("a strictly higher securityEpoch under the same authority epoch requests security-epoch-changed exactly once", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-1", securityEpoch: 3 }),
    );
    latest().callbacks.onTransition(
      permissionChangedFrame("epoch-1", 4, "viewer"),
    );

    expect(replacementReasons(log)).toEqual(["security-epoch-changed"]);
  });

  it("an equal or lower securityEpoch requests nothing", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-1", securityEpoch: 3 }),
    );
    latest().callbacks.onTransition(
      permissionChangedFrame("epoch-1", 3, "viewer"),
    );
    latest().callbacks.onTransition(
      permissionChangedFrame("epoch-1", 2, "viewer"),
    );

    expect(replacementReasons(log)).toEqual([]);
  });

  it("after an authority-epoch change the tracking resets, so the next security epoch does not fire a second request", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-1", securityEpoch: 10 }),
    );
    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-2", securityEpoch: 999 }),
    );

    // Only the authority-epoch-changed replacement fires; the huge
    // securityEpoch on the epoch-2 snapshot is the FIRST observation under
    // the new epoch and must not fire a second, security-epoch request.
    expect(replacementReasons(log)).toEqual(["authority-epoch-changed"]);
  });
});

// ─── Replacement request lands BEFORE the snapshot's own emits ─────────────

describe("createEpicStatusLaneAdapter - security-epoch replacement lands before the snapshot's own emits", () => {
  it("an unchanged authority epoch with a higher securityEpoch requests the replacement BEFORE control-snapshot-complete and permission-changed", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    // First observation of both epochs: establishes them, requests nothing.
    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-1", securityEpoch: 1 }),
    );

    // Same authority epoch, a strictly higher securityEpoch - the ONLY thing
    // that changed is what `foldSecurityEpoch` folds.
    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-1", securityEpoch: 2 }),
    );

    expect(timeline(log)).toEqual([
      // The first snapshot's own restatement.
      "emit:control-snapshot-complete",
      "emit:permission-changed",
      "emit:cloud-sync-status",
      // The second snapshot: the replacement request FIRST...
      "requestReplacement:security-epoch-changed",
      // ...and only then the snapshot's own emits. `requestReplacement` is
      // synchronous and RESETS the runtime, so anything already emitted
      // above it is erased. Before the fix, `foldSecurityEpoch` ran AFTER
      // these next two emits, so the request landed HERE instead - clearing
      // the very role and freshness gate they had just established, with
      // nothing below to re-emit either. Writes were then refused for the
      // rest of the session, until some later status snapshot happened to
      // arrive.
      "emit:control-snapshot-complete",
      "emit:permission-changed",
      "emit:cloud-sync-status",
    ]);
  });

  it("a permissionChanged TRANSITION carrying a higher securityEpoch requests the replacement before it emits the permission", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    // Establishes both epochs. Requests nothing - a first observation is the
    // client learning where it stands, not authorization moving underneath it.
    latest().callbacks.onSnapshot(
      snapshotFrame({ authorityEpoch: "epoch-1", securityEpoch: 1 }),
    );

    // The transition an upgrade produces: same authority epoch, a strictly
    // higher security epoch, and NO accompanying snapshot. That last part is
    // what makes this the worse half of the bug the sibling above pins - there,
    // the next status snapshot re-established the erased role; here the socket
    // stays open owing nothing further, so nothing ever re-emits it.
    latest().callbacks.onTransition(
      permissionChangedFrame("epoch-1", 2, "editor"),
    );

    expect(timeline(log)).toEqual([
      "emit:control-snapshot-complete",
      "emit:permission-changed",
      "emit:cloud-sync-status",
      // The request FIRST...
      "requestReplacement:security-epoch-changed",
      // ...and the role only after it. Reversed - which is how this path
      // shipped - the reset erases `currentRole` and the control-freshness
      // latch that this emit had just set, and every write is refused for the
      // life of the session.
      "emit:permission-changed",
    ]);
  });
});

// ─── Migration mapping ────────────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - migration mapping", () => {
  it("running/progress:null -> {status: 'started'}", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ migration: { state: "running", progress: null } }),
    );

    const migrationEvent = emittedEvents(log).find(
      (event) => event.kind === "migration",
    );
    expect(migrationEvent).toEqual({
      kind: "migration",
      migration: { status: "started" },
    });
  });

  it("running/progress:{phase,chunksDone,chunksTotal} -> {status:'progress', stage, ...}", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({
        migration: {
          state: "running",
          progress: { phase: "upload", chunksDone: 2, chunksTotal: 5 },
        },
      }),
    );

    const migrationEvent = emittedEvents(log).find(
      (event) => event.kind === "migration",
    );
    expect(migrationEvent).toEqual({
      kind: "migration",
      migration: {
        status: "progress",
        stage: "upload",
        chunksDone: 2,
        chunksTotal: 5,
      },
    });
  });

  it("failed -> {status:'failed', reason}", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ migration: { state: "failed", reason: "disk full" } }),
    );

    const migrationEvent = emittedEvents(log).find(
      (event) => event.kind === "migration",
    );
    expect(migrationEvent).toEqual({
      kind: "migration",
      migration: { status: "failed", reason: "disk full" },
    });
  });

  it("notAllowed -> {status:'not-allowed'} with NO reason key", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onSnapshot(
      snapshotFrame({ migration: { state: "notAllowed" } }),
    );

    const migrationEvent = emittedEvents(log).find(
      (event) => event.kind === "migration",
    );
    if (migrationEvent === undefined || migrationEvent.kind !== "migration") {
      throw new Error("expected a migration event");
    }
    expect(migrationEvent.migration).toEqual({ status: "not-allowed" });
    expect("reason" in migrationEvent.migration).toBe(false);
  });
});

// ─── resumeOffer ──────────────────────────────────────────────────────────────

describe("createEpicStatusLaneAdapter - resumeOffer", () => {
  it("is always null", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host } = createRecordingHost();

    expect(adapter.resumeOffer()).toBeNull();
    adapter.attach(host);
    expect(adapter.resumeOffer()).toBeNull();
    latest().callbacks.onSnapshot(snapshotFrame({}));
    expect(adapter.resumeOffer()).toBeNull();
  });
});

// ─── Generation guard / cloudSyncStatus decode ───────────────────────────────

describe("createEpicStatusLaneAdapter - generation guard", () => {
  it("a frame from a generation retired by detach() is dropped", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const stale = latest().callbacks;
    adapter.detach("disposed");

    stale.onSnapshot(snapshotFrame({}));
    stale.onTransition(cloudSyncStatusFrame("epoch-1", "connected"));
    stale.onConnectionStatus("closed", { kind: "caller" });

    expect(log).toEqual([]);
  });

  it("a frame from a generation retired by closeTransport() is dropped, and openTransport() opens a fresh one", () => {
    const { factory, latest, handles } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    const stale = latest().callbacks;
    adapter.closeTransport();
    stale.onSnapshot(snapshotFrame({}));
    expect(log).toEqual([]);

    adapter.openTransport();
    expect(handles()).toHaveLength(2);
    latest().callbacks.onSnapshot(snapshotFrame({}));
    expect(emittedEvents(log).length).toBeGreaterThan(0);
  });

  it("isDisposed() returning true makes every callback inert", () => {
    let disposed = false;
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, () => disposed),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    disposed = true;
    latest().callbacks.onSnapshot(snapshotFrame({}));

    expect(log).toEqual([]);
  });

  it("cloudSyncStatus transition decodes to cloud-sync-status with the environment clock reading", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createEpicStatusLaneAdapter(
      createSources(factory, undefined),
    );
    const { host, log } = createRecordingHost();
    adapter.attach(host);

    latest().callbacks.onTransition(
      cloudSyncStatusFrame("epoch-1", "reconnecting"),
    );

    expect(emittedEvents(log)).toEqual([
      { kind: "cloud-sync-status", status: "reconnecting", observedAtMs: 5000 },
    ]);
  });
});
