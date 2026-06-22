import { EventEmitter } from "node:events";
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

// `inAppLaunchAgentPlistPath` reads `process.resourcesPath` synchronously
// inside `registerHostLoginItem` for log attribution. Electron's types
// declare it `readonly string`, so we mutate via `defineProperty` to bypass
// the readonly check at runtime (the test environment is plain Node, where
// the property doesn't exist at all by default). The exact value doesn't
// matter — nothing asserted reads it back.
//
// `bootoutStaleAgent` gates its `/bin/launchctl bootout` subprocess on
// `process.platform === "darwin"`. In a real test process that condition
// holds and the bootout would touch the user's actual launchd domain,
// which is a real side effect we must not produce. Force the platform
// off-darwin for the duration of these tests so the bootout is a clean
// no-op. The 5 `runLaunchctlBootout` tests exercise the spawn-side
// behavior directly via an injected stub spawn — they don't need the
// platform gate to be true.
let originalResourcesPath: PropertyDescriptor | undefined;
let originalPlatform: PropertyDescriptor | undefined;
beforeAll(() => {
  originalResourcesPath = Object.getOwnPropertyDescriptor(
    process,
    "resourcesPath",
  );
  Object.defineProperty(process, "resourcesPath", {
    value: "/tmp/traycer-test/Contents/Resources",
    writable: true,
    configurable: true,
  });
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: "linux",
    writable: true,
    configurable: true,
  });
});
afterAll(() => {
  if (originalResourcesPath === undefined) {
    delete (process as { resourcesPath?: string }).resourcesPath;
  } else {
    Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  }
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

interface LoginItemSettings {
  readonly status: string | undefined;
}
interface SetLoginItemSettingsOptions {
  readonly openAtLogin: boolean;
}
const setLoginItemSettings =
  vi.fn<(opts: SetLoginItemSettingsOptions) => void>();
const getLoginItemSettings = vi.fn<() => LoginItemSettings>();

vi.mock("electron", () => ({
  app: {
    setLoginItemSettings: (opts: SetLoginItemSettingsOptions): void =>
      setLoginItemSettings(opts),
    getLoginItemSettings: (): LoginItemSettings => getLoginItemSettings(),
  },
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

// The module under test reads `config.environment` at import time via its
// `labelForEnvironment` import - make sure the config layer resolves to
// something defined for the tests.
vi.mock("../../../config", () => ({
  config: { environment: "production" },
  isDevBuild: false,
}));

interface FakeChildHandle {
  readonly child: EventEmitter & { kill: (signal: string) => boolean };
  readonly killCalls: ReadonlyArray<string>;
  fireExit(): void;
  fireError(err: Error): void;
}

function makeFakeChild(): FakeChildHandle {
  const killCalls: string[] = [];
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    kill: (signal: string): boolean => {
      killCalls.push(signal);
      return true;
    },
  });
  return {
    child,
    killCalls,
    fireExit: () => {
      child.emit("exit", 0, null);
    },
    fireError: (err: Error) => {
      child.emit("error", err);
    },
  };
}

// Imported AFTER the mocks so module-init evaluates against them.
const { registerHostLoginItem, readHostLoginItemStatus, runLaunchctlBootout } =
  await import("../host-login-item");

beforeEach(() => {
  // `mockReset` (not `mockClear`) so persistent implementations set
  // via `mockReturnValue` / `mockImplementation` in one test don't
  // leak into the next. The "normalizes unknown" test uses
  // `mockReturnValue({ status: "something-new" })` without `Once`;
  // without a reset, a later test's `mockReturnValueOnce` would
  // fall back to that stale value once its one-shots are consumed.
  setLoginItemSettings.mockReset();
  getLoginItemSettings.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerHostLoginItem", () => {
  it("calls setLoginItemSettings twice - openAtLogin:false then openAtLogin:true - to force BTM to refresh its cached LWCR before re-registering", async () => {
    // 1st read: post-unregister status; 2nd: first post-register read
    // (which returns 'enabled' so the BTM-commit poll exits immediately).
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    const status = await registerHostLoginItem();

    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
    });
    expect(setLoginItemSettings.mock.calls[1]?.[0]).toMatchObject({
      openAtLogin: true,
    });
    expect(status).toBe("enabled");
  });

  it("returns the post-register status verbatim so callers can branch on `requires-approval`", async () => {
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });
    getLoginItemSettings.mockReturnValueOnce({ status: "requires-approval" });

    await expect(registerHostLoginItem()).resolves.toBe("requires-approval");
  });

  it("normalizes unknown / missing `status` values to `not-registered` so callers fail closed instead of treating an unknown state as success", async () => {
    // First read clears prior registration; subsequent reads keep returning
    // an unknown shape so the BTM-commit poll exhausts its deadline.
    getLoginItemSettings.mockReturnValue({ status: "something-new" });

    await expect(registerHostLoginItem()).resolves.toBe("not-registered");
  });

  it("retries the post-register status read for the BTM-commit lag - a transient `not-registered` immediately followed by `enabled` resolves to `enabled` instead of failing closed", async () => {
    // unregister read, then 3x transient `not-registered`, then `enabled`.
    // The retry loop must persist until the BTM database has committed.
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // post-unregister
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // initial post-register
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // retry 1
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // retry 2
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" }); // committed

    await expect(registerHostLoginItem()).resolves.toBe("enabled");
  });

  it("surfaces `not-registered` instead of throwing when `setLoginItemSettings` itself throws - the boundary catch keeps Electron API errors from poisoning the renderer", async () => {
    setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("SMAppService bridge said no");
    });
    // No getLoginItemSettings mock needed - the throw on the first
    // setLoginItemSettings short-circuits before any status read.

    await expect(registerHostLoginItem()).resolves.toBe("not-registered");
  });
});

describe("runLaunchctlBootout", () => {
  // The BTM-clearing side effect happens server-side in launchd as
  // soon as the bootout RPC is received — exit code is the signal
  // that tells us whether the RPC was actually issued, but the
  // mutation has already taken place by the time launchctl returns.
  // These tests pin the argv shape, the exit-code classification
  // (success / "not loaded" no-op / unexpected failure), and the
  // failure-mode safety net (timeout kill, error event).

  it("invokes `/bin/launchctl bootout <target>` with `stdio: ignore` so output never leaks into the Electron main process", async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
    queueMicrotask(() => {
      fake.fireExit();
    });

    await runLaunchctlBootout("gui/501/ai.traycer.host.staging", spawnFn);

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn.mock.calls[0]?.[0]).toBe("/bin/launchctl");
    expect(spawnFn.mock.calls[0]?.[1]).toEqual([
      "bootout",
      "gui/501/ai.traycer.host.staging",
    ]);
    expect(spawnFn.mock.calls[0]?.[2]).toEqual({ stdio: "ignore" });
  });

  it("resolves cleanly when launchctl exits 0 — agent was loaded and is now gone", async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
    queueMicrotask(() => {
      fake.fireExit();
    });

    await runLaunchctlBootout("gui/501/test.label", spawnFn);

    expect(fake.killCalls).toHaveLength(0);
  });

  it("treats exit codes 3 / 5 / 113 as 'not loaded' no-ops — clean-machine bootout has nothing to clear and that's success", async () => {
    for (const code of [3, 5, 113]) {
      const fake = makeFakeChild();
      const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
      queueMicrotask(() => {
        fake.child.emit("exit", code, null);
      });

      await expect(
        runLaunchctlBootout("gui/501/test.label", spawnFn),
      ).resolves.toBeUndefined();
    }
  });

  it("resolves (never throws) when the child emits an error event — degrades to the pre-fix behavior rather than failing the register cycle", async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
    queueMicrotask(() => {
      fake.fireError(new Error("ENOENT"));
    });

    await expect(
      runLaunchctlBootout("gui/501/test.label", spawnFn),
    ).resolves.toBeUndefined();
  });

  it("kills the child with SIGTERM once the timeout elapses — a wedged launchctl cannot hold the register cycle hostage", async () => {
    vi.useFakeTimers();
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);

    const promise = runLaunchctlBootout("gui/501/test.label", spawnFn);
    // Advance past the 5s bootout timeout; the child never fires
    // exit or error, so only the setTimeout path can resolve us.
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(fake.killCalls).toContain("SIGTERM");
  });
});

describe("readHostLoginItemStatus", () => {
  it("does not mutate registration state", () => {
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    expect(readHostLoginItemStatus()).toBe("enabled");
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("returns `not-registered` instead of propagating when `getLoginItemSettings` throws", () => {
    getLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("BTM database is sad");
    });

    expect(readHostLoginItemStatus()).toBe("not-registered");
  });
});
