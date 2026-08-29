import { describe, expect, it } from "vitest";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import type {
  AdapterHost,
  AdapterStatus,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  createLegacyEpicStreamAdapter,
  type EpicStreamClientFactory,
  type LegacyEpicStreamAdapterSources,
  type OpenEpicStreamClient,
} from "../legacy-epic-stream-adapter";
import type { EpicRuntimeEvent } from "../epic-runtime-events";

/**
 * `epic.subscribe@1` legacy adapter - decode, plane routing, generation-guard
 * dropping, and send routing.
 *
 * Every test here drives the adapter with a fake stream-client factory that
 * records the callbacks and seed-offer provider it was handed, and a
 * recording `AdapterHost` fake. No socket, no store, no projection -
 * exactly the seam the module doc describes.
 */

// ─── Fakes ──────────────────────────────────────────────────────────────

interface RoomCallArgs {
  readonly artifactRoomId: string;
  readonly bytes: Uint8Array;
}

interface FakeStreamClient extends OpenEpicStreamClient {
  readonly applyUpdateCalls: Uint8Array[];
  readonly awarenessCalls: Uint8Array[];
  readonly applyArtifactRoomUpdateCalls: RoomCallArgs[];
  readonly artifactRoomAwarenessCalls: RoomCallArgs[];
  readonly retryMigrationCalls: true[];
  readonly closeCalls: true[];
}

function createFakeStreamClient(): FakeStreamClient {
  const applyUpdateCalls: Uint8Array[] = [];
  const awarenessCalls: Uint8Array[] = [];
  const applyArtifactRoomUpdateCalls: RoomCallArgs[] = [];
  const artifactRoomAwarenessCalls: RoomCallArgs[] = [];
  const retryMigrationCalls: true[] = [];
  const closeCalls: true[] = [];
  return {
    applyUpdateCalls,
    awarenessCalls,
    applyArtifactRoomUpdateCalls,
    artifactRoomAwarenessCalls,
    retryMigrationCalls,
    closeCalls,
    applyUpdate: (update) => {
      applyUpdateCalls.push(update);
    },
    awareness: (frame) => {
      awarenessCalls.push(frame);
    },
    applyArtifactRoomUpdate: (artifactRoomId, update) => {
      applyArtifactRoomUpdateCalls.push({ artifactRoomId, bytes: update });
    },
    artifactRoomAwareness: (artifactRoomId, frame) => {
      artifactRoomAwarenessCalls.push({ artifactRoomId, bytes: frame });
    },
    retryMigration: () => {
      retryMigrationCalls.push(true);
    },
    close: () => {
      closeCalls.push(true);
    },
  };
}

interface FakeStreamHandle {
  readonly callbacks: EpicStreamCallbacks;
  readonly seedOfferProvider: () => EpicSubscribeClientSeedOffer | null;
  readonly client: FakeStreamClient;
}

function createFakeStreamClientFactory(): {
  readonly factory: EpicStreamClientFactory;
  readonly handles: () => readonly FakeStreamHandle[];
  readonly latest: () => FakeStreamHandle;
} {
  const handles: FakeStreamHandle[] = [];
  const factory: EpicStreamClientFactory = (
    _epicId,
    callbacks,
    seedOfferProvider,
  ) => {
    const client = createFakeStreamClient();
    handles.push({ callbacks, seedOfferProvider, client });
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

function createFakeAdapterHost(): AdapterHost<EpicRuntimeEvent> & {
  readonly emitted: EpicRuntimeEvent[];
  readonly statuses: AdapterStatus[];
} {
  const emitted: EpicRuntimeEvent[] = [];
  const statuses: AdapterStatus[] = [];
  return {
    environment: createFakeRuntimeEnvironment(),
    emitted,
    statuses,
    emit: (event) => {
      emitted.push(event);
    },
    reportResume: () => {},
    reportStatus: (status) => {
      statuses.push(status);
    },
    requestReplacement: () => {},
  };
}

function buildMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: null,
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "",
    roomId: "room-1",
  };
}

function createSources(
  streamClientFactory: EpicStreamClientFactory,
): LegacyEpicStreamAdapterSources {
  return {
    epicId: "epic-a",
    streamClientFactory,
    readSeedOffer: () => null,
    isDisposed: () => false,
  };
}

// ─── Decode: every plane, representative kinds ─────────────────────────────

describe("createLegacyEpicStreamAdapter - decode into plane/event", () => {
  it.each([
    {
      name: "onSnapshot -> root plane, root-snapshot",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const meta = buildMeta();
        const bytes = new Uint8Array([1, 2, 3]);
        callbacks.onSnapshot(meta, bytes);
        return {
          plane: "root",
          event: { kind: "root-snapshot", meta, update: bytes },
        };
      },
    },
    {
      name: "onUpdate -> root plane, root-update",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const bytes = new Uint8Array([4, 5]);
        callbacks.onUpdate(bytes);
        return { plane: "root", event: { kind: "root-update", update: bytes } };
      },
    },
    {
      name: "onAwareness -> root plane, root-awareness",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const bytes = new Uint8Array([9]);
        callbacks.onAwareness(bytes);
        return {
          plane: "root",
          event: { kind: "root-awareness", frame: bytes },
        };
      },
    },
    {
      name: "onArtifactRoomSnapshot -> rooms plane, room-snapshot",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const bytes = new Uint8Array([7, 8]);
        callbacks.onArtifactRoomSnapshot("room-1", bytes, "sv-base64");
        return {
          plane: "rooms",
          event: {
            kind: "room-snapshot",
            artifactRoomId: "room-1",
            update: bytes,
            hostStateVectorBase64: "sv-base64",
            // The `@1` arm states no offer protocol and no doc identity. These
            // two values are what keep the tier's "a changed guid replaces the
            // held doc" rule unreachable from this arm, so they are asserted
            // rather than left to the shape check: a future edit that made
            // this adapter invent a guid would splice two histories together
            // on the next recreate, and this is the line that would stop it.
            seed: "full",
            docGuid: null,
          },
        };
      },
    },
    {
      name: "onArtifactRoomUpdate -> rooms plane, room-update",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const bytes = new Uint8Array([3]);
        callbacks.onArtifactRoomUpdate("room-1", bytes, "sv-after");
        return {
          plane: "rooms",
          event: {
            kind: "room-update",
            artifactRoomId: "room-1",
            update: bytes,
            hostStateVectorBase64: "sv-after",
          },
        };
      },
    },
    {
      name: "onPermissionChanged -> control plane, permission-changed",
      invoke: (callbacks: EpicStreamCallbacks) => {
        callbacks.onPermissionChanged("viewer");
        return {
          plane: "control",
          event: { kind: "permission-changed", role: "viewer" },
        };
      },
    },
    {
      name: "onEpicDeleted -> control plane, epic-deleted",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const attribution = {
          deletedByDisplayName: "Ada",
          deletedByTraycerUserId: "u-1",
        };
        callbacks.onEpicDeleted(attribution);
        return {
          plane: "control",
          event: { kind: "epic-deleted", attribution },
        };
      },
    },
    {
      name: "onDirtySnapshot -> control plane, dirty-snapshot",
      invoke: (callbacks: EpicStreamCallbacks) => {
        const rooms = [{ artifactRoomId: "room-1", dirty: true }];
        callbacks.onDirtySnapshot(false, rooms);
        return {
          plane: "control",
          event: { kind: "dirty-snapshot", rootDirty: false, rooms },
        };
      },
    },
    {
      name: "onMigrationStarted -> control plane, migration started",
      invoke: (callbacks: EpicStreamCallbacks) => {
        callbacks.onMigrationStarted();
        return {
          plane: "control",
          event: { kind: "migration", migration: { phase: "started" } },
        };
      },
    },
  ])("$name", ({ invoke }) => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);

    const expected = invoke(latest().callbacks);

    expect(host.emitted).toEqual([expected]);
  });
});

// ─── onConnectionStatus: dual report ───────────────────────────────────────

describe("createLegacyEpicStreamAdapter - onConnectionStatus", () => {
  it("reports through host.reportStatus AND emits a control transport-status event", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);

    const reason: StreamCloseReason = { kind: "caller" };
    latest().callbacks.onConnectionStatus("closed", reason);

    expect(host.statuses).toEqual([
      { connection: "closed", closeReason: reason },
    ]);
    expect(host.emitted).toEqual([
      {
        plane: "control",
        event: { kind: "transport-status", status: "closed", reason },
      },
    ]);
  });

  it("a non-closed status reports a null closeReason even if the callback carried one", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);

    const status: StreamConnectionStatus = "reconnecting";
    latest().callbacks.onConnectionStatus(status, null);

    expect(host.statuses).toEqual([
      { connection: "reconnecting", closeReason: null },
    ]);
    expect(host.emitted).toEqual([
      {
        plane: "control",
        event: { kind: "transport-status", status, reason: null },
      },
    ]);
  });
});

// ─── Stale-generation frames are dropped ───────────────────────────────────

describe("createLegacyEpicStreamAdapter - generation guard", () => {
  it("a frame from a generation retired by closeTransport() is dropped", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);

    const staleCallbacks = latest().callbacks;
    adapter.closeTransport();

    staleCallbacks.onUpdate(new Uint8Array([1]));

    expect(host.emitted).toEqual([]);
  });

  it("a frame from a generation retired by detach() is dropped", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);

    const staleCallbacks = latest().callbacks;
    adapter.detach("disposed");

    staleCallbacks.onUpdate(new Uint8Array([1]));
    staleCallbacks.onConnectionStatus("closed", { kind: "caller" });

    expect(host.emitted).toEqual([]);
    expect(host.statuses).toEqual([]);
  });

  it("a fresh generation after closeTransport()+openTransport() still decodes normally", () => {
    const { factory, latest, handles } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);

    adapter.closeTransport();
    adapter.openTransport();

    expect(handles()).toHaveLength(2);
    const bytes = new Uint8Array([9, 9]);
    latest().callbacks.onUpdate(bytes);

    expect(host.emitted).toEqual([
      { plane: "root", event: { kind: "root-update", update: bytes } },
    ]);
  });
});

// ─── resumeOffer() ──────────────────────────────────────────────────────────

describe("createLegacyEpicStreamAdapter - resumeOffer", () => {
  it("is always null, before and after attach", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));

    expect(adapter.resumeOffer()).toBeNull();

    const host = createFakeAdapterHost();
    adapter.attach(host);

    expect(adapter.resumeOffer()).toBeNull();
  });
});

// ─── send() ─────────────────────────────────────────────────────────────────

describe("createLegacyEpicStreamAdapter - send", () => {
  it("returns dropped/no-transport when no client is attached yet", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));

    const outcome = adapter.send({
      kind: "root-update",
      update: new Uint8Array([1]),
    });

    expect(outcome).toEqual({ kind: "dropped", reason: "no-transport" });
  });

  it("returns dropped/no-transport after detach()", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);
    adapter.detach("disposed");

    const outcome = adapter.send({
      kind: "root-awareness",
      frame: new Uint8Array([1]),
    });

    expect(outcome).toEqual({ kind: "dropped", reason: "no-transport" });
  });

  it("returns dropped/no-transport after closeTransport()", () => {
    const { factory } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    const host = createFakeAdapterHost();
    adapter.attach(host);
    adapter.closeTransport();

    const outcome = adapter.send({ kind: "retry-migration" });

    expect(outcome).toEqual({ kind: "dropped", reason: "no-transport" });
  });

  it("root-update routes to applyUpdate with the exact bytes", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    adapter.attach(createFakeAdapterHost());

    const update = new Uint8Array([1, 2, 3]);
    const outcome = adapter.send({ kind: "root-update", update });

    expect(outcome).toEqual({ kind: "sent" });
    expect(latest().client.applyUpdateCalls).toEqual([update]);
  });

  it("root-awareness routes to awareness with the exact frame", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    adapter.attach(createFakeAdapterHost());

    const frame = new Uint8Array([4, 5]);
    const outcome = adapter.send({ kind: "root-awareness", frame });

    expect(outcome).toEqual({ kind: "sent" });
    expect(latest().client.awarenessCalls).toEqual([frame]);
  });

  it("room-update routes to applyArtifactRoomUpdate with the room id and bytes", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    adapter.attach(createFakeAdapterHost());

    const update = new Uint8Array([6]);
    const outcome = adapter.send({
      kind: "room-update",
      artifactRoomId: "room-9",
      update,
    });

    expect(outcome).toEqual({ kind: "sent" });
    expect(latest().client.applyArtifactRoomUpdateCalls).toEqual([
      { artifactRoomId: "room-9", bytes: update },
    ]);
  });

  it("room-awareness routes to artifactRoomAwareness with the room id and frame", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    adapter.attach(createFakeAdapterHost());

    const frame = new Uint8Array([7]);
    const outcome = adapter.send({
      kind: "room-awareness",
      artifactRoomId: "room-9",
      frame,
    });

    expect(outcome).toEqual({ kind: "sent" });
    expect(latest().client.artifactRoomAwarenessCalls).toEqual([
      { artifactRoomId: "room-9", bytes: frame },
    ]);
  });

  it("retry-migration routes to retryMigration with no args", () => {
    const { factory, latest } = createFakeStreamClientFactory();
    const adapter = createLegacyEpicStreamAdapter(createSources(factory));
    adapter.attach(createFakeAdapterHost());

    const outcome = adapter.send({ kind: "retry-migration" });

    expect(outcome).toEqual({ kind: "sent" });
    expect(latest().client.retryMigrationCalls).toHaveLength(1);
  });
});
