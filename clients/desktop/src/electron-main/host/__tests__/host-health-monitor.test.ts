import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopLocalHostSnapshot } from "../../../ipc-contracts/host-types";
import type { IpcHostLifecycle } from "../../ipc/runner-ipc-bridge";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: (): string => "/fake/app/path" },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { startHostHealthMonitor } from "../host-health-monitor";
import { HostRecoveryDeferredError } from "../../startup/host-health-respawn";
import { __setAsyncProcessLivenessReaderForTest } from "../process-identity";

const INTERVAL_MS = 1_000;

const SNAPSHOT: DesktopLocalHostSnapshot = {
  hostId: "host-1",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
  version: "1.0.0",
  pid: process.pid,
  systemHostName: "test-host",
  displayName: "Test Host",
};

function fakeHost(overrides: Partial<IpcHostLifecycle>): IpcHostLifecycle {
  return {
    getSnapshot: () => SNAPSHOT,
    on: vi.fn(),
    off: vi.fn(),
    respawn: vi.fn(async () => {}),
    notifyRespawning: vi.fn(),
    pidMetadataFile: "/fake/pid.json",
    isDisposed: false,
    reloadSnapshotFromDisk: vi.fn(async () => null),
    ensureWatcherInstalled: vi.fn(),
    getRecentLogTail: vi.fn(async () => null),
    ...overrides,
  } as IpcHostLifecycle;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("startHostHealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function ticks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
  }

  it("respawns after two consecutive failed probes with pid metadata still on disk", async () => {
    const respawn = vi.fn(async () => {});
    const monitor = startHostHealthMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });
    await ticks(1);
    expect(respawn).not.toHaveBeenCalled();
    await ticks(1);
    expect(respawn).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("converges via reload instead of respawning when the disk names a reachable replacement", async () => {
    const respawn = vi.fn(async () => {});
    // The supervisor (launchd/systemd) already respawned the host on a new
    // port; the stale snapshot's endpoint is dead but a reload surfaces the
    // healthy replacement - restarting it would kill a live host.
    const reload = vi.fn(async () => SNAPSHOT);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: reload }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });
    await ticks(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("does not respawn a host stopped in the window between the outage and the reload (finding 3)", async () => {
    // The stop lands DURING recovery: pid.json is still present when the tick
    // begins, but the reload observes it gone. Deciding respawn off the stale
    // pre-reload read would resurrect a host the user deliberately stopped, so
    // the metadata that gates respawn must be read AFTER the reload.
    const respawn = vi.fn(async () => {});
    let stopped = false;
    const reload = vi.fn(async () => {
      stopped = true; // the `traycer host stop` unlink completes here
      return null;
    });
    const readMetadata = vi.fn(async () => (stopped ? null : SNAPSHOT));
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: reload }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata,
      respawn,
    });
    await ticks(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("does not respawn when a failure streak is broken by a healthy probe", async () => {
    const respawn = vi.fn(async () => {});
    let reachable = false;
    const monitor = startHostHealthMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => reachable),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });
    await ticks(1); // fail #1
    reachable = true;
    await ticks(1); // recovery resets the streak
    reachable = false;
    await ticks(1); // fail #1 again
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("F2: treats a handshake-reachable stale PID as down instead of resetting the recovery counters", async () => {
    const staleSnapshot: DesktopLocalHostSnapshot = {
      ...SNAPSHOT,
      pid: 999_999,
    };
    const restoreLiveness = __setAsyncProcessLivenessReaderForTest(
      async () => "dead",
    );
    const reload = vi.fn(async () => null);
    const respawn = vi.fn(async () => {});
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => staleSnapshot,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => true),
      readMetadata: vi.fn(async () => staleSnapshot),
      respawn,
    });

    try {
      await ticks(2);
      // The second outage reload demotes the stale snapshot; the recovery
      // attempt then performs its own reload-confirmation before relinquishing
      // ownership, so this is two reloads rather than a bare healthy reset.
      expect(reload).toHaveBeenCalledTimes(2);
      expect(respawn).toHaveBeenCalledTimes(1);
    } finally {
      monitor.dispose();
      __setAsyncProcessLivenessReaderForTest(restoreLiveness);
    }
  });

  it("treats missing pid metadata as a deliberate stop: demote, never respawn", async () => {
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => null);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: reload }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => null),
      respawn,
    });
    await ticks(2);
    expect(respawn).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("idles while the snapshot is null (recovery owned by ensure/respawn flows)", async () => {
    const probe = vi.fn(async () => false);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ getSnapshot: () => null }),
      intervalMs: INTERVAL_MS,
      probe,
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn: vi.fn(async () => {}),
    });
    await ticks(3);
    expect(probe).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("P5: retries a lock-deferred recovery after the monitor has demoted its snapshot", async () => {
    let snapshot: DesktopLocalHostSnapshot | null = SNAPSHOT;
    let respawnCalls = 0;
    const respawn = vi.fn(async () => {
      respawnCalls += 1;
      if (respawnCalls === 1) throw new HostRecoveryDeferredError();
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: vi.fn(async () => {
          snapshot = null;
          return null;
        }),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });

    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);

    await ticks(1);
    expect(respawn).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("F5: retains recovery ownership until a retry is followed by a reload-confirmed snapshot", async () => {
    let snapshot: DesktopLocalHostSnapshot | null = SNAPSHOT;
    let respawnCalls = 0;
    const reload = vi.fn(async () => {
      if (respawnCalls === 0) {
        snapshot = null;
        return null;
      }
      // A foreign actor brought the host up while the monitor's first
      // recovery was deferred. `recoverIfDown` can now return `ok` via its
      // head-of-lane recheck without reloading lifecycle itself.
      snapshot = SNAPSHOT;
      return SNAPSHOT;
    });
    const respawn = vi.fn(async () => {
      respawnCalls += 1;
      if (respawnCalls === 1) throw new HostRecoveryDeferredError();
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });

    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    expect(snapshot).toBeNull();

    await ticks(1);
    expect(respawn).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(snapshot).toBe(SNAPSHOT);
    monitor.dispose();
  });

  it("F6: counts generic retry failures while the monitor owns a null snapshot", async () => {
    let snapshot: DesktopLocalHostSnapshot | null = SNAPSHOT;
    let respawnCalls = 0;
    const respawn = vi.fn(async () => {
      respawnCalls += 1;
      if (respawnCalls === 1) throw new HostRecoveryDeferredError();
      throw new Error("restart failed");
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: vi.fn(async () => {
          snapshot = null;
          return null;
        }),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });

    // The first attempt is lock-deferred (not a restart). The next three
    // failed restart attempts consume the full recovery budget; tick six
    // must not initiate a fourth failed restart from the null-snapshot arm.
    await ticks(6);
    expect(respawn).toHaveBeenCalledTimes(4);
    monitor.dispose();
  });

  it("F13: does not start a null-snapshot retry after disposal during its metadata read", async () => {
    let snapshot: DesktopLocalHostSnapshot | null = SNAPSHOT;
    const metadataGate = deferred<DesktopLocalHostSnapshot | null>();
    let metadataReads = 0;
    let respawnCalls = 0;
    const respawn = vi.fn(async () => {
      respawnCalls += 1;
      if (respawnCalls === 1) throw new HostRecoveryDeferredError();
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: vi.fn(async () => {
          snapshot = null;
          return null;
        }),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => {
        metadataReads += 1;
        // F2 now reads published metadata on every positive-health decision:
        // tick one, tick two, and the post-demotion recovery decision all
        // observe the stable record. The next null-snapshot retry is gated.
        return metadataReads <= 3 ? SNAPSHOT : metadataGate.promise;
      }),
      respawn,
    });

    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    await ticks(1);
    expect(metadataReads).toBe(4);

    monitor.dispose();
    metadataGate.resolve(SNAPSHOT);
    await Promise.resolve();
    await Promise.resolve();
    expect(respawn).toHaveBeenCalledTimes(1);
  });

  it("stops auto-respawning after the budget is exhausted without a recovery", async () => {
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => null);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: reload }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });
    // Each confirmed outage takes 2 failed ticks; budget is 3 respawns.
    await ticks(8);
    expect(respawn).toHaveBeenCalledTimes(3);
    // Every attempted restart gets a second reload-confirmation before the
    // monitor releases ownership (four outage reloads + three confirmations).
    expect(reload).toHaveBeenCalledTimes(7);
    monitor.dispose();
  });

  it("resets the respawn budget once a probe succeeds", async () => {
    const respawn = vi.fn(async () => {});
    let reachable = false;
    const monitor = startHostHealthMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => reachable),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });
    await ticks(6); // three respawns, budget exhausted
    expect(respawn).toHaveBeenCalledTimes(3);
    reachable = true;
    await ticks(1); // recovery
    reachable = false;
    await ticks(2); // fresh outage after recovery
    expect(respawn).toHaveBeenCalledTimes(4);
    monitor.dispose();
  });

  it("stops probing after dispose", async () => {
    const probe = vi.fn(async () => true);
    const monitor = startHostHealthMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe,
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn: vi.fn(async () => {}),
    });
    await ticks(1);
    expect(probe).toHaveBeenCalledTimes(1);
    monitor.dispose();
    await ticks(3);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
