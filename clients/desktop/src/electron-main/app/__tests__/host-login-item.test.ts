import { EventEmitter } from "node:events";
import electronLog from "electron-log";
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

// `inAppLaunchAgentPlistPath` reads `process.resourcesPath` synchronously inside `registerHostLoginItem` for log attribution.
// In a real test process that condition holds and the bootout would touch the user's actual launchd domain, which is a real side effect we must not produce.
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

// `registerHostLoginItem` re-checks the removed-by-user sentinel inside the locked section (so a register queued behind an uninstall's unregister can never resurrect the login item).
const isHostRemovedByUserMock = vi.fn<() => Promise<boolean>>();
vi.mock("../../host/host-removal-state", () => ({
  isHostRemovedByUser: () => isHostRemovedByUserMock(),
}));

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

// Deterministic hook for the "manifest reappeared after removal" branch: `removeCliLabelManifest`'s `rm` and `retireLegacyLabelRegistrations`'s positive re-probe are two separate.
// Every other caller passes through to the real `node:fs/promises` untouched.
const rmHook = vi.hoisted(() => ({
  afterRemoveRecreate: null as (() => void) | null,
}));


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

// Module state on the imported singleton  -  clear it when the file is done
// so no stub outlives the suite.
afterAll(() => {
  setBootoutSpawnFnForTests(null);
});

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
  // `mockReset` (not `mockClear`) so persistent implementations set via `mockReturnValue` / `mockImplementation` in one test don't leak into the next.
  setLoginItemSettings.mockReset();
  getLoginItemSettings.mockReset();
  isHostRemovedByUserMock.mockReset().mockResolvedValue(false);
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-login-item-"));
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
        // Losing authority after the second destructive edge must park the cycle.
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

  // `unreadable` is the only remaining disqualifier: we cannot retire what we cannot see, and must not register a second label beside it.
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
            // Production change: this guard's refusal now ALWAYS reports "parked" rather than the prior primary status it used to return in its place.
            await expect(registerHostLoginItem(undefined)).resolves.toBe(
              "parked",
            );
            expect(setLoginItemSettings).not.toHaveBeenCalled();
            expect(electronLog.warn).toHaveBeenLastCalledWith(
              "[host-login-item] registration parked: prior registration cannot be restored exactly",
              {
                primary: "enabled",
                legacy: "enabled",
                legacyManifest: "unreadable",
              },
            );
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
    // `snapshotLoginItemRegistration` reads primary then legacy FIRST (both must be `not-registered`/`enabled` to pass the entry guard); then: 3rd read: post-unregister status.
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
    setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error("no inert old plist in this bundle");
    });
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: primary
    getLoginItemSettings.mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(registerHostLoginItem(undefined)).resolves.toBe(
      "deferred-busy",
    );
    // Only the one throwing call  -  the cycle never reaches the agent-label
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
    // `snapshotLoginItemRegistration` reads primary then legacy before any destructive edge.
    // Isolates the AGENT (primary) clear specifically: the legacy- serviceName unregister must SUCCEED here, otherwise `retireLegacyLabelRegistrations`'s own failed-clear park (pinned.
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
    expect(revalidate).toHaveBeenCalledTimes(7);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(3);
  });
});

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
  });

  it.skipIf(process.getuid?.() === 0)(
    "fail-closed: a legacy manifest removal that FAILS parks before primary registration - the second half of the original defect",
    async () => {
      writeLegacyCliManifest();
      const agentsDir = join(workHome, "Library", "LaunchAgents");
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
    // The positive re-probe after removal must catch this.
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

  it("a park BEFORE the first mutation reports `parked`, never the prior primary status and never `deferred-busy`", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "requires-approval" }) // snapshot: primary - disqualifying
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(registerHostLoginItem(undefined)).resolves.toBe("parked");
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(electronLog.warn).toHaveBeenLastCalledWith(
      "[host-login-item] registration parked: prior registration cannot be restored exactly",
      {
        primary: "requires-approval",
        legacy: "not-registered",
        legacyManifest: "absent",
      },
    );
  });
});

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

    // Ablated (verification-only, never committed): temporarily removed the `removeCliLabelManifestProvably` call from `unregisterHostLoginItemUnserialized` (returning `true`.
    // Reverted before committing anything; `host-login-item.ts` was never touched.
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

});

describe("runLaunchctlBootout", () => {

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

// It differs from the raw existence check above only when a successful apply could not delete its marker (best-effort unlink failed): that lingering marker must read as "already.
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

describe("retireCompetingCliRegistrationAtLaunch", () => {
  // The outer `beforeAll` pins the platform off-darwin so the register cycle's `bootoutStaleAgent` can never touch the developer's real launchd domain.
  // This repair mutates nothing via launchctl (its only spawn is the read-only agent print, and that is overridden below so the suite never reads the developer's real launchd domain).
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
  it("never mutates SMAppService state", async () => {
    getLoginItemSettings.mockReturnValue({ status: "enabled" });
    writeLegacyCliManifest();

    await retireCompetingCliRegistrationAtLaunch();

    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

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

  it("not-found admits removal — its own clear leg is skipped, the other label's still runs", async () => {
    getLoginItemSettings
      .mockReturnValueOnce({ status: "not-found" }) // snapshot: primary
      .mockReturnValueOnce({ status: "not-registered" }); // snapshot: legacy

    await expect(
      unregisterHostLoginItemGuarded(async () => true),
    ).resolves.toBe(true);
    // Only the legacy label's clear ran  -  the primary leg has nothing to
    // clear under `not-found` and is skipped, not attempted-and-ignored.
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(setLoginItemSettings.mock.calls[0]?.[0]).toMatchObject({
      openAtLogin: false,
      serviceName: "ai.traycer.host.plist",
    });
  });
});

describe("registerHostLoginItem / unregisterHostLoginItemGuarded - launchctl bootout failure (production change A)", () => {
  const originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid");

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
      configurable: true,
    });
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
    // A TEARDOWN must not report success over an unproven bootout: the primary bootout's failure short-circuits before either SMAppService clear or the legacy bootout ever runs, unlike.
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
