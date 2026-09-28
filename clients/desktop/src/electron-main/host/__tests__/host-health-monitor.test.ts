import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import electronLog from "electron-log";
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

import log from "electron-log";
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
import {
  HostRecoveryDeferredError,
  respawnIfDown,
} from "../../startup/host-health-respawn";
import { __setAsyncProcessLivenessReaderForTest } from "../process-identity";
import { HOST_NOT_SERVICE_RUN_MESSAGE } from "../host-controller-types";
import { FakeHostController } from "../../ipc/__tests__/fake-host-controller";

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
    automaticRecoverySuspended: () => false,
    governor: createHostRecoveryGovernor({
      readLiveness: DEAD,
      now: undefined,
    }),
    readLiveness: DEAD,
    readLiveSupervisorPid: () => Promise.resolve(null),
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

  it("makes no respawn and logs no WARN while automatic recovery is suspended, then respawns once when released", async () => {
    let suspended = true;
    const respawn = vi.fn(async () => {});
    vi.mocked(electronLog.warn).mockClear();
    const monitor = startHostHealthMonitor({
      host: fakeHost({}),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => SNAPSHOT),
      respawn,
      automaticRecoverySuspended: () => suspended,
      governor: createHostRecoveryGovernor({
        readLiveness: DEAD,
        now: undefined,
      }),
      readLiveness: DEAD,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });
    await ticks(6);
    expect(respawn).toHaveBeenCalledTimes(0);
    expect(electronLog.warn).toHaveBeenCalledTimes(0);
    // Ownership was kept: releasing the suspension resumes on the next tick.
    suspended = false;
    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    // Anchor for the zero above: the same path, unsuspended, does log the
    // "auto-respawning" WARN the gate exists to keep off every tick.
    expect(
      vi
        .mocked(electronLog.warn)
        .mock.calls.filter(([message]) =>
          String(message).includes("auto-respawning"),
        ),
    ).toHaveLength(1);
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
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({
        readLiveness: ALIVE,
        now: undefined,
      }),
      readLiveness: ALIVE,
      readLiveSupervisorPid: () => Promise.resolve(null),
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
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({
        readLiveness: ALIVE,
        now: undefined,
      }),
      readLiveness: liveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
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
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({
        readLiveness: ALIVE,
        now: undefined,
      }),
      readLiveness: ALIVE,
      readLiveSupervisorPid: () => Promise.resolve(null),
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
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({
        readLiveness,
        now: undefined,
      }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
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

  it("finds a host on disk without respawning when the backstop reload surfaces one", async () => {
    // The mirror of the test above: this time the backstop reload FINDS a
    // host, e.g. one whose pid.json edge the lossy watcher never delivered.
    // The reload's own `change` event carries convergence; this branch must
    // not decide to respawn, and its debug line is a discovery, not an
    // incident.
    const reload = vi.fn(async () => SNAPSHOT);
    const respawn = vi.fn(async () => {});
    const monitor = startMonitor({
      host: fakeHost({
        getSnapshot: () => null,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => null),
      respawn,
    });

    await ticks(1);

    expect(reload).toHaveBeenCalled();
    expect(respawn).not.toHaveBeenCalled();
    expect(vi.mocked(log.debug)).toHaveBeenCalledWith(
      "[host-health] null-snapshot backstop found a host on disk",
      { pid: SNAPSHOT.pid },
    );
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
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({
        readLiveness,
        now: undefined,
      }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    await ticks(10);
    expect(respawn).not.toHaveBeenCalled();
    // The process exited - or its pid was recycled onto something unrelated.
    liveness = "dead";
    await ticks(2);
    expect(respawn).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  /*
   * `isBusyRatherThanDown`'s long-stall coast
   * and the null-snapshot recovery throttle each had the SAME shape of
   * shield as `HostLifecycle`'s cached identity verdict
   * (`host-lifecycle-reachability-retry.test.ts`'s "process-identity
   * throttle" / "identity-verdict cache" suites) - up to `ALIVE_RECHECK_INTERVAL_MS`
   * (120s) reused on nothing but age. Both now also require
   * `probeProcessExistenceWithoutSpawn` to find the SAME pid still there
   * before coasting/throttling; the coast-defect and recovery-throttle-defect
   * cases pin the pid dying inside that window forcing a fresh read, the
   * coast-control and recovery-throttle-control cases pin the pid staying
   * alive keeping the coast/throttle in place.
   */
  it("coast defect - a pid that dies inside the long-stall throttle window forces a fresh liveness read instead of coasting busy", async () => {
    const MONITOR_TEST_PID = 33221;
    const monitorSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: MONITOR_TEST_PID,
    };
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let liveness: HostProcessLiveness = "alive";
    const readLiveness = vi.fn((): Promise<HostProcessLiveness> =>
      Promise.resolve(liveness),
    );
    const respawn = vi.fn(async () => {});
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => monitorSnapshot,
        reloadSnapshotFromDisk: vi.fn(async () => null),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => monitorSnapshot),
      respawn,
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    try {
      // Settle into the long-stall hold (past `UNREACHABLE_WARN_MS` = 600s),
      // which is what arms `nextLivenessCheckAt` and makes the coast
      // reachable at all.
      await ticks(700);
      const atHold = readLiveness.mock.calls.length;
      expect(respawn).not.toHaveBeenCalled();

      // The pid dies inside the throttle window: `process.kill` now reports
      // ESRCH, and a fresh liveness read would find the same pid gone too.
      killSpy.mockImplementation(() => {
        throw Object.assign(new Error("simulated ESRCH"), { code: "ESRCH" });
      });
      liveness = "dead";

      // Before the fix, `now < nextLivenessCheckAt` alone let the coast
      // return `true` (busy) without asking again - the exact
      // "reachable three times over 114s for a dead pid" finding. The probe
      // now gates the coast too, so this tick asks fresh, finds the death,
      // and the tick proceeds to recovery instead of holding busy.
      await ticks(2);
      expect(readLiveness.mock.calls.length).toBeGreaterThan(atHold);
      expect(respawn).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
  });

  it("coast control - a pid that stays alive keeps coasting inside the throttle window (no extra liveness read)", async () => {
    const MONITOR_TEST_PID = 33222;
    const monitorSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: MONITOR_TEST_PID,
    };
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const readLiveness = vi.fn((): Promise<HostProcessLiveness> =>
      Promise.resolve("alive"),
    );
    const respawn = vi.fn(async () => {});
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => monitorSnapshot,
        reloadSnapshotFromDisk: vi.fn(async () => null),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => monitorSnapshot),
      respawn,
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    try {
      await ticks(700);
      const atHold = readLiveness.mock.calls.length;

      // Unlike the coast-defect test above, the pid keeps existing for the rest of the window: the
      // coast must keep serving from it, with no further liveness read and
      // no respawn.
      await ticks(2);
      expect(readLiveness.mock.calls.length).toBe(atHold);
      expect(respawn).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
  });

  it("recovery-throttle defect - a pid that dies within the null-snapshot throttle window forces attemptRecovery on the next tick", async () => {
    // Kept different from `snapshot`'s pid for as long as `snapshot` is
    // non-null, so `isCurrentPublishedSnapshot` never matches and
    // `isBusyRatherThanDown` is never reached - this test isolates the
    // NULL-SNAPSHOT recovery throttle alone, not what the coast tests above
    // already cover.
    const METADATA_PID = 55221;
    const metadataSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: METADATA_PID,
    };
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let governorLiveness: HostProcessLiveness = "alive";
    const readLiveness = vi.fn((): Promise<HostProcessLiveness> =>
      Promise.resolve(governorLiveness),
    );
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => {
      snapshot = null;
      return null;
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => metadataSnapshot),
      respawn,
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    try {
      // Two confirmed failures demote the snapshot; the governor denies
      // "alive", which is what arms `nextRecoveryAttemptAt` and retains
      // recovery ownership (`recoveryPending`).
      await ticks(2);
      expect(snapshot).toBeNull();
      expect(respawn).not.toHaveBeenCalled();

      // Still within the throttle window, and the pid exists: the next tick
      // must stay throttled - the control half of this test. The throttle
      // must short-circuit BEFORE `attemptRecovery` reaches the governor,
      // so `readLiveness` (only ever called from inside
      // `governor.requestRespawn`) must not be called again either -
      // otherwise `respawn` staying uncalled would just be the governor
      // denying on its own "alive" answer, proving nothing about the
      // throttle itself.
      const readLivenessCallsAtThrottle = readLiveness.mock.calls.length;
      await ticks(1);
      expect(respawn).not.toHaveBeenCalled();
      expect(readLiveness.mock.calls.length).toBe(readLivenessCallsAtThrottle);

      // The pid dies inside the window.
      killSpy.mockImplementation(() => {
        throw Object.assign(new Error("simulated ESRCH"), { code: "ESRCH" });
      });
      governorLiveness = "dead";

      await ticks(1);
      expect(respawn).toHaveBeenCalledTimes(1);
      expect(readLiveness.mock.calls.length).toBeGreaterThan(
        readLivenessCallsAtThrottle,
      );
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
  });

  it("recovery-throttle control - a pid that stays alive keeps the null-snapshot throttle in place", async () => {
    const METADATA_PID = 55222;
    const metadataSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: METADATA_PID,
    };
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const readLiveness = vi.fn((): Promise<HostProcessLiveness> =>
      Promise.resolve("alive"),
    );
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => {
      snapshot = null;
      return null;
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => metadataSnapshot),
      respawn,
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    try {
      await ticks(2);
      expect(snapshot).toBeNull();
      expect(respawn).not.toHaveBeenCalled();

      // The pid keeps existing for several more ticks inside the window:
      // the throttle must hold, with no recovery attempt at all - and,
      // since `readLiveness` is only ever reached through the governor
      // inside `attemptRecovery`, its call count must stay flat too, or
      // `respawn` staying uncalled would just be the governor's own
      // "alive" denial rather than the throttle skipping recovery.
      const readLivenessCallsAtThrottle = readLiveness.mock.calls.length;
      await ticks(5);
      expect(respawn).not.toHaveBeenCalled();
      expect(readLiveness.mock.calls.length).toBe(readLivenessCallsAtThrottle);
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
  });

  /**
   * HM-clock: both `ALIVE_RECHECK_INTERVAL_MS` waits are wall-clock
   * deadlines - the busy shield's `nextLivenessCheckAt` in
   * `isBusyRatherThanDown`, and the null-snapshot recovery throttle's
   * `nextRecoveryAttemptAt`. A backward step of the wall clock past the
   * instant either wait was armed (a system clock sync, a suspend/resume, a
   * VM snapshot restore) would stretch that wait by the size of the step,
   * and for as long as the recycled pid keeps answering `exists` to the
   * cheap kill-based probe, the wait would coast on stale evidence instead
   * of forcing a fresh liveness read. `isInsideAliveRecheckWindow` guards
   * against that: it reads a deadline more than one
   * `ALIVE_RECHECK_INTERVAL_MS` interval ahead of `now` as itself expired,
   * the same rule already applied at `host-lifecycle.ts:717-722`.
   */
  it("busy-shield clock-step defect - a backward step past the arming instant expires the coast window early", async () => {
    const MONITOR_TEST_PID = 33223;
    const monitorSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: MONITOR_TEST_PID,
    };
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let liveness: HostProcessLiveness = "alive";
    const readLiveness = vi.fn((): Promise<HostProcessLiveness> =>
      Promise.resolve(liveness),
    );
    const respawn = vi.fn(async () => {});
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => monitorSnapshot,
        reloadSnapshotFromDisk: vi.fn(async () => null),
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => monitorSnapshot),
      respawn,
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    try {
      // Settle into the long-stall regime, which is what arms
      // `nextLivenessCheckAt` at all.
      await ticks(700);
      const atHold = readLiveness.mock.calls.length;

      // Tick forward one at a time until a fresh read happens: that tick's
      // read is what re-arms the deadline to `now + ALIVE_RECHECK_INTERVAL_MS`.
      // Capped well past one interval's worth of ticks so a change to the
      // cadence fails loudly instead of spinning forever.
      let rearmedAt = -1;
      for (let i = 0; i < 200; i += 1) {
        await ticks(1);
        if (readLiveness.mock.calls.length > atHold) {
          rearmedAt = i;
          break;
        }
      }
      expect(rearmedAt).toBeGreaterThanOrEqual(0);
      const callsAfterRearm = readLiveness.mock.calls.length;

      // Control: freshly armed, the coast serves from the deadline with no
      // further read and no respawn.
      await ticks(2);
      expect(readLiveness.mock.calls.length).toBe(callsAfterRearm);
      expect(respawn).not.toHaveBeenCalled();

      // The wall clock steps backward past the arming instant. `now` is
      // still before the deadline, but by more than one interval - so the
      // window is itself expired. The pid was reissued: the cheap
      // existence probe still answers `exists`, but a fresh full read
      // reports it gone.
      vi.setSystemTime(Date.now() - 60_000);
      liveness = "dead";

      // A backward step past the arming instant expires the window: the
      // next tick forces a fresh read rather than coasting on the stale
      // evidence, finds the death, and proceeds to recovery.
      await ticks(2);
      expect(readLiveness.mock.calls.length).toBeGreaterThan(callsAfterRearm);
      expect(respawn).toHaveBeenCalledTimes(1);
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
  });

  it("recovery-throttle clock-step defect - a backward step past the arming instant expires the throttle early", async () => {
    const METADATA_PID = 55223;
    const metadataSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: METADATA_PID,
    };
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    let governorLiveness: HostProcessLiveness = "alive";
    const readLiveness = vi.fn((): Promise<HostProcessLiveness> =>
      Promise.resolve(governorLiveness),
    );
    const respawn = vi.fn(async () => {});
    const reload = vi.fn(async () => {
      snapshot = null;
      return null;
    });
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => metadataSnapshot),
      respawn,
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid: () => Promise.resolve(null),
    });

    try {
      // Two confirmed failures demote the snapshot; the governor denies
      // "alive", which is what arms `nextRecoveryAttemptAt` and retains
      // recovery ownership (`recoveryPending`).
      await ticks(2);
      expect(snapshot).toBeNull();
      expect(respawn).not.toHaveBeenCalled();

      // Control: still freshly armed, the throttle serves from the
      // deadline with no further read and no respawn.
      const readLivenessCallsAtThrottle = readLiveness.mock.calls.length;
      await ticks(1);
      expect(respawn).not.toHaveBeenCalled();
      expect(readLiveness.mock.calls.length).toBe(readLivenessCallsAtThrottle);

      // The wall clock steps backward past the arming instant - `now` is
      // still before the deadline, but by more than one interval, so the
      // window is itself expired. The pid was reissued: the cheap
      // existence probe still answers `exists`, but the governor's own
      // liveness read now reports it gone.
      vi.setSystemTime(Date.now() - 60_000);
      governorLiveness = "dead";

      // A backward step past the arming instant expires the window: the
      // next tick forces a fresh recovery attempt rather than staying
      // throttled, and the governor's fresh "dead" read lets it respawn.
      await ticks(1);
      expect(respawn).toHaveBeenCalledTimes(1);
      expect(readLiveness.mock.calls.length).toBeGreaterThan(
        readLivenessCallsAtThrottle,
      );
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
  });

  /**
   * "The desktop leaves a host that a person started in a terminal
   * untouched." `recoverIfDown` resolving `{kind: "deferred", message:
   * HOST_NOT_SERVICE_RUN_MESSAGE}` means the CLI refused because a
   * terminal-started (foreground) supervisor owns the host - not lock
   * contention. `respawnIfDown` (`startup/host-health-respawn.ts`) now tells
   * that apart as `HostRecoveryNotServiceRunError`, and the monitor latches
   * `readLiveSupervisorPid`'s pid on that catch: further recovery ticks ask
   * for nothing while the SAME terminal-started supervisor still answers,
   * and resume the moment that pid is gone or replaced by a different one.
   */
  it("a not-service-run deferral holds recovery while the same terminal supervisor pid is live, and releases on pid change", async () => {
    const METADATA_PID = 66221;
    const metadataSnapshot: DesktopPublishedHostSnapshot = {
      ...SNAPSHOT,
      pid: METADATA_PID,
    };
    let snapshot: DesktopPublishedHostSnapshot | null = SNAPSHOT;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // The governor always grants: this scenario is about the CLI's own
    // refusal (not-service-run), not about the governor's alive/busy shield.
    const readLiveness = (): Promise<HostProcessLiveness> =>
      Promise.resolve("dead");
    const reload = vi.fn(async () => {
      snapshot = null;
      return null;
    });
    const recoverIfDown = vi.fn(
      async (): Promise<{ kind: "deferred"; message: string }> => ({
        kind: "deferred",
        message: HOST_NOT_SERVICE_RUN_MESSAGE,
      }),
    );
    // The real fake, with only the call this row drives replaced.
    const fakeController = new FakeHostController();
    fakeController.recoverIfDown = recoverIfDown;
    let liveSupervisorPid: number | null = 4242;
    const readLiveSupervisorPid = (): Promise<number | null> =>
      Promise.resolve(liveSupervisorPid);
    const monitor = startHostHealthMonitor({
      host: fakeHost({
        getSnapshot: () => snapshot,
        reloadSnapshotFromDisk: reload,
      }),
      intervalMs: INTERVAL_MS,
      probe: vi.fn(async () => false),
      readMetadata: vi.fn(async () => metadataSnapshot),
      respawn: () => respawnIfDown(fakeController),
      automaticRecoverySuspended: () => false,
      governor: createHostRecoveryGovernor({ readLiveness, now: undefined }),
      readLiveness,
      readLiveSupervisorPid,
    });

    try {
      // Two confirmed failures demote the snapshot and the first recovery
      // attempt runs: the governor grants (liveness is dead), `respawn`
      // resolves `recoverIfDown` once, and the not-service-run deferral
      // surfaces as `HostRecoveryNotServiceRunError`.
      await ticks(2);
      expect(snapshot).toBeNull();
      expect(recoverIfDown).toHaveBeenCalledTimes(1);

      // The hold: while the SAME terminal-started supervisor pid (4242) is
      // still live, further recovery ticks must not call `recoverIfDown`
      // again.
      await ticks(5);
      expect(recoverIfDown).toHaveBeenCalledTimes(1);

      // The supervisor pid goes away: normal ownership resumes and the very
      // next recovery tick calls `recoverIfDown` again.
      liveSupervisorPid = null;
      const callsBeforeRelease = recoverIfDown.mock.calls.length;
      await ticks(1);
      expect(recoverIfDown.mock.calls.length).toBeGreaterThan(
        callsBeforeRelease,
      );

      // Control: a DIFFERENT terminal-started supervisor pid (a new run)
      // also releases the hold - the next attempt runs, is refused again
      // (still not-service-run), and re-latches on the new pid.
      liveSupervisorPid = 5151;
      const callsAfterResume = recoverIfDown.mock.calls.length;
      await ticks(1);
      expect(recoverIfDown.mock.calls.length).toBeGreaterThan(callsAfterResume);
      const callsAfterRelatch = recoverIfDown.mock.calls.length;
      await ticks(5);
      expect(recoverIfDown.mock.calls.length).toBe(callsAfterRelatch);
    } finally {
      killSpy.mockRestore();
      monitor.dispose();
    }
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
