import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  readonly serviceName: string;
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
// so no runtime's homedir semantics are in the trust chain at all.
// `userLaunchAgentPlistPath` gets the same treatment for the same reason:
// the register cycle's legacy-manifest cleanup would otherwise `rm` the
// invoking user's REAL `~/Library/LaunchAgents/ai.traycer.host.plist`.
// `labelForEnvironment` / `smAppServiceAgentLabelId` (module-init time)
// stay real.
vi.mock("../../host/host-paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../host/host-paths")>();
  return {
    ...actual,
    getHostFsLayout: (environment: string) =>
      buildTestHostFsLayout(environment),
    userLaunchAgentPlistPath: (labelId: string) =>
      testUserLaunchAgentPlistPath(labelId),
  };
});

// Deterministic hook for the "manifest reappeared after removal" branch:
// `removeCliLabelManifest`'s `rm` and `retireLegacyLabelRegistrations`'s
// positive re-probe are two separate real fs calls with no atomicity between
// them, so exercising "something wrote the manifest back before the re-probe
// ran" needs a seam ON `rm` itself rather than a timing race. Every other
// caller passes through to the real `node:fs/promises` untouched; only a
// test that sets `afterRemoveRecreate` (and only for the ONE `rm` call it
// arms for) observes different behavior.
const rmHook = vi.hoisted(() => ({
  afterRemoveRecreate: null as (() => void) | null,
}));

// `bootoutStaleAgent`'s spawn is injected via the production module's
// `setBootoutSpawnFnForTests` seam (see the rationale on the seam itself),
// NOT via `vi.mock("node:child_process")`: a mock of the builtin that
// silently fails to intercept (the `default.spawn` CJS-interop gotcha the
// `node:fs/promises` mock below documents) does not fail a test — it runs
// a REAL `launchctl bootout` against the developer's live host agent. The
// global `beforeEach` installs a throwing backstop so any test that
// reaches the bootout spawn without arranging a stub surfaces loudly as
// "bootout-failed" plus this error, never as a real launchctl invocation.

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mockedRm = async (
    path: Parameters<typeof actual.rm>[0],
    opts: Parameters<typeof actual.rm>[1],
  ): Promise<void> => {
    const result = await actual.rm(path, opts);
    if (rmHook.afterRemoveRecreate !== null) {
      const recreate = rmHook.afterRemoveRecreate;
      rmHook.afterRemoveRecreate = null;
      recreate();
    }
    return result;
  };
  const mocked = { ...actual, rm: mockedRm };
  // Mirror onto `default` too - Vite/esbuild's CJS interop can read
  // `default.rm` rather than the top-level named export (see
  // `install-bundled-cli.test.ts` / `desktop-state-store.test.ts` for the
  // identical gotcha); a plain spread of the real namespace would otherwise
  // leave the un-mocked implementation reachable there, silently missing
  // the call `host-login-item.ts` makes.
  return { ...mocked, default: mocked };
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
  retireCompetingCliRegistrationAtLaunch,
  overrideAgentPrintRunnerForTests,
  runLaunchctlBootout,
  withHostLoginItemRegistrationLock,
  hasPendingLoginItemRevision,
  hasUnappliedPendingLoginItemRevision,
  unregisterHostLoginItemGuarded,
  setBootoutSpawnFnForTests,
} = await import("../host-login-item");

// Module state on the imported singleton — clear it when the file is done
// so no stub outlives the suite.
afterAll(() => {
  setBootoutSpawnFnForTests(null);
});

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

// Sandboxed stand-in for `userLaunchAgentPlistPath` (see the host-paths
// vi.mock rationale). The register cycle's legacy cleanup targets the CLI
// label (`ai.traycer.host` under the mocked "production" config).
function testUserLaunchAgentPlistPath(labelId: string): string {
  return join(workHome, "Library", "LaunchAgents", `${labelId}.plist`);
}

function legacyCliManifestPath(): string {
  return testUserLaunchAgentPlistPath("ai.traycer.host");
}

function writeLegacyCliManifest(): void {
  mkdirSync(join(workHome, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(legacyCliManifestPath(), "<plist/>", "utf8");
}

async function withDarwinCodesignIdentity<T>(
  initialIdentity: string,
  fn: (setIdentity: (identity: string) => void) => Promise<T>,
): Promise<T> {
  const codesignDir = mkdtempSync(join(tmpdir(), "traycer-codesign-test-"));
  const codesignPath = join(codesignDir, "codesign");
  const setIdentity = (identity: string): void => {
    writeFileSync(
      codesignPath,
      `#!/bin/sh\nprintf 'CDHash=${identity}\\n' >&2\n`,
      "utf8",
    );
    chmodSync(codesignPath, 0o755);
  };
  setIdentity(initialIdentity);
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousUid = Object.getOwnPropertyDescriptor(process, "getuid");
  const previousPath = process.env.PATH;
  Object.defineProperty(process, "platform", {
    value: "darwin",
    writable: true,
    configurable: true,
  });
  // Keep this test hermetic: bootout is skipped when no UID resolver exists.
  Object.defineProperty(process, "getuid", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  process.env.PATH = `${codesignDir}${previousPath === undefined ? "" : `:${previousPath}`}`;
  try {
    return await fn(setIdentity);
  } finally {
    process.env.PATH = previousPath;
    if (previousPlatform === undefined)
      delete (process as { platform?: string }).platform;
    else Object.defineProperty(process, "platform", previousPlatform);
    if (previousUid === undefined)
      delete (process as { getuid?: () => number }).getuid;
    else Object.defineProperty(process, "getuid", previousUid);
    rmSync(codesignDir, { recursive: true, force: true });
  }
}

async function withTestBundleRevision<T>(fn: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    value: join(workHome, "Traycer.app", "Contents", "Resources"),
    writable: true,
    configurable: true,
  });
  const bundleAgents = join(
    workHome,
    "Traycer.app",
    "Contents",
    "Library",
    "LaunchAgents",
  );
  mkdirSync(bundleAgents, { recursive: true });
  writeFileSync(
    join(bundleAgents, "ai.traycer.host.agent.plist"),
    "<plist revision='before' />",
    "utf8",
  );
  try {
    return await fn();
  } finally {
    if (previous === undefined)
      delete (process as { resourcesPath?: string }).resourcesPath;
    else Object.defineProperty(process, "resourcesPath", previous);
  }
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
  // Throwing backstop, re-armed for every test: reaching the bootout spawn
  // without an explicit stub is a test bug, and the ONLY acceptable failure
  // mode for that bug is a loud error — never the real `launchctl`.
  // (`bootoutStaleAgent` catches the throw and reports "bootout-failed".)
  setBootoutSpawnFnForTests(() => {
    throw new Error(
      "test reached bootoutStaleAgent's spawn without arranging a stub — " +
        "install one via setBootoutSpawnFnForTests before driving a darwin " +
        "register/unregister flow",
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmHook.afterRemoveRecreate = null;
  rmSync(workHome, { recursive: true, force: true });
});

describe("registerHostLoginItem", () => {
  it("parks authority loss without compensating registration when the nested helper identity changes", async () => {
    await withDarwinCodesignIdentity("before", async (setIdentity) =>
      withTestBundleRevision(async () => {
        // Snapshot reads primary first, then legacy. Losing authority after
        // the second destructive edge must park the cycle; even an exact
        // prior registration is not a license for a compensating mutation
        // once the nested helper identity has changed.
        getLoginItemSettings
          .mockReturnValueOnce({ status: "enabled" })
          .mockReturnValueOnce({ status: "not-registered" })
          .mockReturnValue({ status: "not-registered" });
        const revalidate = vi.fn(() =>
          Promise.resolve().then(() => {
            if (setLoginItemSettings.mock.calls.length >= 2) {
              setIdentity("after");
              return false;
            }
            return true;
          }),
        );

        await expect(registerHostLoginItem(revalidate)).resolves.toBe(
          "deferred-busy",
        );
        expect(
          setLoginItemSettings.mock.calls.some(
            ([options]) => options.openAtLogin === true,
          ),
        ).toBe(false);
      }),
    );
  });

  it("does not manufacture a registration when the pre-cycle state was absent", async () => {
    await withTestBundleRevision(async () => {
      getLoginItemSettings.mockReturnValue({ status: "not-registered" });
      const revalidate = vi.fn(() =>
        Promise.resolve(setLoginItemSettings.mock.calls.length < 2),
      );

      await expect(registerHostLoginItem(revalidate)).resolves.toBe(
        "deferred-busy",
      );
      expect(
        setLoginItemSettings.mock.calls.some(
          ([options]) => options.openAtLogin === true,
        ),
      ).toBe(false);
    });
  });

  // Overturns the pre-ruling contract: a READABLE `present` manifest is now
  // migration work this cycle performs (see Part 3 below), not a park
  // condition - collapsing it into "present therefore park" is exactly the
  // defect that permanently deadlocked the <=1.1.6 upgrade cohort.
  // `unreadable` is the only remaining disqualifier: we cannot retire what
  // we cannot see, and must not register a second label beside it.
  it.skipIf(process.getuid?.() === 0)(
    "parks before destructive registration when the legacy manifest is unreadable, not merely present",
    async () => {
      const originalManifest = "<plist legacy='before'/>";
      writeLegacyCliManifest();
      writeFileSync(legacyCliManifestPath(), originalManifest, "utf8");
      const agentsDir = join(workHome, "Library", "LaunchAgents");
      // Drops the SEARCH (execute) bit, so `access()` on the known filename
      // fails EACCES rather than ENOENT - the probe's unreadable branch.
      chmodSync(agentsDir, 0o600);
      try {
        await withDarwinCodesignIdentity("before", async () =>
          withTestBundleRevision(async () => {
            getLoginItemSettings
              .mockReturnValueOnce({ status: "enabled" }) // snapshot: primary
              .mockReturnValueOnce({ status: "enabled" }) // snapshot: legacy
              .mockReturnValue({ status: "not-registered" });
            await expect(registerHostLoginItem(undefined)).resolves.toBe(
              "enabled",
            );
            expect(setLoginItemSettings).not.toHaveBeenCalled();
          }),
        );
      } finally {
        chmodSync(agentsDir, 0o755);
      }
      expect(existsSync(legacyCliManifestPath())).toBe(true);
      expect(readFileSync(legacyCliManifestPath(), "utf8")).toBe(
        originalManifest,
      );
    },
  );

  it("parks instead of restoring when the bundle revision changes before compensation", async () => {
    await withDarwinCodesignIdentity("before", async (setIdentity) =>
      withTestBundleRevision(async () => {
        getLoginItemSettings
          .mockReturnValueOnce({ status: "enabled" })
          .mockReturnValueOnce({ status: "not-registered" })
          .mockReturnValue({ status: "not-registered" });
        const revalidate = vi.fn(() => {
          if (setLoginItemSettings.mock.calls.length >= 2) {
            setIdentity("after");
            return Promise.resolve(false);
          }
          return Promise.resolve(true);
        });

        await expect(registerHostLoginItem(revalidate)).resolves.toBe(
          "deferred-busy",
        );
        expect(
          setLoginItemSettings.mock.calls.some(
            ([options]) => options.openAtLogin === true,
          ),
        ).toBe(false);
      }),
    );
  });

  it("runs the label-split cycle: legacy-serviceName unregister, then agent unregister → register - the agent label (`.agent`) is the only one ever registered", async () => {
    // `snapshotLoginItemRegistration` reads primary then legacy FIRST (both
    // must be `not-registered`/`enabled` to pass the entry guard); then:
    // 3rd read: post-unregister status; 4th: first post-register read
    // (which returns 'enabled' so the BTM-commit poll exits immediately).
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    const status = await registerHostLoginItem(undefined);

    expect(setLoginItemSettings).toHaveBeenCalledTimes(3);
    // Step 3: transition cleanup of the pre-split serviceName. Never a
    // register - the legacy label is permanently poisoned by BTM legacy
    // records on upgraded machines.
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.plist",
    });
    // Step 5: unregister → register pair, agent serviceName only.
    expect(setLoginItemSettings.mock.calls[1]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.agent.plist",
    });
    expect(setLoginItemSettings.mock.calls[2]?.[0]).toMatchObject({
      openAtLogin: true,
      serviceName: "ai.traycer.host.agent.plist",
    });
    expect(status).toBe("enabled");
  });

  it("removes the legacy CLI LaunchAgent manifest once the cycle is committed - the old label's RunAtLoad agent must not start a competing host at next login", async () => {
    writeLegacyCliManifest();
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    await expect(registerHostLoginItem(undefined)).resolves.toBe("enabled");
    expect(existsSync(legacyCliManifestPath())).toBe(false);
  });

  it("parks with `deferred-busy` when the legacy-serviceName unregister throws - a throwing clear is a FAILED teardown, not best-effort noise to skip past into the fresh label", async () => {
    // `false` from `setLoginItemSettingsWithGuard` now means the Electron
    // call THREW, distinct from a clean "nothing to clear". The old
    // behaviour ("legacy cleanup is best-effort, always continue") let a
    // still-live legacy registration coexist with a freshly registered
    // agent label; `retireLegacyLabelRegistrations` now reports the failure
    // upward and the cycle parks before ever touching the agent label.
    setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("no inert old plist in this bundle");
    });
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "deferred-busy",
    );
    // Only the one throwing call — the cycle never reaches the agent-label
    // unregister/register pair.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
  });

  it("returns the post-register status verbatim so callers can branch on `requires-approval`", async () => {
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
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

  it("surfaces `not-registered` instead of throwing when the AGENT `setLoginItemSettings` throws - the boundary catch keeps Electron API errors from poisoning the renderer", async () => {
    // `snapshotLoginItemRegistration` reads primary then legacy before any
    // destructive edge - both must pass the entry guard for this test to
    // actually exercise the throw path below, rather than parking earlier.
    //
    // Isolates the AGENT (primary) clear specifically: the legacy-
    // serviceName unregister must SUCCEED here, otherwise
    // `retireLegacyLabelRegistrations`'s own failed-clear park (pinned
    // above) fires first and this test would stop proving anything about
    // the agent-side catch it names.
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    setLoginItemSettings
      .mockImplementationOnce(() => undefined) // legacy-serviceName unregister succeeds
      .mockImplementation(() => {
        throw new Error("SMAppService bridge said no");
      });

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "not-registered",
    );
    expect(getLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it("refuses the whole cycle with `removed-by-user` when the removal sentinel is set - no SMAppService mutation runs and the legacy manifest stays intact", async () => {
    // The sentinel is re-read inside the locked section, so a register that
    // queued behind an uninstall's unregister sees the removal and cannot
    // re-create the BTM login item ("Remove Traycer" must stay removed).
    writeLegacyCliManifest();
    isHostRemovedByUserMock.mockResolvedValue(true);

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "removed-by-user",
    );
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(getLoginItemSettings).not.toHaveBeenCalled();
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  it("refuses the cycle with `deferred-busy` when the caller's revalidation guard fails once the cycle is dequeued - no SMAppService mutation runs and the legacy manifest stays intact", async () => {
    // Proves the fix for the "revalidate the idle gate after acquiring the
    // lock" finding: a caller's own busy-check can go stale while queued
    // behind another cycle on the shared registration lock, so the guard is
    // re-run INSIDE the locked section, immediately before the bootout that
    // would otherwise kill a host that picked up work while queued.
    //
    // The legacy-manifest assertion pins the label-split coupling
    // invariant: legacy cleanup runs only in a COMMITTED cycle. A deferred
    // cycle deleting the manifest would leave the still-running legacy
    // host with no backing file (no auto-restart after crash/reboot)
    // before any agent registration exists to replace it.
    writeLegacyCliManifest();
    const revalidate = vi.fn().mockResolvedValue(false);

    await expect(registerHostLoginItem(revalidate)).resolves.toBe(
      "deferred-busy",
    );
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(getLoginItemSettings).not.toHaveBeenCalled();
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  it("proceeds with the cycle when the revalidation guard passes", async () => {
    const revalidate = vi.fn().mockResolvedValue(true);
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    await expect(registerHostLoginItem(revalidate)).resolves.toBe("enabled");
    // Re-checked adjacent to every destructive edge (the top-level entry
    // guard, then once per edge: legacy bootout, legacy clear, primary
    // bootout, primary clear, primary register, pending-revision marker
    // removal) - not just once at the top. This count is a pre-existing
    // property of `mutationAllowed` threading, unrelated to this ticket's
    // guard fix; pinning it exactly rather than `toHaveBeenCalled()` keeps
    // a future edge that drops its re-check from passing silently.
    expect(revalidate).toHaveBeenCalledTimes(7);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(3);
  });
});

// Acceptance evidence for the <=1.1.6 deadlock fix: a `present` legacy
// manifest is now migration work the cycle performs, not a park condition.
// No prior test in this file ever put a manifest on disk AND let the cycle
// proceed - which is exactly how the regression shipped unnoticed. These
// cover both directions the ruling promises: the manifest actually gets
// retired and the cycle reaches primary registration (progress), and every
// way that retirement can go wrong still fails closed before primary
// registration (fail-closed).
describe("registerHostLoginItem - legacy manifest retirement (present-manifest deadlock fix)", () => {
  it("progress: a present legacy manifest is actually retired, re-probed absent, and the real post-register status (including requires-approval) propagates", async () => {
    writeLegacyCliManifest();
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: legacy
      .mockReturnValueOnce({ status: "not-registered" }) // post-primary-clear read
      .mockReturnValueOnce({ status: "requires-approval" }); // post-register (terminal)

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "requires-approval",
    );
    // Genuinely removed, not merely "the cycle didn't park".
    expect(existsSync(legacyCliManifestPath())).toBe(false);
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.plist",
    });
    expect(setLoginItemSettings.mock.calls[2]?.[0]).toMatchObject({
      openAtLogin: true,
      serviceName: "ai.traycer.host.agent.plist",
    });
    // `requires-approval` means registered, only the user's toggle is off -
    // it must reach the caller as the real terminal status, not read as a
    // registration failure the way an `unreadable`/`failed` park would.
  });

  it.skipIf(process.getuid?.() === 0)(
    "fail-closed: a legacy manifest removal that FAILS parks before primary registration - the second half of the original defect",
    async () => {
      writeLegacyCliManifest();
      const agentsDir = join(workHome, "Library", "LaunchAgents");
      // Readable/searchable (the probe succeeds, sees `present`) but not
      // writable, so the `rm` itself throws - distinct from the unreadable-
      // probe park, and the half of the original defect where a legacy
      // manifest that could not be removed still let the cycle register a
      // second, competing label beside it. Root bypasses the write bit, so
      // this fixture is meaningless under root - skip it there, exactly like
      // the unreadable-directory tests in this file already do.
      chmodSync(agentsDir, 0o500);
      try {
        getLoginItemSettings
          .mockReturnValueOnce({ status: "enabled" }) // snapshot: primary
          .mockReturnValueOnce({ status: "enabled" }) // snapshot: legacy
          .mockReturnValue({ status: "not-registered" });

        await expect(registerHostLoginItem(undefined)).resolves.toBe(
          "deferred-busy",
        );
        expect(setLoginItemSettings).not.toHaveBeenCalled();
      } finally {
        chmodSync(agentsDir, 0o755);
      }
      expect(existsSync(legacyCliManifestPath())).toBe(true);
    },
  );

  it("fail-closed: a manifest that reappears immediately after removal never reaches primary registration", async () => {
    writeLegacyCliManifest();
    // Arms the ONE `rm` call this cycle makes: right after it genuinely
    // deletes the manifest, something else (a concurrent CLI install, a
    // race with the launch repair) writes it straight back. The positive
    // re-probe after removal must catch this - `rm(force)` alone cannot
    // distinguish "removed it" from "there was nothing there", so a removal
    // that reports success is not proof the machine is actually clean.
    rmHook.afterRemoveRecreate = () => {
      writeFileSync(legacyCliManifestPath(), "<plist reappeared/>", "utf8");
    };
    getLoginItemSettings
      .mockReturnValueOnce({ status: "enabled" }) // snapshot: primary
      .mockReturnValueOnce({ status: "enabled" }) // snapshot: legacy
      .mockReturnValue({ status: "not-registered" });

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "deferred-busy",
    );
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  it("a park BEFORE the first mutation reports the truthful prior primary status, never `deferred-busy` - unlike the two fail-closed cases above", async () => {
    // Contrast with the two fail-closed cases above: THIS park happens at
    // the very first guard (`canBeginDestructiveRegistration`), before any
    // edge has run, so there is no authority-loss ambiguity - the snapshot
    // IS still current and safe to hand back verbatim. A POST-mutation park
    // (a failed/reappeared manifest removal, or any edge after that point)
    // cannot make the same claim - a mutation may already have landed under
    // a since-lost capability, so it reports the busy-continuation sentinel
    // instead of pretending the stale snapshot is still truthful.
    getLoginItemSettings
      .mockReturnValueOnce({ status: "requires-approval" }) // snapshot: primary - disqualifying
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "requires-approval",
    );
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });
});

// F7 (round 5 review): 46 tests above and not one of them exercised
// unregister. That absence is how the defect shipped - register removed the
// raw `RunAtLoad` plist, unregister only booted out the jobs and cleared the
// SMAppService records, so a migration machine reported successful
// deregistration while `~/Library/LaunchAgents/<cli-label>.plist` was still
// on disk, and launchd started the host again at next login.
//
// The fix shares `removeCliLabelManifestProvably` between register and
// unregister. These tests mirror the register-side "legacy manifest
// retirement" describe block above one-for-one, from the unregister
// direction, plus one case (`absent`) that block does not need in the same
// shape and one (register-side regression) that is the existing 46 tests
// staying green unmodified.
//
// `unregisterHostLoginItemGuarded`'s snapshot/bootout/clear steps consume
// `revalidateBeforeMutation` in a FIXED, deterministic order under the
// test's forced non-darwin platform (`bootoutStaleAgent` returns right after
// its own `mutationAllowed` check once `process.platform !== "darwin"` -
// confirmed by reading the production source, not assumed): bootout(agent),
// bootout(legacy), clear(primary), clear(legacy), then - only if the
// manifest is PRESENT and readable - the manifest removal's own
// `mutationAllowed` check. A revalidator that returns `true` for the first N
// calls and `false` after is how the "guard refuses mid-teardown" case below
// lands exactly on the manifest step rather than anywhere earlier.
describe("unregisterHostLoginItemGuarded - CLI LaunchAgent manifest retirement (register/unregister symmetry)", () => {
  function countingRevalidator(
    trueForFirstNCalls: number,
  ): () => Promise<boolean> {
    let calls = 0;
    return async () => {
      calls += 1;
      return calls <= trueForFirstNCalls;
    };
  }

  it("happy path: a present manifest is genuinely removed and unregister reports true", async () => {
    writeLegacyCliManifest();
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);

    expect(existsSync(legacyCliManifestPath())).toBe(false);
    // Order AND count matter here, not just "was called" - both service
    // names are cleared, primary first.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.agent.plist",
    });
    expect(setLoginItemSettings.mock.calls[1]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.plist",
    });

    // Ablated (verification-only, never committed): temporarily removed the
    // `removeCliLabelManifestProvably` call from
    // `unregisterHostLoginItemUnserialized` (returning `true` unconditionally
    // right after the two `setLoginItemSettingsWithGuard` clears, matching
    // the pre-fix behavior exactly). Re-ran this test: it went red on
    // `existsSync(legacyCliManifestPath()) === false` - the function still
    // resolved `true`, but the manifest was still on disk, reproducing the
    // original defect precisely (teardown reported success while the raw
    // manifest survived). Reverted before committing anything;
    // `host-login-item.ts` was never touched.
  });

  it("`deferred`: the guard refusing mid-teardown (at the manifest step specifically) reports false and does not claim teardown succeeded", async () => {
    writeLegacyCliManifest();
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" })
      .mockReturnValueOnce({ status: "not-registered" });

    // True for calls 1-4 (both bootouts, both clears), false on call 5 -
    // which lands inside `removeCliLabelManifest`'s own `mutationAllowed`
    // check, since the manifest is present and readable.
    await expect(
      unregisterHostLoginItemGuarded(countingRevalidator(4)),
    ).resolves.toBe(false);

    // The earlier edges already ran (this is authority lost MID-teardown,
    // not at the first guard) - both clears landed...
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
    // ...but the manifest removal itself never ran, so the file survives -
    // this is exactly why the overall result must be `false` and not `true`.
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "`failed`: a manifest removal that errors reports false and leaves the manifest in place",
    async () => {
      writeLegacyCliManifest();
      const agentsDir = join(workHome, "Library", "LaunchAgents");
      // Readable/searchable (probe sees `present`) but not writable, so `rm`
      // itself throws - mirrors the register-side "removal FAILS" fixture.
      // Root bypasses the write bit, so this fixture is meaningless under
      // root - skip it there, exactly like the unreadable-directory tests in
      // this file already do.
      chmodSync(agentsDir, 0o500);
      try {
        getLoginItemSettings
          .mockReturnValueOnce({ status: "not-registered" })
          .mockReturnValueOnce({ status: "not-registered" });

        await expect(
          unregisterHostLoginItemGuarded(async () => true),
        ).resolves.toBe(false);
      } finally {
        chmodSync(agentsDir, 0o755);
      }
      expect(existsSync(legacyCliManifestPath())).toBe(true);
      // Both clears still ran - the manifest step is last, and a failure
      // there does not retroactively undo the two clears that already
      // committed. `false` is what tells the caller teardown is incomplete.
      expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "`unreadable` probe: an unreadable LaunchAgents directory parks at the FIRST guard, before any bootout or clear",
    async () => {
      writeLegacyCliManifest();
      const agentsDir = join(workHome, "Library", "LaunchAgents");
      // Drops the search bit - `access()` on the known filename fails
      // EACCES rather than ENOENT, the probe's `unreadable` branch. This is
      // caught by `canBeginDestructiveRegistration`'s shared snapshot guard
      // (the same one register's own "unreadable" test exercises above),
      // before `removeCliLabelManifestProvably` is ever reached - asserting
      // the OBSERVABLE outcome (parks, nothing ran) rather than which
      // internal function produced it, per the brief.
      chmodSync(agentsDir, 0o600);
      try {
        getLoginItemSettings
          .mockReturnValueOnce({ status: "not-registered" })
          .mockReturnValueOnce({ status: "not-registered" });

        await expect(
          unregisterHostLoginItemGuarded(async () => true),
        ).resolves.toBe(false);
        expect(setLoginItemSettings).not.toHaveBeenCalled();
      } finally {
        chmodSync(agentsDir, 0o755);
      }
    },
  );

  it("reappeared: a manifest that comes back immediately after removal reports false, not a false success", async () => {
    writeLegacyCliManifest();
    // Arms the ONE `rm` call this cycle makes, same fixture the register
    // side's reappeared test uses.
    rmHook.afterRemoveRecreate = () => {
      writeFileSync(legacyCliManifestPath(), "<plist reappeared/>", "utf8");
    };
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" })
      .mockReturnValueOnce({ status: "not-registered" });

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(false);

    expect(existsSync(legacyCliManifestPath())).toBe(true);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it("absent: a clean machine with no manifest still succeeds - the fix must not turn a clean machine into a park", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" })
      .mockReturnValueOnce({ status: "not-registered" });

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);

    expect(existsSync(legacyCliManifestPath())).toBe(false);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  // `false` from `setLoginItemSettingsWithGuard` means the Electron call
  // THREW - a failed teardown, not a clean "nothing was registered". The
  // fix this pair pins: neither clear may report "torn down" over a throw
  // it never observed succeeding, and a failed primary clear must not go on
  // to attempt the legacy clear or manifest removal as if it had.
  it("primary clear throws: reports false rather than success, and never reaches the legacy clear or manifest removal", async () => {
    writeLegacyCliManifest();
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("SMAppService bridge said no (primary clear)");
    });

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(false);

    // Only the one throwing call - the primary clear's failure short-
    // circuits before the legacy clear is ever attempted.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  it("legacy clear throws after a successful primary clear: reports false and leaves the manifest in place", async () => {
    writeLegacyCliManifest();
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    setLoginItemSettings
      .mockImplementationOnce(() => undefined) // primary clear succeeds
      .mockImplementationOnce(() => {
        throw new Error("SMAppService bridge said no (legacy clear)");
      });

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(false);

    expect(setLoginItemSettings).toHaveBeenCalledTimes(2);
    // The manifest removal step never runs - the legacy clear's failure
    // short-circuits before it, so the raw RunAtLoad manifest survives.
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  // Register-side regression guard (#7 of the brief): all 4 tests in
  // "registerHostLoginItem - legacy manifest retirement" above are
  // UNMODIFIED by this change - same fixtures, same assertions, same
  // expected outcomes. Since both callers now share
  // `removeCliLabelManifestProvably`, that block passing unchanged in the
  // same run as everything above IS the register-side regression guard;
  // splitting it into a separate duplicate test would only assert the same
  // property twice under a different name.
});

describe("runLaunchctlBootout", () => {
  // The BTM-clearing side effect happens server-side in launchd as
  // soon as the bootout RPC is received — exit code is the signal
  // that tells us whether the RPC was actually issued, but the
  // mutation has already taken place by the time launchctl returns.
  // These tests pin the argv shape, the exit-code classification
  // (success / "not loaded" no-op / unexpected failure), and the
  // failure-mode safety net (timeout kill, error event).
  //
  // Production change A: `runLaunchctlBootout` now resolves `Promise<boolean>`
  // (previously `Promise<void>`) so `bootoutStaleAgent` can distinguish "BTM
  // is provably cleared/clean" from "the BTM entry may still be present" -
  // the register cycle treats the latter as best-effort and proceeds, while
  // the uninstall teardown treats it as a failed deregistration.

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

  it("resolves true when launchctl exits 0 — agent was loaded and is now gone", async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
    queueMicrotask(() => {
      fake.fireExit();
    });

    await expect(
      runLaunchctlBootout("gui/501/test.label", spawnFn),
    ).resolves.toBe(true);
    expect(fake.killCalls).toHaveLength(0);
  });

  it("treats exit codes 3 / 5 / 113 as 'not loaded' no-ops and resolves true — clean-machine bootout has nothing to clear and that's success", async () => {
    for (const code of [3, 5, 113]) {
      const fake = makeFakeChild();
      const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
      queueMicrotask(() => {
        fake.child.emit("exit", code, null);
      });

      await expect(
        runLaunchctlBootout("gui/501/test.label", spawnFn),
      ).resolves.toBe(true);
    }
  });

  // New regression coverage (production change A): any OTHER exit code is a
  // real launchctl failure - the BTM entry may still be present - and must
  // resolve `false` so `bootoutStaleAgent` reports "bootout-failed" rather
  // than silently claiming the clear succeeded.
  it("resolves false on an unexpected exit code — the BTM entry may still be present", async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
    queueMicrotask(() => {
      fake.child.emit("exit", 1, null);
    });

    await expect(
      runLaunchctlBootout("gui/501/test.label", spawnFn),
    ).resolves.toBe(false);
  });

  it("resolves false (never throws) when the child emits an error event — degrades to a bootout-failed verdict rather than failing the register cycle", async () => {
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);
    queueMicrotask(() => {
      fake.fireError(new Error("ENOENT"));
    });

    await expect(
      runLaunchctlBootout("gui/501/test.label", spawnFn),
    ).resolves.toBe(false);
  });

  it("kills the child with SIGTERM once the timeout elapses and resolves false — a wedged launchctl cannot hold the register cycle hostage", async () => {
    vi.useFakeTimers();
    const fake = makeFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(fake.child);

    const promise = runLaunchctlBootout("gui/501/test.label", spawnFn);
    // Advance past the 5s bootout timeout; the child never fires
    // exit or error, so only the setTimeout path can resolve us.
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBe(false);
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
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    const status = await registerHostLoginItem(undefined);

    expect(status).toBe("enabled");
    expect(existsSync(pendingRevisionMarkerPath())).toBe(false);
  });

  it("leaves the marker in place when the register cycle ends requires-approval", async () => {
    writePendingRevisionMarker();
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
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
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
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

// M-B: `hasUnappliedPendingLoginItemRevision` is the re-cycle gate the
// HostController actually consults. It differs from the raw existence check
// above only when a successful apply could not delete its marker (best-effort
// unlink failed): that lingering marker must read as "already applied" so the
// controller does not re-run the disruptive SMAppService cycle forever, while a
// genuinely newer revision (rewritten marker -> newer mtime) still re-arms.
describe("hasUnappliedPendingLoginItemRevision (M-B)", () => {
  it("is false when no marker exists", async () => {
    await expect(
      hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(false);
  });

  it("is true for a freshly written marker this process has not applied", async () => {
    writePendingRevisionMarker();
    await expect(
      hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(true);
  });

  it("is false again after a successful register cycle deletes the marker", async () => {
    writePendingRevisionMarker();
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });

    await registerHostLoginItem(undefined);

    await expect(
      hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(false);
  });

  it("treats a marker whose clear FAILED as already-applied, but re-arms for a newer revision", async () => {
    writePendingRevisionMarker();
    const markerDir = join(workHome, ".traycer", "host");
    // A read-only parent dir makes the marker's `rm` (and only that) fail, so
    // the register cycle applies the revision but leaves the marker on disk -
    // the exact best-effort-clear-failed condition M-B guards.
    chmodSync(markerDir, 0o555);
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" });
    getLoginItemSettings.mockReturnValueOnce({ status: "enabled" });
    await registerHostLoginItem(undefined);
    chmodSync(markerDir, 0o755);

    // The marker is still on disk, but it was applied by the cycle above -
    // suppressed, so no redundant disruptive re-cycle.
    await expect(
      hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(false);

    // A genuinely newer revision (installer rewrites the marker -> newer mtime)
    // re-arms and applies normally.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writePendingRevisionMarker();
    await expect(
      hasUnappliedPendingLoginItemRevision("production"),
    ).resolves.toBe(true);
  });
});

// The launch-time dual-registration repair. Unlike the register cycle it
// runs on EVERY launch, so its gates carry the whole safety burden: the
// asymmetry is that failing to retire leaves a duplicate host, while
// retiring on the wrong machine takes away its only host.
describe("retireCompetingCliRegistrationAtLaunch", () => {
  // The outer `beforeAll` pins the platform off-darwin so the register
  // cycle's `bootoutStaleAgent` can never touch the developer's real
  // launchd domain. This repair mutates nothing via launchctl (its only
  // spawn is the read-only agent print, and that is overridden below so
  // the suite never reads the developer's real launchd domain), so darwin
  // is safe to restore here, and required: `hostManagesHostLoginItem()`
  // short-circuits on every other platform.
  beforeEach(() => {
    // Default: a loaded, healthy agent - the pre-gate behavior. Wedge
    // tests override per-test.
    overrideAgentPrintRunnerForTests(async () => ({
      exitCode: 0,
      stdout: [
        "gui/501/ai.traycer.host.agent = {",
        "\tactive count = 1",
        "\tpath = (submitted by smd.516)",
        "\ttype = Submitted",
        "\tmanaged_by = com.apple.xpc.ServiceManagement",
        "\tstate = running",
        "\tpid = 4242",
        "}",
        "",
      ].join("\n"),
      stderr: "",
      timedOut: false,
      spawnFailed: false,
      signal: null,
    }));
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
      configurable: true,
    });
    // Point the bundle inside the per-test temp dir rather than the shared
    // fixed path, so `hostManagesHostLoginItem`'s in-bundle plist probe is
    // hermetic per test.
    Object.defineProperty(process, "resourcesPath", {
      value: join(workHome, "Traycer.app", "Contents", "Resources"),
      writable: true,
      configurable: true,
    });
    const bundleAgents = join(
      workHome,
      "Traycer.app",
      "Contents",
      "Library",
      "LaunchAgents",
    );
    mkdirSync(bundleAgents, { recursive: true });
    writeFileSync(
      join(bundleAgents, "ai.traycer.host.agent.plist"),
      "<plist/>",
      "utf8",
    );
  });

  afterEach(() => {
    overrideAgentPrintRunnerForTests(null);
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
      configurable: true,
    });
  });

  it("removes a competing CLI manifest when the agent is enabled", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "retired",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(false);
  });

  // The availability gate. Under `requires-approval` launchd will not spawn
  // the agent, so the CLI registration may be the only thing that starts a
  // host at login - removing it would leave the machine with none.
  it("leaves the competing manifest alone when the agent is not enabled", async () => {
    getLoginItemSettings.mockReturnValue({ status: "requires-approval" });
    writeLegacyCliManifest();

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "agent-not-enabled",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  it("does not repair a host the user removed on this device", async () => {
    isHostRemovedByUserMock.mockResolvedValue(true);
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "not-applicable",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  // The formerly-ACCEPTED GAP, now closed: an LWCR/EX_CONFIG-wedged agent
  // reads `enabled` while every spawn dies. On that machine the CLI
  // registration may be the machine's only working host - including one
  // just installed via `service install --takeover` - and deleting it
  // would hand the machine back to a host that cannot run.
  it("leaves the competing manifest alone when the agent's print carries wedge markers", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();
    overrideAgentPrintRunnerForTests(async () => ({
      exitCode: 0,
      stdout: [
        "gui/501/ai.traycer.host.agent = {",
        "\tactive count = 0",
        "\tpath = (submitted by smd.516)",
        "\ttype = Submitted",
        "\tmanaged_by = com.apple.xpc.ServiceManagement",
        "\tstate = spawn failed",
        "\tlast exit code = 78",
        "}",
        "",
      ].join("\n"),
      stderr: "",
      timedOut: false,
      spawnFailed: false,
      signal: null,
    }));

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "agent-possibly-wedged",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  // Unknown must fail toward keeping the duplicate (one more login of
  // dual-host, which Layer 0 makes data-safe), never toward deleting what
  // may be the only working registration.
  it("leaves the competing manifest alone when the wedge probe cannot answer", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();
    overrideAgentPrintRunnerForTests(async () => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnFailed: true,
      signal: null,
    }));

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "agent-possibly-wedged",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  // The agent not being loaded at all is NOT a wedge: nothing is
  // stuck-and-enabled, and the enabled gate above already made the
  // availability call. Retirement proceeds.
  it("still retires when the agent label is simply not loaded", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();
    overrideAgentPrintRunnerForTests(async () => ({
      exitCode: 113,
      stdout: "",
      stderr: "Could not find specified service\n",
      timedOut: false,
      spawnFailed: false,
      signal: null,
    }));

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "retired",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(false);
  });

  it("is a no-op on a healthy machine with no competing manifest", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "nothing-to-retire",
    );
  });

  // Repair only - it must never register, unregister, or bootout anything.
  // Eviction authority stays with the register cycle and the CLI's explicit
  // install, both of which know they are allowed to disrupt a running host.
  // A regression fence rather than evidence: no path here can currently
  // reach `setLoginItemSettings`, and the point is that none ever should.
  it("never mutates SMAppService state", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();

    await retireCompetingCliRegistrationAtLaunch();

    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  // The gate that keeps this off every non-packaged build. Without it a dev
  // build - or any run outside an .app bundle, including this very test
  // suite - would delete the developer's REAL
  // `~/Library/LaunchAgents/ai.traycer.host.plist` and deregister their
  // running host. Every other test here stages a valid bundle, so this is
  // the only place the gate is exercised.
  it("never runs on a build that does not own registration", async () => {
    // No in-bundle LaunchAgent plist => `hostManagesHostLoginItem()` false.
    rmSync(
      join(
        workHome,
        "Traycer.app",
        "Contents",
        "Library",
        "LaunchAgents",
        "ai.traycer.host.agent.plist",
      ),
      { force: true },
    );
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();

    await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
      "not-applicable",
    );
    expect(existsSync(legacyCliManifestPath())).toBe(true);
  });

  // Skipped as root: root ignores directory mode bits, so the `unlink` would
  // succeed and the test would assert the wrong branch. Real CI runs
  // unprivileged; this only bites in a root container.
  it.skipIf(process.getuid?.() === 0)(
    "reports retire-failed when the manifest cannot be removed",
    async () => {
      getLoginItemSettings.mockReturnValue({ status: "enabled" });
      writeLegacyCliManifest();
      // Read-only parent directory: the file still stats, but unlink fails.
      const agentsDir = join(workHome, "Library", "LaunchAgents");
      chmodSync(agentsDir, 0o500);
      try {
        await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
          "retire-failed",
        );
      } finally {
        chmodSync(agentsDir, 0o755);
      }
      expect(existsSync(legacyCliManifestPath())).toBe(true);
    },
  );

  // An unreadable LaunchAgents directory must not read as "already clean".
  // `0o600` drops the directory's SEARCH (execute) bit, which is the one that
  // makes `access` on a known filename fail with EACCES; a directory that is
  // merely unlistable (`0o300`) still resolves names inside it just fine. That
  // EACCES-vs-ENOENT split is the whole distinction under test. Skipped as
  // root for the same reason as the test above.
  it.skipIf(process.getuid?.() === 0)(
    "does not report an unreadable LaunchAgents directory as nothing-to-retire",
    async () => {
      getLoginItemSettings.mockReturnValue({ status: "enabled" });
      writeLegacyCliManifest();
      const agentsDir = join(workHome, "Library", "LaunchAgents");
      chmodSync(agentsDir, 0o600);
      try {
        await expect(retireCompetingCliRegistrationAtLaunch()).resolves.toBe(
          "retire-failed",
        );
      } finally {
        chmodSync(agentsDir, 0o755);
      }
      // Untouched: we never attempt an `rm` on a path we could not read.
      expect(existsSync(legacyCliManifestPath())).toBe(true);
    },
  );

  // The doc comment sells serialization through the registration lock as a
  // safety property; pin it. A repair must not interleave with a register
  // cycle's own CLI-label cleanup.
  it("serializes against an in-flight register cycle", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();

    const order: string[] = [];
    const cycle = withHostLoginItemRegistrationLock(async () => {
      order.push("cycle:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("cycle:end");
    });
    const repair = retireCompetingCliRegistrationAtLaunch().then((outcome) => {
      order.push("repair");
      return outcome;
    });

    await Promise.all([cycle, repair]);

    expect(order).toEqual(["cycle:start", "cycle:end", "repair"]);
  });
});

// Codex #2. `requires-approval` means REGISTERED with the user's toggle off —
// `pollRegisterStatusUntilSettled` says so in as many words. Removal shared its
// entry guard with REGISTRATION, which refuses that state for a reason that
// does not apply to removal: registration boots out and re-registers, so it
// must refuse any prior state it could not put back. Removal has nothing to
// put back.
//
// The consequence was that a user who had toggled the login item off could
// never remove it: an explicit deregister parked on exactly the state it exists
// to clear, and the registration outlived the uninstall.
describe("unregisterHostLoginItemGuarded - removable-state entry guard", () => {
  it("REMOVES a registered-but-disabled (requires-approval) login item", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "requires-approval" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);

    // Not merely "returned true": the SMAppService record was actually cleared.
    expect(setLoginItemSettings).toHaveBeenCalled();
  });

  it("REMOVES it on the legacy label too", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "requires-approval" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);
    expect(setLoginItemSettings).toHaveBeenCalled();
  });

  // Reversed direction (production change 3(i)): `not-found`/`not-supported`
  // no longer refuse removal outright — a status we could read (even one with
  // nothing to clear) admits the removal, and only that label's own
  // SMAppService clear leg is skipped as meaningless. The bootouts and the
  // manifest retirement still run; the OTHER label's clear (here,
  // `not-registered`, which IS clearable) still fires. Only `null` (unreadable
  // status) or an unreadable legacy manifest still refuse outright.
  it("not-found admits removal — its own clear leg is skipped, the other label's still runs", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-found" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);
    // Only the legacy label's clear ran — the primary leg has nothing to
    // clear under `not-found` and is skipped, not attempted-and-ignored.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.plist",
    });
  });

  it("not-supported admits removal — its own clear leg is skipped, the other label's still runs", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-supported" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);
    // Only the primary label's clear ran — the legacy leg has no API to
    // clear with under `not-supported` and is skipped, not attempted.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.agent.plist",
    });
  });
});

// Production change A, items (2) and (3): `bootoutStaleAgent` now
// distinguishes "ok" from "bootout-failed" by the REAL launchctl exit code
// (not just the caller's revalidation guard, which the existing
// "deferred-busy"/"authority-lost" tests above already cover). These
// blocks exercise that distinction end to end through the production
// module's `setBootoutSpawnFnForTests` seam: the register cycle's
// best-effort proceed, and the uninstall teardown's hard failure.
describe("registerHostLoginItem / unregisterHostLoginItemGuarded - launchctl bootout failure (production change A)", () => {
  const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
      configurable: true,
    });
    // A concrete UID resolver, independent of the machine running the
    // suite: `bootoutStaleAgent` short-circuits to "ok" without one (see
    // `withDarwinCodesignIdentity`, which relies on exactly that), and
    // these tests need the bootout to RUN.
    Object.defineProperty(process, "getuid", {
      value: () => 501,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
      configurable: true,
    });
    if (originalGetuid === undefined) {
      delete (process as { getuid?: () => number }).getuid;
    } else {
      Object.defineProperty(process, "getuid", originalGetuid);
    }
  });

  // Every `runLaunchctlBootout` call this fixture drives gets its OWN fresh
  // fake child that exits with the scripted code on the next microtask -
  // two calls (one per label) must each observe an exit, not share one
  // already-consumed EventEmitter. Returns the spy so tests can assert the
  // bootouts actually RAN - a fixture that trips an earlier guard would
  // produce the same return value with zero spawns, which is exactly the
  // vacuous pass these counts exist to rule out.
  function scriptBootoutExits(codes: ReadonlyArray<number>) {
    let calls = 0;
    const spawnStub = vi.fn(() => {
      const code = codes[Math.min(calls, codes.length - 1)];
      calls += 1;
      const fake = makeFakeChild();
      queueMicrotask(() => {
        fake.child.emit("exit", code, null);
      });
      return fake.child;
    });
    setBootoutSpawnFnForTests(spawnStub);
    return spawnStub;
  }

  it("register cycle: completes and reaches `enabled` even when both launchctl bootouts fail - best-effort, not a park", async () => {
    // Every bootout exits 1 => "bootout-failed" at each edge.
    const spawnStub = scriptBootoutExits([1]);
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: legacy
      .mockReturnValueOnce({ status: "not-registered" }) // post-clear read
      .mockReturnValueOnce({ status: "enabled" }); // post-register (BTM committed)

    await expect(registerHostLoginItem(undefined)).resolves.toBe("enabled");
    // The agent-label clear/register pair (and the legacy-serviceName
    // unregister) still ran despite both bootouts failing - the register
    // cycle's docstring promise that bootout failure degrades to the
    // pre-fix behavior for this one call, not a park.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(3);
    // Both bootout edges ran and failed: the legacy retirement's CLI-label
    // bootout and the step-4 agent-label BTM flush.
    expect(spawnStub).toHaveBeenCalledTimes(2);
  });

  it("unregister teardown: returns false (not parked) when the primary launchctl bootout exits with an unexpected code - teardown is incomplete", async () => {
    const spawnStub = scriptBootoutExits([1]);
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(false);
    // A TEARDOWN must not report success over an unproven bootout: the
    // primary bootout's failure short-circuits before either SMAppService
    // clear or the legacy bootout ever runs, unlike the register cycle's
    // best-effort proceed above.
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    // Exactly the primary (agent-label) bootout ran - proving the false
    // came from ITS failure, not from the removable-state entry guard.
    expect(spawnStub).toHaveBeenCalledTimes(1);
  });

  it("unregister teardown: still returns false when only the LEGACY bootout fails after a successful primary bootout", async () => {
    // Primary bootout clears (0); legacy bootout fails (1).
    const spawnStub = scriptBootoutExits([0, 1]);
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-registered" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(false);
    // The legacy bootout's failure short-circuits before either
    // SMAppService clear runs.
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    // Both bootouts ran: primary succeeded, legacy failed.
    expect(spawnStub).toHaveBeenCalledTimes(2);
  });
});
