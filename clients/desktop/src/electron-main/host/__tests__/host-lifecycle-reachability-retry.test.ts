import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

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

vi.mock("../../cli/traycer-cli", () => ({
  streamTraycerCliJson: vi.fn(async () => ({ data: {} })),
}));

import { HostLifecycle, PRODUCTION_LABEL } from "../host-lifecycle";
import {
  __setAsyncProcessLivenessReaderForTest,
  type ProcessLivenessVerdict,
} from "../process-identity";
import type { DesktopLocalHostSnapshot } from "../../../ipc-contracts/host-types";
import type { HostFsLayout } from "../host-paths";

// The retry scenarios use a stable synthetic pid while the test controls the
// endpoint probe. A platform liveness probe has no positive result for that
// pid, so model the indeterminate branch locally: the handshake remains
// authoritative while a positively dead/recycled pid is rejected elsewhere.
function useIndeterminateProcessLiveness(): () => void {
  const restore = __setAsyncProcessLivenessReaderForTest(
    async () => "indeterminate",
  );
  return () => __setAsyncProcessLivenessReaderForTest(restore);
}

/** The ladder's first rung, mirrored from `host-lifecycle.ts`. */
const REACHABILITY_RETRY_INITIAL_MS_FOR_TEST = 250;

/**
 * Lets the REAL work a fired ladder timer starts actually finish.
 * `advanceTimersByTimeAsync` only drains microtasks, and a reload does real
 * libuv-threadpool filesystem reads (`pid.json`, host-name settings) - so the
 * probe fires, and the NEXT ladder rung is re-armed, only after real
 * event-loop turns whose count depends on machine load. A fixed number of
 * turns is therefore a race on a slow CI runner; instead, yield real turns
 * until the reload has observably settled: the expected probe count was
 * reached AND the ladder re-armed its next fake timer. These tests never call
 * `bootstrap()` (no watcher, no readiness wait), so the ladder owns the only
 * fake `setTimeout` and `vi.getTimerCount()` is exactly "next rung armed".
 * The deadline reads `performance.now()` because `Date` is faked here.
 */
async function settleLadderReload(probeSettled: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!(probeSettled() && vi.getTimerCount() > 0)) {
    if (performance.now() > deadline) {
      throw new Error("settleLadderReload: reload did not settle in time");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met in time");
    }
    await sleep(25);
  }
}

function layoutIn(dir: string): HostFsLayout {
  return {
    rootDir: dir,
    pidMetadataFile: join(dir, "pid.json"),
    identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
    logFile: join(dir, "host.log"),
    installDir: join(dir, "install"),
    installRecordFile: join(dir, "install", "install.json"),
    stagedDir: join(dir, "staged"),
    stagedRecordFile: join(dir, "staged", "staged.json"),
    pendingLoginItemRevisionFile: join(dir, "pending-login-item-revision.json"),
    substrateFile: join(dir, "substrate.json"),
    transitionJournalFile: join(dir, "transition.json"),
    environment: "production" as const,
  };
}

const PID_METADATA = JSON.stringify({
  hostId: "3be7933d-bcaa-478b-b914-e625b5d2a777",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
  version: "production.1784044433971.435b4f59c",
  pid: 18841,
});

/** The same endpoint published by a DIFFERENT process - a replacement host. */
const REPLACEMENT_PID_METADATA = JSON.stringify({
  hostId: "3be7933d-bcaa-478b-b914-e625b5d2a777",
  websocketUrl: "ws://127.0.0.1:55555/rpc",
  version: "production.1784044433971.435b4f59c",
  pid: 4242,
});

/**
 * A liveness reader that COUNTS, which is what makes the identity throttle
 * observable: `getPublishedProcessIdentityVerdict` asks liveness first and
 * every verdict read therefore lands here exactly once. In production the same
 * read continues into a child process (`ps` / `tasklist` + `powershell`) - the
 * cost the throttle exists to bound.
 */
function countingProcessLiveness(verdictOf: () => ProcessLivenessVerdict): {
  readonly reads: () => number;
  readonly restore: () => void;
} {
  let reads = 0;
  const previous = __setAsyncProcessLivenessReaderForTest(() => {
    reads += 1;
    return Promise.resolve(verdictOf());
  });
  return {
    reads: () => reads,
    restore: () => __setAsyncProcessLivenessReaderForTest(previous),
  };
}

/**
 * Regression guard for the 2026-07-14 incident (production desktop log,
 * first launch after a reinstall): bootstrap timed out with HOST_NOT_READY,
 * the host then published pid.json and became reachable 7s later - and the
 * snapshot stayed null for the rest of the session because the pid.json
 * watcher is edge-triggered on file WRITES while reachability is
 * time-varying. A single probe failure at the only watcher edge used to be
 * terminal ("Bound host is offline" on every chat until an app restart).
 *
 * The fix is the retry-until-reachable ladder in `reloadSnapshot`: whenever
 * pid metadata exists but its endpoint didn't answer, a backoff timer keeps
 * re-probing until the endpoint answers (or the metadata disappears).
 */
describe("HostLifecycle reachability retry ladder", () => {
  it(
    "converges after the host outlives a failed probe at the only watcher " +
      "edge, then stops probing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-"));
      const layout = layoutIn(dir);
      let probeResult = false;
      let probeCalls = 0;
      const lifecycle = new HostLifecycle({
        layout,
        bundledBinaryPath: null,
        label: PRODUCTION_LABEL,
        readyTimeoutMs: 300,
        reachabilityProbe: async () => {
          probeCalls += 1;
          return probeResult;
        },
      });
      const restoreLiveness = useIndeterminateProcessLiveness();
      const changes: (DesktopLocalHostSnapshot | null)[] = [];
      lifecycle.on("change", (snapshot: DesktopLocalHostSnapshot | null) => {
        changes.push(snapshot);
      });
      const errors: { code: string }[] = [];
      lifecycle.on("error", (err: { code: string }) =>
        errors.push({ code: err.code }),
      );

      try {
        // The incident's opening state: app boots while the host is down.
        await lifecycle.bootstrap({ hostInstalled: true });
        expect(errors).toEqual([{ code: "HOST_NOT_READY" }]);
        expect(lifecycle.getSnapshot()).toBeNull();

        // Host publishes pid.json, but the probe fails at the watcher edge
        // (a just-spawned host exceeding the 750ms connect budget). The
        // process is live, so the host is published as BUSY rather than
        // withheld - int #48. Withholding it is what let the registry twin
        // stand in as a hardcoded-unavailable row and lock every chat.
        await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
        await waitUntil(() => lifecycle.getSnapshot() !== null, 10_000);
        expect(lifecycle.getSnapshot()?.availability).toBe("busy");
        expect(lifecycle.getSnapshot()?.hostId).toBe(
          "3be7933d-bcaa-478b-b914-e625b5d2a777",
        );
        expect(changes.at(-1)?.pid).toBe(18841);

        // The host is now genuinely reachable. No further fs event will
        // fire - only the retry ladder can converge. The ladder has to be
        // armed by the DEGRADED verdict, not by a null snapshot, which is the
        // state that no longer occurs here.
        probeResult = true;
        await waitUntil(
          () => lifecycle.getSnapshot()?.availability === "available",
          10_000,
        );

        // Convergence clears the ladder: no further probes fire once the
        // snapshot is available (the max retry delay is 5s, so a lingering
        // timer would show up well within this window).
        const settledCalls = probeCalls;
        await sleep(1_200);
        expect(probeCalls).toBe(settledCalls);
      } finally {
        restoreLiveness();
        lifecycle.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("clears the ARMED ladder on a deliberate stop and never resurfaces the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-"));
    const layout = layoutIn(dir);
    let reachable = false;
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: async () => {
        probeCalls += 1;
        return reachable;
      },
    });
    const changes: (DesktopLocalHostSnapshot | null)[] = [];
    lifecycle.on("change", (snapshot: DesktopLocalHostSnapshot | null) => {
      changes.push(snapshot);
    });
    lifecycle.on("error", () => {});

    try {
      // pid.json is present but the endpoint refuses: bootstrap times out and
      // the ladder ARMS, so this test actually exercises the clear path (the
      // previous version left the probe reachable, so no ladder ever armed and
      // deleting the clear would not have failed it).
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await lifecycle.bootstrap({ hostInstalled: true });
      expect(lifecycle.getSnapshot()).toBeNull();
      await waitUntil(() => probeCalls >= 2, 5_000);

      // `traycer host stop` unlinks pid.json on graceful teardown. Even if an
      // unrelated process now answers on that port, an ABSENT file must clear
      // the ladder and never resurface a host the user deliberately stopped.
      await unlink(layout.pidMetadataFile);
      reachable = true;
      await sleep(1_500);
      expect(lifecycle.getSnapshot()).toBeNull();
      expect(changes.every((snapshot) => snapshot === null)).toBe(true);
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * The tests above drive the ladder through real `fs.watch` edges. These
 * exercise the retry PREDICATE directly - no `bootstrap()`, no watcher - by
 * calling `reloadSnapshotFromDisk()` ourselves and advancing fake timers, so a
 * regression that made the predicate arm/clear on the wrong condition fails
 * here even if a stray watcher edge would otherwise have masked it.
 */
describe("HostLifecycle reachability retry ladder (predicate, no bootstrap)", () => {
  it("converges via the retry timer when malformed metadata becomes valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-direct-"));
    const layout = layoutIn(dir);
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: async () => {
        probeCalls += 1;
        return true;
      },
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    try {
      // Malformed: present but INDETERMINATE, not absent - the ladder must
      // arm without ever reaching the probe (there is no URL to probe yet).
      await writeFile(layout.pidMetadataFile, '{"hostId":"partial', "utf8");
      const first = await lifecycle.reloadSnapshotFromDisk();
      expect(first).toBeNull();
      expect(probeCalls).toBe(0);

      // The file becomes valid before the armed timer fires. Only the
      // ladder's own scheduled reload can pick this up - bootstrap()/the
      // watcher were never installed in this test.
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await waitUntil(() => lifecycle.getSnapshot() !== null, 8_000);
      expect(lifecycle.getSnapshot()?.hostId).toBe(
        "3be7933d-bcaa-478b-b914-e625b5d2a777",
      );
      expect(probeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("clears on absence and does not resurface a later valid file without a new reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-retry-direct-"));
    const layout = layoutIn(dir);
    let reachable = false;
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: async () => {
        probeCalls += 1;
        return reachable;
      },
    });
    try {
      // Parsed but unreachable: arms the ladder.
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      const first = await lifecycle.reloadSnapshotFromDisk();
      expect(first).toBeNull();
      await waitUntil(() => probeCalls >= 1, 5_000);

      // Deliberate stop before the next armed reload: it must observe an
      // absent file and clear, not reschedule.
      await unlink(layout.pidMetadataFile);
      await sleep(1_000);
      expect(lifecycle.getSnapshot()).toBeNull();

      // A later valid, reachable file appears - but with the ladder cleared
      // and no watcher installed (bootstrap() was never called), nothing
      // re-reads it. The snapshot must stay null; only an explicit reload (a
      // real watcher event in production) would surface it.
      reachable = true;
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await sleep(1_500);
      expect(lifecycle.getSnapshot()).toBeNull();
    } finally {
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * The ladder's re-probe is cheap; the IDENTITY read behind it is not - it
 * spawns a child process. Since int #48 the busy hold no longer expires, so a
 * host that wedges for an afternoon keeps the ladder running at its 5s cap for
 * as long as the wedge lasts: ~720 spawns an hour, for an answer that changes
 * at most once. The health monitor already throttles this exact cost at 120s
 * (`ALIVE_RECHECK_INTERVAL_MS`); these pin the same shape here.
 *
 * Time is faked, timers are not advanced: every reload below is driven
 * explicitly, so what is counted is the throttle's decision and never a ladder
 * tick that happened to fire.
 */
describe("HostLifecycle process-identity throttle", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.useRealTimers();
  });

  async function lifecycleWithSilentEndpoint(
    probeAnswers: () => boolean,
  ): Promise<{
    readonly lifecycle: HostLifecycle;
    readonly probeCalls: () => number;
    readonly dir: string;
  }> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-identity-"));
    const layout = layoutIn(dir);
    await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: () => {
        probeCalls += 1;
        return Promise.resolve(probeAnswers());
      },
    });
    cleanups.push(() => lifecycle.dispose());
    cleanups.push(() => {
      void rm(dir, { recursive: true, force: true });
    });
    return { lifecycle, probeCalls: () => probeCalls, dir };
  }

  it("asks the OS about the published process at most once per window while the endpoint stays silent", async () => {
    const identity = countingProcessLiveness(() => "alive");
    cleanups.push(identity.restore);
    const { lifecycle, probeCalls } = await lifecycleWithSilentEndpoint(
      () => false,
    );

    const startedAt = Date.now();
    for (let tick = 0; tick < 5; tick += 1) {
      vi.setSystemTime(startedAt + tick * 20_000);
      await lifecycle.reloadSnapshotFromDisk();
    }

    // Every tick still probes the endpoint - that is the cheap half, and it is
    // what converges the verdict. Only the child-process read is throttled.
    expect(probeCalls()).toBe(5);
    expect(identity.reads()).toBe(1);
    expect(lifecycle.getSnapshot()?.availability).toBe("busy");

    // Bounded, not abandoned: past the window the OS is asked afresh, so a host
    // that dies while wedged is still noticed within one interval.
    vi.setSystemTime(startedAt + 200_000);
    await lifecycle.reloadSnapshotFromDisk();
    expect(identity.reads()).toBe(2);
  });

  it("never serves a cached verdict on a probe that ANSWERED", async () => {
    const identity = countingProcessLiveness(() => "alive");
    cleanups.push(identity.restore);
    let answers = false;
    const { lifecycle } = await lifecycleWithSilentEndpoint(() => answers);

    await lifecycle.reloadSnapshotFromDisk();
    await lifecycle.reloadSnapshotFromDisk();
    expect(identity.reads()).toBe(1);

    // The identity check is the only thing between an impostor listener on the
    // host's port and a published `available`, so the handshake path always
    // asks the OS itself - no cache, whatever the window says.
    answers = true;
    await lifecycle.reloadSnapshotFromDisk();
    expect(identity.reads()).toBe(2);
    expect(lifecycle.getSnapshot()?.availability).toBe("available");
  });

  it("re-reads a DEAD process every tick - a positive death is never cached", async () => {
    const identity = countingProcessLiveness(() => "dead");
    cleanups.push(identity.restore);
    const { lifecycle } = await lifecycleWithSilentEndpoint(() => false);

    for (let tick = 0; tick < 3; tick += 1) {
      await lifecycle.reloadSnapshotFromDisk();
    }

    // `dead`/`mismatch` are what `readPublishedHostPresence` turns into
    // `absent`, and absence is positive evidence with no hysteresis behind it -
    // it must never come from a cache. It is also free: a dead pid loses the
    // liveness probe before any child process is spawned.
    expect(identity.reads()).toBe(3);
    expect(lifecycle.getSnapshot()).toBeNull();
  });
});

/**
 * `readPidMetadataState` separates "the file is gone" from "I could not read
 * it". Only the first is evidence about the HOST; the second is a failed
 * observation, and folding it as `absent` runs it through the one arm of
 * `foldHostAvailability` with no hysteresis at all - momentarily publishing a
 * live host as dead over a transient EACCES/EIO or a read that landed
 * mid-write, faults which cluster with exactly the load that makes a host slow
 * to answer.
 */
describe("HostLifecycle pid.json read outcomes", () => {
  it("HOLDS the published verdict on an unreadable pid.json, and keeps the ladder armed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-indeterminate-"));
    const layout = layoutIn(dir);
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: () => Promise.resolve(true),
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const changes: (DesktopLocalHostSnapshot | null)[] = [];
    lifecycle.on("change", (snapshot: DesktopLocalHostSnapshot | null) => {
      changes.push(snapshot);
    });

    try {
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      expect((await lifecycle.reloadSnapshotFromDisk())?.availability).toBe(
        "available",
      );
      expect(changes).toHaveLength(1);

      // A partially-written file parses as invalid JSON: present, unreadable,
      // and saying nothing about the host that is still answering.
      await writeFile(layout.pidMetadataFile, '{"hostId":"partial', "utf8");
      const held = await lifecycle.reloadSnapshotFromDisk();

      expect(held?.pid).toBe(18841);
      expect(held?.availability).toBe("available");
      expect(lifecycle.getSnapshot()?.availability).toBe("available");
      // Nothing was published: the renderer never saw the live host blink out.
      expect(changes).toHaveLength(1);

      // The hold is temporary because the ladder was armed by it. No watcher is
      // installed here (bootstrap was never called), so a replacement host
      // surfacing on its own proves the timer, not an fs edge.
      await writeFile(layout.pidMetadataFile, REPLACEMENT_PID_METADATA, "utf8");
      await waitUntil(() => lifecycle.getSnapshot()?.pid === 4242, 8_000);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("still folds a CONFIRMED-absent pid.json to no host, immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-indeterminate-"));
    const layout = layoutIn(dir);
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: () => Promise.resolve(true),
    });
    const restoreLiveness = useIndeterminateProcessLiveness();
    const changes: (DesktopLocalHostSnapshot | null)[] = [];
    lifecycle.on("change", (snapshot: DesktopLocalHostSnapshot | null) => {
      changes.push(snapshot);
    });

    try {
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      await lifecycle.reloadSnapshotFromDisk();
      expect(lifecycle.getSnapshot()).not.toBeNull();

      // ENOENT is the one read outcome that IS about the host: `traycer host
      // stop` unlinks the file, and a stopped host must lock promptly rather
      // than serve out a hold (the 2026-08-08 two-slot lesson).
      await unlink(layout.pidMetadataFile);
      expect(await lifecycle.reloadSnapshotFromDisk()).toBeNull();
      expect(lifecycle.getSnapshot()).toBeNull();
      expect(changes.at(-1)).toBeNull();
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * `notifyRespawning` is a hand-written demotion: the caller knows the current
 * host is going away and a replacement is coming. The ladder it arms is the
 * only thing scheduled to find that replacement, so it has to start at the
 * BOTTOM - an arm that inherits the outage's own ratcheted delay makes the new
 * host's first probe wait up to the 5s cap.
 */
describe("HostLifecycle respawn re-arm", () => {
  it("re-arms the ladder at its initial delay when a respawn is announced", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-respawn-"));
    const layout = layoutIn(dir);
    let probeCalls = 0;
    const lifecycle = new HostLifecycle({
      layout,
      bundledBinaryPath: null,
      label: PRODUCTION_LABEL,
      readyTimeoutMs: 300,
      reachabilityProbe: () => {
        probeCalls += 1;
        return Promise.resolve(false);
      },
    });
    const restoreLiveness = useIndeterminateProcessLiveness();

    try {
      await writeFile(layout.pidMetadataFile, PID_METADATA, "utf8");
      // Walk the ladder up: 250ms, then 500ms, leaving a 1s timer pending.
      // Awaiting the reload settles it fully - probe fired, next rung armed -
      // so each advance below finds its timer already scheduled.
      await lifecycle.reloadSnapshotFromDisk();
      await vi.advanceTimersByTimeAsync(250);
      await settleLadderReload(() => probeCalls >= 2);
      await vi.advanceTimersByTimeAsync(500);
      await settleLadderReload(() => probeCalls >= 3);
      // Exactly one probe per rung: fake timers only fire inside an advance,
      // so nothing can have raced the count past 3 between settles.
      const beforeRespawn = probeCalls;
      expect(beforeRespawn).toBe(3);

      lifecycle.notifyRespawning();

      // The inherited 1s timer must have been replaced, not left to run out:
      // advancing only the INITIAL delay must fire a probe (the settle throws
      // if none does), and it must be exactly one.
      await vi.advanceTimersByTimeAsync(REACHABILITY_RETRY_INITIAL_MS_FOR_TEST);
      await settleLadderReload(() => probeCalls >= beforeRespawn + 1);
      expect(probeCalls).toBe(beforeRespawn + 1);
    } finally {
      restoreLiveness();
      lifecycle.dispose();
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
