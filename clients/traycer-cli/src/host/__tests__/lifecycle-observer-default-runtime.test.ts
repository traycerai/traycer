import {
  mkdirSync,
  rmSync,
  writeFileSync,
  type FSWatcher,
  type WatchListener,
} from "node:fs";
import { basename, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { hostHomeDir } from "../../store/paths";

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load, so without this the suite
// would resolve this machine's REAL `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(
        actual.tmpdir(),
        "traycer-lifecycle-observer-default-runtime-test-home-",
      ),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const ENVIRONMENT = "production";

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.useRealTimers();
});

describe("defaultLifecycleObserverRuntime.scheduleTicks", () => {
  // The first tick is scheduled via `setImmediate`, not called
  // synchronously inside `scheduleTicks`, and lands before any interval tick;
  // subsequent ticks then arrive every `intervalMs`.
  it("ticks once via setImmediate before any interval, then every intervalMs, and the canceller stops it", async () => {
    vi.useFakeTimers();
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    let calls = 0;
    const cancel = defaultLifecycleObserverRuntime.scheduleTicks(1_000, () => {
      calls += 1;
    });

    expect(calls).toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(4);

    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(4);
  });

  // Cancelling before the first immediate has fired must stop it too, not
  // only the interval.
  it("the canceller stops a still-pending first tick", async () => {
    vi.useFakeTimers();
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    let calls = 0;
    const cancel = defaultLifecycleObserverRuntime.scheduleTicks(1_000, () => {
      calls += 1;
    });
    cancel();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);
  });

  // NOT unref()ed - a retrying actuator must keep the process alive even
  // once the interval is the only thing left running.
  it("does not unref() the interval it arms", async () => {
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const cancel = defaultLifecycleObserverRuntime.scheduleTicks(10_000, () => {
      /* no-op */
    });
    try {
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const handle = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(true);
    } finally {
      cancel();
    }
  });
});

describe("defaultLifecycleObserverRuntime.watchHostHome", () => {
  // A 10 s timeout: the worst case below is 3 s of policy-write attempts,
  // the two settles and the 5 s presence deadline.
  it("ignores host.log writes but reacts to the policy and presence files", async () => {
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    const { hostLifecyclePolicyPath } =
      await import("@traycer/protocol/config/host-lifecycle-policy");
    const { desktopPresencePath } =
      await import("@traycer/protocol/config/desktop-presence");
    const home = hostHomeDir(ENVIRONMENT);
    mkdirSync(home, { recursive: true });

    let changes = 0;
    const watch = defaultLifecycleObserverRuntime.watchHostHome(
      ENVIRONMENT,
      () => {
        changes += 1;
      },
    );
    expect(watch).not.toBeNull();
    try {
      // Positive control: writing the policy file DOES notify. On macOS
      // `fs.watch` can return before its FSEvents stream is live, and a write
      // in that window is never reported (in production the observer's poll
      // picks it up), so the write repeats until the first notification
      // proves the watch is live. Each attempt waits 250 ms, generous against
      // FSEvents coalescing under load.
      const policyPath = hostLifecyclePolicyPath(home);
      for (let attempt = 1; changes === 0; attempt += 1) {
        if (attempt > 12) {
          throw new Error("the watch never reported a policy-file write");
        }
        writeFileSync(policyPath, "policy-write");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // One write can surface as two events on Linux (create plus modify);
      // let a late second event drain, then measure against that baseline.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const baseline = changes;

      // Negative, checked in a settle window after the positive control
      // above already proved the watch is live: host.log must NOT notify.
      // 1s, not 200ms: long enough to outlast FSEvents coalescing under load
      // without turning a real regression into a multi-second wait.
      writeFileSync(join(home, "host.log"), "log-line\n");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(changes).toBe(baseline);

      // The presence file notifies too.
      writeFileSync(desktopPresencePath(home), "presence-write");
      await waitFor(() => changes > baseline, 5_000);
    } finally {
      watch?.close();
    }
  }, 10_000);

  // One write that creates a file can surface as two watch events on Linux
  // (create plus modify), so the contract is at least one notification per
  // write, not exactly one.
  it("a write that surfaces as two events notifies at least once; host.log never notifies; an unnamed event does", async () => {
    let listener: WatchListener<string> | undefined;
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        watch: (...args: Parameters<typeof actual.watch>) => {
          const watcher = actual.watch(...args);
          listener = args[1];
          return watcher;
        },
      };
    });
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    const { hostLifecyclePolicyPath } =
      await import("@traycer/protocol/config/host-lifecycle-policy");
    const home = hostHomeDir(ENVIRONMENT);
    mkdirSync(home, { recursive: true });
    let changes = 0;
    const watch = defaultLifecycleObserverRuntime.watchHostHome(
      ENVIRONMENT,
      () => {
        changes += 1;
      },
    );
    try {
      if (listener === undefined) throw new Error("watch() was not called");
      const policy = basename(hostLifecyclePolicyPath(home));
      // Linux's shape for one write that creates the policy file.
      listener("rename", policy);
      listener("change", policy);
      expect(changes).toBeGreaterThanOrEqual(1);

      const beforeLog = changes;
      listener("rename", "host.log");
      listener("change", "host.log");
      expect(changes).toBe(beforeLog);

      listener("change", null);
      expect(changes).toBeGreaterThan(beforeLog);
    } finally {
      watch?.close();
    }
  });

  // An error on the underlying watcher marks the handle failed and closes
  // the watcher, so the observer re-arms a fresh one on its next tick.
  it("marks the watch failed and closes it when the underlying watcher errors", async () => {
    let capturedWatcher: FSWatcher | undefined;
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        watch: (...args: Parameters<typeof actual.watch>) => {
          const watcher = actual.watch(...args);
          capturedWatcher = watcher;
          return watcher;
        },
      };
    });
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    const home = hostHomeDir(ENVIRONMENT);
    mkdirSync(home, { recursive: true });

    const watch = defaultLifecycleObserverRuntime.watchHostHome(
      ENVIRONMENT,
      () => {
        /* no-op */
      },
    );
    expect(watch).not.toBeNull();
    expect(watch?.failed()).toBe(false);
    if (capturedWatcher === undefined) {
      throw new Error("watch() was not called");
    }
    const closeSpy = vi.spyOn(capturedWatcher, "close");

    capturedWatcher.emit("error", new Error("boom"));

    expect(watch?.failed()).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when the underlying watch throws", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        watch: () => {
          throw new Error("boom");
        },
      };
    });
    const { defaultLifecycleObserverRuntime } =
      await import("../lifecycle-observer");
    const home = hostHomeDir(ENVIRONMENT);
    mkdirSync(home, { recursive: true });

    expect(
      defaultLifecycleObserverRuntime.watchHostHome(ENVIRONMENT, () => {
        /* no-op */
      }),
    ).toBeNull();
  });
});

describe("defaultLifecycleObserverRuntime.processExists", () => {
  // The spawn-free existence check behind the `alive` memo. Spawning a
  // real child and awaiting its own `exit` event both proves a genuinely
  // reaped ("gone") pid and never touches `processExists` itself, so the
  // `node:child_process` wrappers below can start at zero calls and stay
  // there through both checks - `probeProcessExistenceWithoutSpawn` is a bare
  // `process.kill(pid, 0)`, not a spawn.
  it.skipIf(process.platform === "win32")(
    "reports exists for a live pid and gone for a reaped one, spawning nothing",
    async () => {
      const { spawn } = await import("node:child_process");
      const proc = spawn("true", []);
      const reapedPid = await new Promise<number>((resolve, reject) => {
        proc.once("spawn", () => {
          if (proc.pid === undefined) {
            reject(new Error("spawned process has no pid"));
            return;
          }
          resolve(proc.pid);
        });
        proc.once("error", reject);
      });
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
      });

      const calls = { execFileSync: 0, execFile: 0, spawn: 0, spawnSync: 0 };
      vi.doMock("node:child_process", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("node:child_process")>();
        return {
          ...actual,
          execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
            calls.execFileSync += 1;
            return actual.execFileSync(...args);
          },
          execFile: (...args: Parameters<typeof actual.execFile>) => {
            calls.execFile += 1;
            return actual.execFile(...args);
          },
          spawn: (...args: Parameters<typeof actual.spawn>) => {
            calls.spawn += 1;
            return actual.spawn(...args);
          },
          spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
            calls.spawnSync += 1;
            return actual.spawnSync(...args);
          },
        };
      });
      // `vi.resetModules()` again, AFTER the mock: the runtime's chain
      // (`@traycer-clients/shared/host-lock/process-identity`) can otherwise
      // still be the instance a prior test's import already resolved against
      // the real `node:child_process`, which would leave `calls` at 0 no
      // matter what `processExists` does.
      vi.resetModules();
      const { defaultLifecycleObserverRuntime } =
        await import("../lifecycle-observer");

      expect(defaultLifecycleObserverRuntime.processExists(process.pid)).toBe(
        "exists",
      );
      expect(defaultLifecycleObserverRuntime.processExists(reapedPid)).toBe(
        "gone",
      );

      expect(calls).toEqual({
        execFileSync: 0,
        execFile: 0,
        spawn: 0,
        spawnSync: 0,
      });
    },
  );
});

describe("lifecycle observer literals", () => {
  it("pins LIFECYCLE_OBSERVER_POLL_MS and LIFECYCLE_PRESENCE_CRASH_GRACE_MS", async () => {
    const { LIFECYCLE_OBSERVER_POLL_MS, LIFECYCLE_PRESENCE_CRASH_GRACE_MS } =
      await import("../lifecycle-observer");
    expect(LIFECYCLE_OBSERVER_POLL_MS).toBe(5_000);
    expect(LIFECYCLE_PRESENCE_CRASH_GRACE_MS).toBe(30_000);
  });
});
