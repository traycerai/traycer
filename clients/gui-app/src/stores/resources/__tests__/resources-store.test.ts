import { afterEach, describe, expect, it } from "vitest";
import type {
  AppResourceSnapshotWire,
  EpicResourceSnapshotWire,
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  OwnerResourceSnapshotWire,
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
  over: Partial<OwnerResourceSnapshotWire>,
): OwnerResourceSnapshotWire {
  return {
    owner: { kind, hostId: "host-1", epicId: "epic-1", ownerId },
    sampledAt: 1_000,
    rootPids: [1],
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
    expect(state.taskSummary?.cpuPercent).toBe(12);
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
    expect(state.taskSummary).toBeNull();
    handle.dispose();
  });

  it("derives a task summary from the live owner projection", () => {
    const fake = makeFakeClient();
    const handle = createResourcesStore({
      scope: { kind: "epic", epicId: "epic-1" },
      streamClientFactory: fake.factory,
    });

    fake.callbacks().onSnapshot(
      projection({
        owners: [
          makeOwner("terminal", "term-1", {
            rootPids: [101],
            processCount: 3,
            cpuPercent: 10,
            rssBytes: 100,
          }),
          makeOwner("terminal", "term-2", {
            rootPids: [201],
            processCount: 1,
            cpuPercent: 5,
            rssBytes: 200,
          }),
          makeOwner("terminal-agent", "agent-1", {
            rootPids: [301, 302],
            processCount: 4,
            cpuPercent: 7,
            rssBytes: 300,
          }),
          makeOwner("chat", "chat-1", {
            rootPids: [401],
            processCount: 2,
            cpuPercent: 3,
            rssBytes: 400,
          }),
        ],
      }),
    );

    expect(handle.store.getState().taskSummary).toEqual({
      cpuPercent: 25,
      rssBytes: 1_000,
      trackedProcessCount: 10,
      openTerminalCount: 2,
      tuiAgentCount: 1,
      guiAgentCount: 1,
    });
    handle.dispose();
  });

  it("includes host app usage in the task summary totals", () => {
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
    expect(handle.store.getState().taskSummary).toMatchObject({
      cpuPercent: 12,
      rssBytes: 600,
      trackedProcessCount: 3,
      openTerminalCount: 1,
    });
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
      resourcesRegistry.acquire(token.id, token, () =>
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

    const handleA = resourcesRegistry.acquire("epic-1", "token-a", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-1" },
        streamClientFactory: first.factory,
      }),
    );
    const handleB = resourcesRegistry.acquire("epic-1", "token-b", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-1" },
        streamClientFactory: second.factory,
      }),
    );

    expect(handleB).not.toBe(handleA);
    expect(first.isClosed()).toBe(true);
    expect(resourcesRegistry.get("epic-1")).toBe(handleB);
  });

  it("aggregates live entries globally and charges the app snapshot only once", () => {
    const first = makeFakeClient();
    const second = makeFakeClient();
    resourcesRegistry.acquire("epic-1", "token-a", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: "epic-1" },
        streamClientFactory: first.factory,
      }),
    );
    resourcesRegistry.acquire("epic-2", "token-b", () =>
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
    expect(global.app?.sampledAt).toBe(2_000);
    expect(global.summary).toMatchObject({
      cpuPercent: 20,
      rssBytes: 1_100,
      trackedProcessCount: 5,
      openTerminalCount: 1,
      tuiAgentCount: 0,
      guiAgentCount: 1,
    });
  });
});
