import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// `registerHostLoginItem` re-checks the removed-by-user sentinel inside the
// locked section (so a register queued behind an uninstall's unregister can
// never resurrect the login item). The real module reads a JSON store under
// Electron's `userData` path - stub the leaf boolean probe instead.
const isHostRemovedByUserMock = vi.fn<() => Promise<boolean>>();
vi.mock("../../host/host-removal-state", () => ({
  isHostRemovedByUser: () => isHostRemovedByUserMock(),
}));

// Marker-path seam: the REAL `getHostFsLayout` resolves under
// `os.homedir()`. An earlier revision of this file sandboxed that with a
// `process.env.HOME` override, which only holds when the runtime consults
// $HOME - node's `os.homedir()` does, Bun's does NOT - so a Bun-driven run
// of this suite would have pointed `registerHostLoginItem`'s real `rm` at
// the developer's actual `~/.traycer` marker. Mock the layout seam itself
// so no runtime's homedir semantics are in the trust chain at all. Only
// `getHostFsLayout` is stubbed; `labelForEnvironment` (module-init time)
// stays real.
vi.mock("../../host/host-paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../host/host-paths")>();
  return {
    ...actual,
    getHostFsLayout: (environment: string) =>
      buildTestHostFsLayout(environment),
  };
});

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
const {
  registerHostLoginItem,
  readHostLoginItemStatus,
  runLaunchctlBootout,
  hasPendingLoginItemRevision,
} = await import("../host-login-item");

// `registerHostLoginItem` clears the pending-login-item-revision marker via
// `getHostFsLayout(config.environment)` (config is mocked to "production"
// above). The layout is mocked (see the `host-paths` vi.mock rationale) to
// resolve under this per-test temp dir, so the real marker-file assertions
// below (and `registerHostLoginItem`'s real `rm` call) can never touch the
// invoking user's actual `~/.traycer` under ANY runtime.
let workHome: string;

function pendingRevisionMarkerPath(): string {
  return join(workHome, ".traycer", "host", "pending-login-item-revision.json");
}

function buildTestHostFsLayout(environment: string): {
  rootDir: string;
  pidMetadataFile: string;
  logFile: string;
  installDir: string;
  installRecordFile: string;
  pendingLoginItemRevisionFile: string;
  environment: string;
} {
  const rootDir = join(workHome, ".traycer", "host");
  return {
    rootDir,
    pidMetadataFile: join(rootDir, "pid.json"),
    logFile: join(rootDir, "host.log"),
    installDir: join(rootDir, "install"),
    installRecordFile: join(rootDir, "install", "install.json"),
    pendingLoginItemRevisionFile: pendingRevisionMarkerPath(),
    environment,
  };
}

function writePendingRevisionMarker(): void {
  const dir = join(workHome, ".traycer", "host");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    pendingRevisionMarkerPath(),
    JSON.stringify({ pending: true }),
    "utf8",
  );
}

beforeEach(() => {
  // `mockReset` (not `mockClear`) so persistent implementations set
  // via `mockReturnValue` / `mockImplementation` in one test don't
  // leak into the next. The "normalizes unknown" test uses
  // `mockReturnValue({ status: "something-new" })` without `Once`;
  // without a reset, a later test's `mockReturnValueOnce` would
  // fall back to that stale value once its one-shots are consumed.
  setLoginItemSettings.mockReset();
  getLoginItemSettings.mockReset();
  isHostRemovedByUserMock.mockReset().mockResolvedValue(false);
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-login-item-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(workHome, { recursive: true, force: true });
});

describe("registerHostLoginItem", () => {
  it("calls setLoginItemSettings twice - openAtLogin:false then openAtLogin:true - to force BTM to refresh its cached LWCR before re-registering", async () => {
    // 1st read: post-unregister status; 2nd: first post-register read
    // (which returns 'enabled' so the BTM-commit poll exits immediately).
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    const status = await registerHostLoginItem(undefined);

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

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "requires-approval",
    );
  });

  it("normalizes unknown / missing `status` values to `not-registered` so callers fail closed instead of treating an unknown state as success", async () => {
    // First read clears prior registration; subsequent reads keep returning
    // an unknown shape so the BTM-commit poll exhausts its deadline.
    getLoginItemSettings.mockReturnValue({ status: "something-new" });

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "not-registered",
    );
  });

  it("retries the post-register status read for the BTM-commit lag - a transient `not-registered` immediately followed by `enabled` resolves to `enabled` instead of failing closed", async () => {
    // unregister read, then 3x transient `not-registered`, then `enabled`.
    // The retry loop must persist until the BTM database has committed.
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // post-unregister
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // initial post-register
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // retry 1
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // retry 2
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" }); // committed

    await expect(registerHostLoginItem(undefined)).resolves.toBe("enabled");
  });

  it("surfaces `not-registered` instead of throwing when `setLoginItemSettings` itself throws - the boundary catch keeps Electron API errors from poisoning the renderer", async () => {
    setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("SMAppService bridge said no");
    });
    // No getLoginItemSettings mock needed - the throw on the first
    // setLoginItemSettings short-circuits before any status read.

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "not-registered",
    );
  });

  it("refuses the whole cycle with `removed-by-user` when the removal sentinel is set - no SMAppService mutation runs at all", async () => {
    // The sentinel is re-read inside the locked section, so a register that
    // queued behind an uninstall's unregister sees the removal and cannot
    // re-create the BTM login item ("Remove Traycer" must stay removed).
    isHostRemovedByUserMock.mockResolvedValue(true);

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "removed-by-user",
    );
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(getLoginItemSettings).not.toHaveBeenCalled();
  });

  it("refuses the cycle with `deferred-busy` when the caller's revalidation guard fails once the cycle is dequeued - no SMAppService mutation runs, exactly like the removed-by-user refusal", async () => {
    // Proves the fix for the "revalidate the idle gate after acquiring the
    // lock" finding: a caller's own busy-check can go stale while queued
    // behind another cycle on the shared registration lock, so the guard is
    // re-run INSIDE the locked section, immediately before the bootout that
    // would otherwise kill a host that picked up work while queued.
    const revalidate = vi.fn().mockResolvedValue(false);

    await expect(registerHostLoginItem(revalidate)).resolves.toBe(
      "deferred-busy",
    );
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(getLoginItemSettings).not.toHaveBeenCalled();
  });

  it("proceeds with the cycle when the revalidation guard passes", async () => {
    const revalidate = vi.fn().mockResolvedValue(true);
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    await expect(registerHostLoginItem(revalidate)).resolves.toBe("enabled");
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
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

// Ticket packaging-smappservice-activation (issue #287 descriptor-hardening
// review, Finding 3): a busy/indeterminate `desktop-install-cloud.js`
// install leaves a `pending-login-item-revision.json` marker (see
// `host-paths.ts:getHostFsLayout`'s doc comment for the full cross-repo
// contract) so the ensure fast path can apply the refreshed LaunchAgent
// registration once the host goes idle. `registerHostLoginItem` must only
// resolve that marker when the cycle actually lands on `enabled` - any
// other terminal status (denied approval, SMAppService refusing to
// register) must leave it in place so a later cycle keeps retrying.
describe("registerHostLoginItem - pending LaunchAgent revision marker", () => {
  it("clears the marker when the register cycle ends enabled", async () => {
    writePendingRevisionMarker();
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    const status = await registerHostLoginItem(undefined);

    expect(status).toBe("enabled");
    expect(existsSync(pendingRevisionMarkerPath())).toBe(false);
  });

  it("leaves the marker in place when the register cycle ends requires-approval", async () => {
    writePendingRevisionMarker();
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });
    getLoginItemSettings.mockReturnValueOnce({ status: "requires-approval" });

    const status = await registerHostLoginItem(undefined);

    expect(status).toBe("requires-approval");
    expect(existsSync(pendingRevisionMarkerPath())).toBe(true);
  });

  it("leaves the marker in place when the register cycle ends not-registered (SMAppService refused)", async () => {
    writePendingRevisionMarker();
    // Every status read stays `not-registered` - the BTM-commit poll
    // exhausts its deadline and the cycle fails closed.
    getLoginItemSettings.mockReturnValue({ status: "not-registered" });

    const status = await registerHostLoginItem(undefined);

    expect(status).toBe("not-registered");
    expect(existsSync(pendingRevisionMarkerPath())).toBe(true);
  });

  it("is a no-op when no marker was ever written", async () => {
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    const status = await registerHostLoginItem(undefined);

    expect(status).toBe("enabled");
    expect(existsSync(pendingRevisionMarkerPath())).toBe(false);
  });
});

describe("hasPendingLoginItemRevision", () => {
  it("reports true only while the marker file exists on disk for the given environment", async () => {
    await expect(hasPendingLoginItemRevision("production")).resolves.toBe(
      false,
    );

    writePendingRevisionMarker();

    await expect(hasPendingLoginItemRevision("production")).resolves.toBe(true);
  });
});
