import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopPublishedHostSnapshot } from "../../../ipc-contracts/host-types";
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
  ) => Promise<DesktopPublishedHostSnapshot | null>;
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

const SNAPSHOT: DesktopPublishedHostSnapshot = {
  hostId: "host-1",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
  version: "1.0.0",
  pid: process.pid,
  systemHostName: "test-host",
  displayName: "Test Host",
  availability: "available",
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
    noteEndpointAnswered: vi.fn(),
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
    const replacement: DesktopPublishedHostSnapshot = {
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
    const staleSnapshot: DesktopPublishedHostSnapshot = {
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
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
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
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
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
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
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
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
    const metadataGate = deferred<DesktopPublishedHostSnapshot | null>();
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

  it("never demotes a live host, however long it stays unreachable (int #48)", async () => {
    // The 2026-08-11 regression guard, and the exact inversion of what this
    // test used to assert. It used to require a demote after
    // UNREACHABLE_DEMOTE_MS so the renderer would offer a Retry card. A demote
    // tells the renderer the host is GONE, and on 2026-08-11 that verdict -
    // against a host answering RPCs in milliseconds - locked every chat on the
    // machine read-only for two hours. Liveness is the authority: while the
    // process is there, the monitor holds, forever if need be.
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

    // Well past the old ten-minute escalation, and then some.
    await ticks(700);
    expect(reload).not.toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("throttles the liveness re-read while holding a live host busy", async () => {
    // The hold is now unbounded, so the cost guard that used to live behind the
    // demote has to live inside the hold itself: each liveness probe spawns a
    // child process (`ps`, or `tasklist` + `powershell` on Windows), and an
    // afternoon-long stall would otherwise spawn one every other tick forever.
    const respawn = vi.fn(async () => {});
    // One spy for both readers, so this counts total probes the way the machine
    // pays for them.
    const readLiveness = vi.fn(ALIVE);
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

    // Settle into the hold.
    await ticks(700);
    const atHold = readLiveness.mock.calls.length;

    // Four more minutes of unchanged wedge. Ungated this is one probe every
    // other tick (~120); throttled it is a handful.
    await ticks(240);
    expect(readLiveness.mock.calls.length - atHold).toBeLessThanOrEqual(4);
    expect(respawn).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("hands a successful probe back to the lifecycle so a busy verdict can recover", async () => {
    // The recovery half of int #48. Probes against the wedged host succeeded
    // continuously for two hours on 2026-08-11 while the renderer was still
    // being told the host was gone: nothing carried the success back to the
    // component that owns the verdict.
    const noteEndpointAnswered = vi.fn();
    let reachable = false;
    const monitor = startMonitor({
      host: fakeHost({ noteEndpointAnswered }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => reachable),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn: vi.fn(async () => {}),
    });

    await ticks(2);
    expect(noteEndpointAnswered).not.toHaveBeenCalled();

    reachable = true;
    await ticks(1);
    expect(noteEndpointAnswered).toHaveBeenCalled();
    monitor.dispose();
  });

  it("re-reads the disk while the snapshot is null so the state is never terminal", async () => {
    // A null snapshot with nothing scheduled to re-examine it is the shape of
    // the two-hour wedge: the pid-file watcher is edge-triggered on WRITES, so
    // a host that is already up and never rewrites pid.json produces no edge.
    // This arm used to return immediately - "recovery belongs to other flows" -
    // which is true of RESTARTING the host and not of looking at the disk.
    const reload = vi.fn(async () => null);
    const monitor = startMonitor({
      host: fakeHost({
        getSnapshot: () => null,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => null),
      respawn: vi.fn(async () => {}),
    });

    await ticks(3);
    expect(reload).toHaveBeenCalled();
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
