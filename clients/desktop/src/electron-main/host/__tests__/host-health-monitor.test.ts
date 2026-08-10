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

import {
  startHostHealthMonitor,
  type HostHealthMonitor,
} from "../host-health-monitor";
import {
  BREAKER_MAX_CONSECUTIVE_GRANTS,
  createHostRecoveryGovernor,
  RESPAWN_BACKOFF_MS,
  SUSTAINED_HEALTH_MS,
  type HostProcessLiveness,
} from "../host-recovery-governor";
import { HostRecoveryDeferredError } from "../../startup/host-health-respawn";
import { __setAsyncProcessLivenessReaderForTest } from "../process-identity";

const INTERVAL_MS = 1_000;

// Derived from the governor's own constants, not re-guessed here, so a
// retuned backoff or sustained-health window can't silently desync these
// waits from what they are meant to cross.
const BACKOFF_TICKS =
  Math.ceil(RESPAWN_BACKOFF_MS[RESPAWN_BACKOFF_MS.length - 1] / INTERVAL_MS) +
  20;
const SUSTAINED_TICKS = Math.ceil(SUSTAINED_HEALTH_MS / INTERVAL_MS) + 20;

const DEAD = (): Promise<HostProcessLiveness> => Promise.resolve("dead");
const ALIVE = (): Promise<HostProcessLiveness> => Promise.resolve("alive");

/**
 * These suites predate the recovery governor and exercise the monitor against
 * a host whose process is GONE - the genuinely dead case they were written
 * for, and the one where a respawn is the right answer.
 */
function startMonitor(deps: {
  readonly host: IpcHostLifecycle;
  readonly intervalMs: number;
  readonly probe: (websocketUrl: string) => Promise<boolean>;
  readonly readMetadata: (
    path: string,
  ) => Promise<DesktopLocalHostSnapshot | null>;
  readonly respawn: () => Promise<void>;
}): HostHealthMonitor {
  return startHostHealthMonitor({
    host: deps.host,
    intervalMs: deps.intervalMs,
    probe: deps.probe,
    readMetadata: deps.readMetadata,
    respawn: deps.respawn,
    governor: createHostRecoveryGovernor({
      readLiveness: DEAD,
      now: undefined,
    }),
    readLiveness: DEAD,
  });
}

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
    identityEnrollmentFile: "/fake/identity/enrollment.json",
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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

  it("still converges on a replacement host whose own process is alive", async () => {
    // Same supervisor-respawn as above, but with the liveness gate in play. The
    // gate asks about whatever pid.json currently holds - which here is the
    // REPLACEMENT, alive and healthy - while the snapshot the renderer is
    // pointed at names the dead predecessor. Reading "alive" as "the snapshot's
    // host is merely busy" would hold the stale snapshot for the whole
    // unreachable-demote window, leaving the renderer on a dead endpoint for ten
    // minutes when a reload converges it on the next tick.
    const replacement: DesktopLocalHostSnapshot = {
      ...SNAPSHOT,
      pid: SNAPSHOT.pid + 1,
      websocketUrl: "ws://127.0.0.1:55556/rpc",
    };
    const reload = vi.fn(async () => replacement);
    const respawn = vi.fn(async () => {});
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => SNAPSHOT,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async (url: string) => url === replacement.websocketUrl),
      readMetadata: vi.fn(async () => replacement),
      respawn,
      governor: createHostRecoveryGovernor({
        readLiveness: ALIVE,
        now: undefined,
      }),
      readLiveness: ALIVE,
    });

    await ticks(2);
    expect(reload).toHaveBeenCalledTimes(1);
    // Converging is the whole point - the replacement is healthy and must not
    // be restarted, and neither must the predecessor be resurrected.
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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
    const monitor = startMonitor({
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

    // The first attempt is lock-deferred: another Traycer process held the
    // lock, so the host was never touched and the budget must be refunded -
    // the retry that follows is immediate rather than paced behind a backoff
    // it did not earn.
    await ticks(3);
    expect(respawn).toHaveBeenCalledTimes(2);

    // From here the attempts are real failures, so they are paced. Retry
    // ownership survives the null snapshot (without it, every later tick
    // returns at the null-snapshot arm and the dead host is never retried),
    // but the budget still runs out.
    await ticks(1_600);
    expect(respawn).toHaveBeenCalledTimes(6);
    await ticks(1_000);
    expect(respawn).toHaveBeenCalledTimes(6);
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
    const monitor = startMonitor({
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

  it("paces repeated respawns instead of restarting on every confirmed outage", async () => {
    const respawn = vi.fn(async () => {});
    const monitor = startMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: vi.fn(async () => null) }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });
    // First outage restarts immediately - the overwhelmingly common case is a
    // host that really is dead.
    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    // Everything inside the first backoff window is refused, however many
    // outages are confirmed in it.
    await ticks(30);
    expect(respawn).toHaveBeenCalledTimes(1);
    // Past the window, one more is allowed.
    await ticks(32);
    expect(respawn).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("does NOT re-arm the respawn budget on a single successful probe", async () => {
    // The v1.1.8-rc.2 restart loop was infinite for exactly this reason: every
    // freshly spawned host answered one probe before stalling again, which
    // reset the budget, so the attempt counter never advanced past its first
    // value and the loop had no end. Recovery must be SUSTAINED to count.
    const respawn = vi.fn(async () => {});
    let reachable = false;
    const monitor = startMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => reachable),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });

    // Drive five paced respawns, each separated by its backoff, with a single
    // successful probe in between - the shape of the incident.
    for (
      let attempt = 0;
      attempt < BREAKER_MAX_CONSECUTIVE_GRANTS;
      attempt += 1
    ) {
      reachable = false;
      await ticks(BACKOFF_TICKS);
      reachable = true;
      await ticks(1);
    }
    expect(respawn).toHaveBeenCalledTimes(5);

    // Sixth confirmed outage: the budget is spent, so recovery belongs to the
    // user's Retry rather than to another restart.
    reachable = false;
    await ticks(BACKOFF_TICKS);
    expect(respawn).toHaveBeenCalledTimes(5);
    monitor.dispose();
  });

  it("clears the budget once the host stays reachable for the sustained window", async () => {
    const respawn = vi.fn(async () => {});
    let reachable = false;
    const monitor = startMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => reachable),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
    });

    // Spend the budget down to a TRIPPED breaker first. Asserting from a merely
    // paced state proves nothing: enough time passes to satisfy the backoff
    // anyway, so the next respawn happens whether or not sustained health
    // forgave anything. From a tripped breaker, only forgiveness can.
    for (
      let attempt = 0;
      attempt < BREAKER_MAX_CONSECUTIVE_GRANTS;
      attempt += 1
    ) {
      reachable = false;
      await ticks(BACKOFF_TICKS);
      reachable = true;
      await ticks(1);
    }
    reachable = false;
    await ticks(BACKOFF_TICKS);
    expect(respawn).toHaveBeenCalledTimes(5);

    // A genuinely recovered host: reachable continuously past the sustained
    // window, which forgives the spent attempts and re-arms recovery.
    reachable = true;
    await ticks(SUSTAINED_TICKS);
    reachable = false;
    // Two ticks: just enough to confirm one outage, so this counts the grant
    // the re-armed budget allowed rather than however many a long window fits.
    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(6);
    monitor.dispose();
  });

  it("holds the snapshot and does not respawn while the host process is alive", async () => {
    // The incident in one test: a host mid-epic-open answers no probe, but its
    // process is plainly still there. It must not be restarted - and, just as
    // important, its snapshot must not be demoted, or the user watches a
    // healthy session flip to "host unavailable" for the length of the open.
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => null);
    const liveness = vi.fn(ALIVE);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: reload }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
      governor: createHostRecoveryGovernor({
        readLiveness: ALIVE,
        now: undefined,
      }),
      readLiveness: liveness,
    });

    await ticks(60);
    expect(liveness).toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("surfaces manual recovery after a long unreachable stretch but still refuses to kill it", async () => {
    // Alive, but nothing has answered for far longer than any epic open. The
    // renderer gets its unavailable card so Retry is reachable; the decision to
    // actually kill a running process stays with the user.
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => null);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: reload }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
      governor: createHostRecoveryGovernor({
        readLiveness: ALIVE,
        now: undefined,
      }),
      readLiveness: ALIVE,
    });

    // Inside the window: held, no demote.
    await ticks(300);
    expect(reload).not.toHaveBeenCalled();

    // Past 10 minutes of continuous unreachability: demote for Retry, but the
    // process is still never killed.
    await ticks(400);
    expect(reload).toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("stops re-probing a demoted host whose process is still alive", async () => {
    // Once demoted with a living process, recovery belongs to the user - the
    // answer cannot change until the process exits or Retry is pressed. Asking
    // every tick is not free: each liveness probe spawns a child process (`ps`,
    // or `tasklist` + `powershell` on Windows), so an afternoon-long wedge would
    // spawn thousands for an answer nobody is waiting on.
    const respawn = vi.fn(async () => {});
    let snapshot: DesktopLocalHostSnapshot | null = SNAPSHOT;
    // One spy for both readers, so this counts total probes the way the machine
    // pays for them.
    const readLiveness = vi.fn(ALIVE);
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: vi.fn(async () => {
          snapshot = null; // the demote the renderer sees
          return null;
        }),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
      governor: createHostRecoveryGovernor({
        readLiveness,
        now: undefined,
      }),
      readLiveness,
    });

    // Past the demote window, so the snapshot is gone and every later tick lands
    // in the null-snapshot arm - the one that used to ask on every pass.
    await ticks(700);
    const atDemote = readLiveness.mock.calls.length;

    // Four more minutes of unchanged wedge. Ungated this is one probe per tick.
    await ticks(240);
    expect(readLiveness.mock.calls.length - atDemote).toBeLessThanOrEqual(4);
    // Still never killed, which is the point of holding at all.
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("respawns once the process is gone, proving 'alive' is not a permanent shield", async () => {
    const respawn = vi.fn(async () => {});
    let liveness: HostProcessLiveness = "alive";
    const readLiveness = (): Promise<HostProcessLiveness> =>
      Promise.resolve(liveness);
    const monitor = startHostHealthMonitor({
      host: fakeHost({ reloadSnapshotFromDisk: vi.fn(async () => null) }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
      governor: createHostRecoveryGovernor({
        readLiveness,
        now: undefined,
      }),
      readLiveness,
    });

    await ticks(10);
    expect(respawn).not.toHaveBeenCalled();
    // The process exited - or its pid was recycled onto something unrelated.
    liveness = "dead";
    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("stops probing after dispose", async () => {
    const probe = vi.fn(async () => true);
    const monitor = startMonitor({
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
