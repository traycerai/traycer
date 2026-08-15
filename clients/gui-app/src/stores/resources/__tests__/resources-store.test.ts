import { afterEach, describe, expect, it } from "vitest";
import type {
  AppResourceSnapshotWire,
  EpicResourceSnapshotWire,
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  OwnerResourceSnapshotWireV14,
  ResourceProcessSnapshotWire,
  ResourceOwnerKindWire,
} from "@traycer/protocol/host/resources/subscribe";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import {
  createResourcesStore,
  resourceOwnerKey,
  type ResourcesStreamClientFactory,
} from "@/stores/resources/resources-store";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

function makeProcess(
  over: Partial<ResourceProcessSnapshotWire>,
): ResourceProcessSnapshotWire {
  return {
    pid: 1,
    parentPid: null,
    rootPid: 1,
    name: "bash",
    command: "/bin/bash",
    cpuPercent: 10,
    rssBytes: 1_000,
    ...over,
  };
}

function makeOwner(
  kind: ResourceOwnerKindWire,
  ownerId: string,
  over: Partial<OwnerResourceSnapshotWireV14>,
): OwnerResourceSnapshotWireV14 {
  return {
    owner: { kind, hostId: "host-1", epicId: "epic-1", ownerId },
    sampledAt: 1_000,
    rootPids: [1],
    harnessId: null,
    managedCommand: null,
    activeProcessName: "bash",
    processCount: 2,
    cpuPercent: 10,
    rssBytes: 1_000,
    processes: [makeProcess({})],
    ...over,
  };
}

function makeEpic(
  over: Partial<EpicResourceSnapshotWire>,
): EpicResourceSnapshotWire {
  return {
    hostId: "host-1",
    epicId: "epic-1",
    sampledAt: 1_000,
    ownerCount: 1,
    processCount: 2,
    cpuPercent: 10,
    rssBytes: 1_000,
    ...over,
  };
}

function makeApp(
  over: Partial<AppResourceSnapshotWire>,
): AppResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    hostTotalMemoryBytes: 16_000,
    process: makeProcess({
      pid: 10,
      rootPid: 10,
      name: "traycer-host",
      command: "traycer-host",
      cpuPercent: 2,
      rssBytes: 500,
    }),
    processCount: 1,
    cpuPercent: 2,
    rssBytes: 500,
    ...over,
  };
}

function makeHostTree(
  over: Partial<HostTreeResourceSnapshotWire>,
): HostTreeResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    processCount: 4,
    cpuPercent: 25,
    rssBytes: 2_500,
    ...over,
  };
}

function makeOther(
  over: Partial<OtherResourceSnapshotWire>,
): OtherResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    rootPids: [20],
    processCount: 1,
    cpuPercent: 5,
    rssBytes: 400,
    processes: [makeProcess({ pid: 20, rootPid: 20 })],
    ...over,
  };
}

function projection(
  over: Partial<ResourcesProjectionPayload>,
): ResourcesProjectionPayload {
  return {
    epicId: "epic-1",
    sampledAt: 1_000,
    app: null,
    owners: [],
    epic: null,
    epics: [],
    hostTree: undefined,
    other: undefined,
    ...over,
  };
}

interface FakeClient {
  readonly factory: ResourcesStreamClientFactory;
  callbacks(): ResourcesStreamCallbacks;
  isClosed(): boolean;
}

function makeFakeClient(): FakeClient {
  let captured: ResourcesStreamCallbacks | null = null;
  let closed = false;
  return {
    factory: (_scope, callbacks) => {
      captured = callbacks;
      return {
        close: () => {
          closed = true;
        },
      };
    },
    callbacks: () => {
      if (captured === null) throw new Error("callbacks not wired");
      return captured;
    },
    isClosed: () => closed,
  };
}

describe("createResourcesStore", () => {
  it("populates owners + epic + sampledAt from the initial snapshot", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });

    fake.callbacks().onSnapshot(
      projection({
        sampledAt: 1_000,
        owners: [makeOwner("terminal", "s1", { cpuPercent: 12 })],
        epic: makeEpic({ cpuPercent: 12 }),
      }),
    );

    const state = handle.store.getState();
    expect(state.sampledAt).toBe(1_000);
    expect(
      state.owners.get(resourceOwnerKey("terminal", "s1"))?.cpuPercent,
    ).toBe(12);
    expect(
      state.owners.get(resourceOwnerKey("terminal", "s1"))?.processes[0].name,
    ).toBe("bash");
    expect(state.epic?.cpuPercent).toBe(12);
    handle.dispose();
  });

  it("treats a missing owner as absent (undefined), not zero", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });

    fake
      .callbacks()
      .onSnapshot(projection({ owners: [makeOwner("terminal", "s1", {})] }));
    // A later projection drops the owner entirely (no longer tracked).
    fake.callbacks().onUpdate(projection({ sampledAt: 2_000, owners: [] }));

    const state = handle.store.getState();
    expect(
      state.owners.get(resourceOwnerKey("terminal", "s1")),
    ).toBeUndefined();
    expect(state.owners.size).toBe(0);
    handle.dispose();
  });

  it("includes host app usage in the epic aggregate totals", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });

    fake.callbacks().onSnapshot(
      projection({
        app: makeApp({ cpuPercent: 2, rssBytes: 500 }),
        owners: [
          makeOwner("terminal", "term-1", {
            rootPids: [101],
            processCount: 2,
            cpuPercent: 10,
            rssBytes: 100,
          }),
        ],
      }),
    );

    expect(handle.store.getState().app?.process?.name).toBe("traycer-host");
    handle.dispose();
  });

  it("replaces the epic aggregate on update", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });

    fake
      .callbacks()
      .onSnapshot(projection({ epic: makeEpic({ cpuPercent: 10 }) }));
    fake
      .callbacks()
      .onUpdate(
        projection({ sampledAt: 2_000, epic: makeEpic({ cpuPercent: 80 }) }),
      );

    expect(handle.store.getState().epic?.cpuPercent).toBe(80);
    handle.dispose();
  });

  it("merges 1.2 host-tree and Other snapshots without churning unchanged identities", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "global" },
      streamClientFactory: fake.factory,
    });
    const hostTree = makeHostTree({});
    const other = makeOther({});

    fake.callbacks().onSnapshot(projection({ hostTree, other }));
    expect(handle.store.getState().hostTree).toBe(hostTree);
    expect(handle.store.getState().other).toBe(other);

    fake.callbacks().onUpdate(
      projection({
        sampledAt: 2_000,
        hostTree: makeHostTree({ sampledAt: 2_000 }),
        other: makeOther({ sampledAt: 2_000 }),
      }),
    );
    expect(handle.store.getState().hostTree).toBe(hostTree);
    expect(handle.store.getState().other).toBe(other);

    fake.callbacks().onUpdate(
      projection({
        sampledAt: 3_000,
        hostTree: makeHostTree({ sampledAt: 3_000, cpuPercent: 30 }),
        other: makeOther({ sampledAt: 3_000, rssBytes: 500 }),
      }),
    );
    expect(handle.store.getState().hostTree?.cpuPercent).toBe(30);
    expect(handle.store.getState().other?.rssBytes).toBe(500);
    handle.dispose();
  });

  it("preserves owner object identity when only sampledAt moves, and swaps it when metrics change", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });
    const key = resourceOwnerKey("terminal", "s1");

    fake.callbacks().onSnapshot(
      projection({
        owners: [makeOwner("terminal", "s1", { cpuPercent: 10 })],
      }),
    );
    const first = handle.store.getState().owners.get(key);

    // New tick, same displayable metrics -> identity preserved (no chip churn).
    fake.callbacks().onUpdate(
      projection({
        sampledAt: 2_000,
        owners: [
          makeOwner("terminal", "s1", { cpuPercent: 10, sampledAt: 2_000 }),
        ],
      }),
    );
    expect(handle.store.getState().owners.get(key)).toBe(first);

    // Metrics moved -> fresh reference.
    fake.callbacks().onUpdate(
      projection({
        sampledAt: 3_000,
        owners: [
          makeOwner("terminal", "s1", { cpuPercent: 55, sampledAt: 3_000 }),
        ],
      }),
    );
    const third = handle.store.getState().owners.get(key);
    expect(third).not.toBe(first);
    expect(third?.cpuPercent).toBe(55);
    handle.dispose();
  });

  it("tracks connection status and closes the client on dispose", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });

    expect(handle.store.getState().connectionStatus).toBe("connecting");
    fake.callbacks().onConnectionStatus("open", null);
    expect(handle.store.getState().connectionStatus).toBe("open");

    handle.dispose();
    expect(fake.isClosed()).toBe(true);
  });
});

describe("resourcesRegistry", () => {
  afterEach(() => {
    resourcesRegistry.disposeAll();
  });

  it("lease-counts a shared entry and disposes only when the last lease is released", () => {
    const fake = makeFakeClient();
    const token = { id: "token" };
    const acquire = () =>
      resourcesRegistry.acquire(token.id, token, "host-a", () =>
        createResourcesStore({
          scope: { kind: "epic", epicId: token.id },
          streamClientFactory: fake.factory,
        }),
      );

    const first = acquire();
    const second = acquire();
    expect(second).toBe(first);

    resourcesRegistry.release(token.id);
    expect(resourcesRegistry.get(token.id)).toBe(first);
    expect(fake.isClosed()).toBe(false);

    resourcesRegistry.release(token.id);
    expect(resourcesRegistry.get(token.id)).toBeNull();
    expect(fake.isClosed()).toBe(true);
  });

  it("rebuilds the store against a new client token (host swap)", () => {
    const first = makeFakeClient();
    const second = makeFakeClient();

    const handleA = resourcesRegistry.acquire(
      "epic-1",
      "token-a",
      "host-a",
      () =>
        createResourcesStore({
          scope: { kind: "epic", epicId: "epic-1" },
          streamClientFactory: first.factory,
        }),
    );
    const handleB = resourcesRegistry.acquire(
      "epic-1",
      "token-b",
      "host-a",
      () =>
        createResourcesStore({
          scope: { kind: "epic", epicId: "epic-1" },
          streamClientFactory: second.factory,
        }),
    );

    expect(handleB).not.toBe(handleA);
    expect(first.isClosed()).toBe(true);
    expect(resourcesRegistry.get("epic-1")).toBe(handleB);
  });

  // Summing entries opened against different machines produces totals no
  // computer ever had. An aggregate that cannot name ONE host is not merely
  // unattributed - it is not publishable, so the fallback yields nothing.
  it("publishes nothing when per-epic entries disagree about their host", () => {
    const first = makeFakeClient();
    const second = makeFakeClient();
    resourcesRegistry.acquire("epic-1", "token-a", "host-a", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-1" },
        streamClientFactory: first.factory,
      }),
    );
    resourcesRegistry.acquire("epic-2", "token-b", "host-b", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-2" },
        streamClientFactory: second.factory,
      }),
    );

    const projection = resourcesRegistry.getGlobalProjection();

    expect(projection.hostId).toBeNull();
    expect(projection.owners).toEqual([]);
    expect(projection.entries).toEqual([]);
    expect(projection.app).toBeNull();
  });

  it("aggregates live entries globally and charges the app snapshot only once", () => {
    const first = makeFakeClient();
    const second = makeFakeClient();
    resourcesRegistry.acquire("epic-1", "token-a", "host-a", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-1" },
        streamClientFactory: first.factory,
      }),
    );
    resourcesRegistry.acquire("epic-2", "token-b", "host-a", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-2" },
        streamClientFactory: second.factory,
      }),
    );

    first.callbacks().onSnapshot(
      projection({
        app: makeApp({ sampledAt: 1_000, cpuPercent: 5, rssBytes: 500 }),
        owners: [
          makeOwner("terminal", "term-1", {
            cpuPercent: 10,
            rssBytes: 100,
          }),
        ],
      }),
    );
    second.callbacks().onSnapshot(
      projection({
        epicId: "epic-2",
        app: makeApp({ sampledAt: 2_000, cpuPercent: 7, rssBytes: 700 }),
        owners: [
          makeOwner("chat", "chat-1", {
            cpuPercent: 3,
            rssBytes: 300,
          }),
        ],
      }),
    );

    const global = resourcesRegistry.getGlobalProjection();
    expect(global.entries).toHaveLength(2);
    // Only the latest app snapshot is exposed (charged once, not summed per epic).
    expect(global.app?.sampledAt).toBe(2_000);
    expect(global.owners).toHaveLength(2);
  });
});

describe("global scope support", () => {
  afterEach(() => {
    resourcesRegistry.disposeAll();
  });

  it("starts unknown and records the verdict the stream publishes", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "global" },
      streamClientFactory: fake.factory,
    });

    expect(handle.store.getState().scopeSupport).toBe("unknown");

    fake.callbacks().onScopeSupport("unsupported");
    expect(handle.store.getState().scopeSupport).toBe("unsupported");

    handle.dispose();
  });

  // A remote session that is already ready but does not advertise the method
  // rejects the subscribe synchronously, and `LogicalStream.onStatusChange`
  // REPLAYS that terminal close the moment a handler is installed — which the
  // typed wrapper does in its constructor. So the verdict lands while
  // `streamClientFactory` is still running. Nothing follows a terminal close to
  // republish it, so losing it here strands the surface forever.
  it("keeps a verdict published while the stream was still being constructed", () => {
    const handle = createResourcesStore({
      scope: { kind: "global" },
      streamClientFactory: (_scope, callbacks) => {
        callbacks.onScopeSupport("unsupported");
        callbacks.onConnectionStatus("closed", {
          kind: "fatalError",
          details: {
            code: "INCOMPATIBLE",
            reason: "host does not advertise resources.subscribe",
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        });
        return { close: () => undefined };
      },
    });

    expect(handle.store.getState().scopeSupport).toBe("unsupported");
    expect(handle.store.getState().connectionStatus).toBe("closed");

    handle.dispose();
  });

  it("reads unknown with no global entry to ask", () => {
    expect(resourcesRegistry.getGlobalScopeSupport("host-a")).toBe("unknown");
  });

  it("repeats the verdict for the host the stream was opened against", () => {
    const fake = makeFakeClient();
    resourcesRegistry.acquireGlobal("token-a", "host-a", () =>
      createResourcesStore({
        scope: { kind: "global" },
        streamClientFactory: fake.factory,
      }),
    );
    fake.callbacks().onScopeSupport("unsupported");

    expect(resourcesRegistry.getGlobalScopeSupport("host-a")).toBe(
      "unsupported",
    );
  });

  // The entry is a module singleton that outlives a swap, so the verdict it
  // holds routinely belongs to the machine we just STOPPED watching. Repeating
  // it for whoever asks would print "cannot report its processes" under the
  // name of a host that never said any such thing.
  it("refuses to repeat one host's verdict for another", () => {
    const fake = makeFakeClient();
    resourcesRegistry.acquireGlobal("token-a", "host-a", () =>
      createResourcesStore({
        scope: { kind: "global" },
        streamClientFactory: fake.factory,
      }),
    );
    fake.callbacks().onScopeSupport("unsupported");

    expect(resourcesRegistry.getGlobalScopeSupport("host-b")).toBe("unknown");
  });

  // Two unnamed things are not the same thing. An entry whose mount could not
  // name its host, asked about a scope that has not resolved one either, would
  // match on `null === null` and convict a machine neither side identified.
  // Following the ACTIVE host nothing on screen names a machine, so no
  // incompatible notice is shown — the surface just renders the projection. An
  // `@1.0` host's global entry outranks the per-epic fallback purely by
  // existing, so leaving it in place publishes emptiness from a stream that
  // will never carry anything, while the per-epic streams on the very same
  // transport hold that host's real numbers. That read as "Waiting for resource
  // data." forever.
  it("falls back to the per-epic entries when the global stream cannot serve the scope", () => {
    const globalFake = makeFakeClient();
    const epicFake = makeFakeClient();
    resourcesRegistry.acquireGlobal("token-global", "host-a", () =>
      createResourcesStore({
        scope: { kind: "global" },
        streamClientFactory: globalFake.factory,
      }),
    );
    resourcesRegistry.acquire("epic-1", "token-epic", "host-a", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-1" },
        streamClientFactory: epicFake.factory,
      }),
    );
    epicFake.callbacks().onSnapshot(
      projection({
        sampledAt: 1_000,
        owners: [makeOwner("terminal", "term-1", { cpuPercent: 11 })],
      }),
    );

    // While the global stream has not judged itself, it still owns the answer -
    // and it is empty, because an `@1.0` host answered about `__global__`.
    expect(resourcesRegistry.getGlobalProjection().owners).toHaveLength(0);

    globalFake.callbacks().onScopeSupport("unsupported");

    const projected = resourcesRegistry.getGlobalProjection();
    expect(projected.owners).toHaveLength(1);
    expect(projected.owners[0].cpuPercent).toBe(11);
    expect(projected.hostId).toBe("host-a");
  });

  it("does not match an unnamed entry to an unnamed claim", () => {
    const fake = makeFakeClient();
    resourcesRegistry.acquireGlobal("token-a", null, () =>
      createResourcesStore({
        scope: { kind: "global" },
        streamClientFactory: fake.factory,
      }),
    );
    fake.callbacks().onScopeSupport("unsupported");

    expect(resourcesRegistry.getGlobalScopeSupport(null)).toBe("unknown");
  });
});
