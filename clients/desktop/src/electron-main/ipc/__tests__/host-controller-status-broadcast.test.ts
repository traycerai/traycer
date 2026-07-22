import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcHostController } from "../runner-ipc-bridge";
import type {
  HostControllerStatus,
  MutationLaneStatus,
  MutationProgress,
} from "../../host/host-controller-types";
import {
  onHostControllerStatusBroadcast,
  registerHostControllerStatusBroadcast,
  type HostControllerStatusBroadcastBridge,
} from "../host-controller-status-broadcast";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function fakeStatus(
  download: HostControllerStatus["download"],
): HostControllerStatus {
  return {
    download,
    mutation: null,
    installedVersion: "1.4.0",
    latestVersion: "1.4.0",
    stagedVersion: null,
    installedRuntimeVersion: null,
    runningRuntimeVersion: null,
    updateReady: false,
    activation: "activated",
    reachable: true,
    removedByUser: false,
    checkedAt: new Date().toISOString(),
  };
}

// The broadcaster only exercises `getStatus`, `onMutationProgress`, and
// optionally `onMutationStatus` (`hasMutationStatus` feature-detects it at
// runtime); every other `IpcHostController` member is stubbed to throw so
// the fake stays honestly typed without asserting.
// `emitProgress`/`emitMutationStatus` drive the module under test the
// same way `HostController`'s real observers would.
type FakeHostController = IpcHostController & {
  status: HostControllerStatus;
  getStatusError: Error | null;
  getStatusCallCount(): number;
  emitProgress(): void;
  emitMutationStatus(status: MutationLaneStatus | null): void;
};

function notUsedByBroadcaster(): never {
  throw new Error("not used by the status broadcaster");
}

function fakeHostController(withMutationStatus: boolean): FakeHostController {
  const progressListeners = new Set<(progress: MutationProgress) => void>();
  const mutationStatusListeners = new Set<
    (status: MutationLaneStatus | null) => void
  >();
  let statusReads = 0;
  const base: FakeHostController = {
    status: fakeStatus(null),
    getStatusError: null,
    getStatusCallCount(): number {
      return statusReads;
    },
    async getStatus(): Promise<HostControllerStatus> {
      statusReads += 1;
      if (base.getStatusError !== null) throw base.getStatusError;
      return base.status;
    },
    convergeReady: notUsedByBroadcaster,
    stageLatest: notUsedByBroadcaster,
    applyStaged: notUsedByBroadcaster,
    activateInstalled: notUsedByBroadcaster,
    installVersion: notUsedByBroadcaster,
    registerService: notUsedByBroadcaster,
    deregisterService: notUsedByBroadcaster,
    respawn: notUsedByBroadcaster,
    recoverIfDown: notUsedByBroadcaster,
    freePortAndRestart: notUsedByBroadcaster,
    uninstallHost: notUsedByBroadcaster,
    removeTraycer: notUsedByBroadcaster,
    isPendingRevisionRefreshQuarantined: notUsedByBroadcaster,
    onMutationProgress(
      listener: (progress: MutationProgress) => void,
    ): () => void {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },
    emitProgress(): void {
      const progress: MutationProgress = {
        stage: null,
        percent: null,
        bytes: null,
        totalBytes: null,
        message: null,
      };
      for (const listener of progressListeners) listener(progress);
    },
    emitMutationStatus(status: MutationLaneStatus | null): void {
      for (const listener of mutationStatusListeners) listener(status);
    },
  };
  if (!withMutationStatus) {
    return base;
  }
  const withStatusObserver: FakeHostController & {
    onMutationStatus(
      listener: (status: MutationLaneStatus | null) => void,
    ): () => void;
  } = {
    ...base,
    onMutationStatus(
      listener: (status: MutationLaneStatus | null) => void,
    ): () => void {
      mutationStatusListeners.add(listener);
      return () => {
        mutationStatusListeners.delete(listener);
      };
    },
  };
  return withStatusObserver;
}

function fakeBridge(
  hostController: IpcHostController,
): HostControllerStatusBroadcastBridge & {
  readonly fanOutCalls: Array<readonly [string, unknown]>;
} {
  const fanOutCalls: Array<readonly [string, unknown]> = [];
  return {
    options: { hostController },
    disposeFns: [],
    fanOut(channel: string, payload: unknown): void {
      fanOutCalls.push([channel, payload]);
    },
    fanOutCalls,
  };
}

function dispose(bridge: { readonly disposeFns: Array<() => void> }): void {
  for (const fn of bridge.disposeFns) fn();
}

describe("registerHostControllerStatusBroadcast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not broadcast on registration - every surface primes itself via its own getStatus/getStatus-after-probe read", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);

    registerHostControllerStatusBroadcast(bridge);
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.fanOutCalls).toHaveLength(0);
  });

  it("broadcasts the current status to every window when HostController reports mutation progress", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);

    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.fanOutCalls).toHaveLength(1);
    expect(bridge.fanOutCalls[0]).toEqual([
      "runnerHost:event:host:controllerStatusChange",
      hostController.status,
    ]);
  });

  it("also broadcasts on onMutationStatus ticks when the controller exposes it", async () => {
    const hostController = fakeHostController(true);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);

    hostController.emitMutationStatus(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.fanOutCalls).toHaveLength(1);
  });

  it("does not publish an older status read after a newer mutation tick has settled", async () => {
    const progressListeners = new Set<() => void>();
    const resolvers: Array<(status: HostControllerStatus) => void> = [];
    const hostController = {
      getStatus: () =>
        new Promise<HostControllerStatus>((resolve) => {
          resolvers.push(resolve);
        }),
      onMutationProgress(listener: () => void): () => void {
        progressListeners.add(listener);
        return () => progressListeners.delete(listener);
      },
      emitProgress(): void {
        for (const listener of progressListeners) listener();
      },
    } as IpcHostController & { emitProgress(): void };
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);

    hostController.emitProgress();
    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvers).toHaveLength(2);

    const newer = { ...fakeStatus(null), stagedVersion: "2.0.0" };
    resolvers[1]!(newer);
    await vi.advanceTimersByTimeAsync(0);
    resolvers[0]!(fakeStatus(null));
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.fanOutCalls).toEqual([
      ["runnerHost:event:host:controllerStatusChange", newer],
    ]);
  });

  it("registers without throwing when the controller does not expose onMutationStatus", () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);

    expect(() => registerHostControllerStatusBroadcast(bridge)).not.toThrow();
  });

  it("delivers the same ticks to in-process listeners registered via onHostControllerStatusBroadcast", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);
    const received: HostControllerStatus[] = [];
    onHostControllerStatusBroadcast(bridge, (status) => {
      received.push(status);
    });

    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);

    expect(received).toEqual([hostController.status]);
  });

  it("an in-process listener that throws does not stop the fan-out or crash the broadcast", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);
    const secondListenerCalls: HostControllerStatus[] = [];
    onHostControllerStatusBroadcast(bridge, () => {
      throw new Error("listener boom");
    });
    onHostControllerStatusBroadcast(bridge, (status) => {
      secondListenerCalls.push(status);
    });

    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.fanOutCalls).toHaveLength(1);
    expect(secondListenerCalls).toHaveLength(1);
  });

  it("falls back to the idle poll floor when nothing else triggers a tick", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(bridge.fanOutCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("starts active polling while a download is in flight and stops once it clears", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);

    hostController.status = fakeStatus({
      version: "1.5.0",
      progress: null,
      lastError: null,
    });
    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstTick = bridge.fanOutCalls.length;

    // Active-download cadence (750ms) is tighter than the idle floor (5s) -
    // advancing by ~2.5 active intervals should produce multiple more ticks
    // without waiting anywhere near the idle floor.
    await vi.advanceTimersByTimeAsync(1_900);
    expect(bridge.fanOutCalls.length).toBeGreaterThan(afterFirstTick + 1);

    hostController.status = fakeStatus(null);
    const afterDownloadCleared = bridge.fanOutCalls.length;
    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);

    // One more tick lands (the emitProgress that cleared `download`), then
    // active polling must have stopped - advancing well past its old cadence
    // produces no further ticks until the idle floor.
    const afterClearTick = bridge.fanOutCalls.length;
    expect(afterClearTick).toBeGreaterThan(afterDownloadCleared);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(bridge.fanOutCalls.length).toBe(afterClearTick);
  });

  it("uses the idle poll floor after a terminal download error", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);
    hostController.status = fakeStatus({
      version: "1.5.0",
      progress: null,
      lastError: "download failed",
    });

    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);
    const afterError = bridge.fanOutCalls.length;
    await vi.advanceTimersByTimeAsync(1_900);

    expect(bridge.fanOutCalls).toHaveLength(afterError);
  });

  it("disposing stops both timers and the extra-listener registration", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);
    const received: HostControllerStatus[] = [];
    onHostControllerStatusBroadcast(bridge, (status) => {
      received.push(status);
    });

    dispose(bridge);
    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(bridge.fanOutCalls).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it("warns and does not throw or broadcast when getStatus rejects", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);
    hostController.getStatusError = new Error("controller unreachable");

    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.fanOutCalls).toHaveLength(0);
  });

  it("falls back to the idle cadence when getStatus keeps failing during active polling", async () => {
    const hostController = fakeHostController(false);
    const bridge = fakeBridge(hostController);
    registerHostControllerStatusBroadcast(bridge);
    hostController.status = fakeStatus({
      version: "1.5.0",
      progress: null,
      lastError: null,
    });

    // Engage the 750ms active cadence via an in-flight download tick.
    hostController.emitProgress();
    await vi.advanceTimersByTimeAsync(0);

    // The next active tick observes the failure and must drop the tight
    // cadence rather than keep hammering an unhealthy controller.
    hostController.getStatusError = new Error("controller unreachable");
    await vi.advanceTimersByTimeAsync(750);
    const readsAfterFailure = hostController.getStatusCallCount();

    // Still short of the 5s idle floor: an intact active timer would have
    // produced several more reads here.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(hostController.getStatusCallCount()).toBe(readsAfterFailure);
  });
});
