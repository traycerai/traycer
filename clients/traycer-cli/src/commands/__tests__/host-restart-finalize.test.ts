import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PathLike } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { powershellSingleQuoted } from "@traycer-clients/shared/platform/powershell-quote";
import { formatWindowsProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { RestartStop } from "../../service";
import type { CommandContext } from "../../runner/runner";
import type { ServiceLabel } from "../../service/label";
import type { ScheduledTaskXmlQuery } from "../../service/platforms/windows";
import { config } from "../../config";
import {
  createFeedSigningKey,
  feedPayload,
  signFeedPayload,
  type FeedSigningKey,
} from "../../registry/__tests__/signed-feed-test-helpers";

// `host restart` is the controlled supervisor restart that owns the
// pending CLI upgrade finalize step. Between `controller.stop()` and
// `controller.start()` the live CLI binary's lock is released, so the
// command attempts the staged-binary swap in that window.
//
// We exercise the split-out helper `restartWithPendingCliUpgradeFinalize`
// with a controller stub so the test doesn't depend on a real OS
// service manager. The CLI manifest is written under a tmp HOME so
// the manifest read/write paths exercise the real on-disk format.

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
const configState = vi.hoisted(() => ({
  environment: "dev",
  hostTrustedPubkeys: [] as readonly string[],
}));
const windowsHandoff = vi.hoisted(() => ({
  serviceStartCalls: 0,
  hostRunning: false,
  serviceCalls: [] as string[],
  readinessPort: null as number | null,
  currentProcess: true,
  waitingForDemand: false,
  gonePids: [] as number[],
}));
const fsMocks = vi.hoisted(() => ({
  failHelperPreparation: false,
  failManifestRenameTarget: null as string | null,
  failBinaryRenameTarget: null as string | null,
  feedVersion: "1.5.1",
  feedSha256: "0".repeat(64),
}));
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    ensureCliInstallHomeDir: async (
      ...args: Parameters<typeof actual.ensureCliInstallHomeDir>
    ) => {
      if (fsMocks.failHelperPreparation)
        throw new Error("install-home access denied");
      return actual.ensureCliInstallHomeDir(...args);
    },
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});
vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  const sharedConfig = { ...actual.config };
  Object.defineProperties(sharedConfig, {
    environment: {
      enumerable: true,
      get: () => configState.environment,
      set: (value: string) => {
        configState.environment = value;
      },
    },
    hostTrustedPubkeys: {
      enumerable: true,
      get: () => configState.hostTrustedPubkeys,
      set: (value: readonly string[]) => {
        configState.hostTrustedPubkeys = value;
      },
    },
  });
  return { ...actual, config: sharedConfig };
});
vi.mock("../../host/update-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-mutation")>();
  return {
    ...actual,
    startHostServiceWithAttempt: async (
      ...args: Parameters<typeof actual.startHostServiceWithAttempt>
    ) => {
      windowsHandoff.serviceStartCalls += 1;
      windowsHandoff.hostRunning = true;
      windowsHandoff.serviceCalls.push("start");
      args[5]?.(99002);
      return { kind: "started" as const };
    },
    stopHostForRestartWithAttempt: async () => {
      expect(windowsHandoff.hostRunning).toBe(true);
      windowsHandoff.hostRunning = false;
      windowsHandoff.serviceCalls.push("stop");
      return { forcedRecycle: false };
    },
  };
});
vi.mock("../../host/live-supervisor-run", () => ({
  readLiveSupervisorRun: async () =>
    windowsHandoff.hostRunning
      ? {
          supervisorPid: 99002,
          admission: "granted",
        }
      : null,
}));
vi.mock("../../store/process-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../store/process-identity")>()),
  getPublishedProcessIdentityVerdict: async (pid: number) =>
    windowsHandoff.gonePids.includes(pid)
      ? "dead"
      : windowsHandoff.currentProcess
        ? "current"
        : "mismatch",
}));
vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: async (
      ...args: Parameters<typeof actual.readHostPidMetadata>
    ) => {
      if (windowsHandoff.readinessPort === null) {
        return actual.readHostPidMetadata(...args);
      }
      if (
        (windowsHandoff.waitingForDemand ||
          windowsHandoff.gonePids.length > 0) &&
        !windowsHandoff.hostRunning
      )
        return null;
      const started = "2026-01-01T00:00:00.0000000Z";
      return {
        pid: 99003,
        hostId: "restoration-fixture",
        version: "1.4.0",
        websocketUrl: `ws://127.0.0.1:${windowsHandoff.readinessPort}/rpc`,
        startedAt: started,
        processStartIdentity: formatWindowsProcessStartIdentity(started),
        processStartIdentityRead: "present" as const,
        layer0: null,
        layer0Slot: null,
      };
    },
  };
});
vi.mock("../../host/service-supervisor-relaunch", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../host/service-supervisor-relaunch")
    >();
  return {
    ...actual,
    waitForSupervisorRelaunch: (
      env: import("../../runner/environment").Environment,
      deps: import("../../host/service-supervisor-relaunch").SupervisorRelaunchWaitDeps,
    ) =>
      actual.waitForSupervisorRelaunch(env, {
        ...deps,
        waitMs: Math.min(deps.waitMs, 350),
        pollIntervalMs: 10,
      }),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (src: PathLike, dest: PathLike): Promise<void> => {
      if (dest === fsMocks.failBinaryRenameTarget) {
        const error: NodeJS.ErrnoException = new Error(
          "binary is still locked",
        );
        error.code = "EBUSY";
        throw error;
      }
      if (dest === fsMocks.failManifestRenameTarget) {
        fsMocks.failManifestRenameTarget = null;
        throw new Error("manifest rename failed: read-only filesystem");
      }
      return actual.rename(src, dest);
    },
  };
});
vi.mock("../../registry/cli-versions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../registry/cli-versions")>();
  return {
    ...actual,
    fetchCliVersions: async () => {
      const asset = {
        available: true,
        unavailableReason: null,
        url: `https://example.test/cli/${fsMocks.feedVersion}/win32-x64`,
        sizeBytes: 1,
        sha256: fsMocks.feedSha256,
        signatureUrl: `https://example.test/cli/${fsMocks.feedVersion}/win32-x64.minisig`,
        signatureAlgorithm: "minisign" as const,
        publicKeyId: "test-key",
      };
      return {
        schemaVersion: 1,
        generatedAt: "2026-05-01T00:00:00Z",
        latest: fsMocks.feedVersion,
        version: fsMocks.feedVersion,
        releaseNotesUrl: "https://example.test/release-notes",
        compatibilityEpoch: null,
        platforms: {
          "win32-x64": asset,
          "linux-x64": asset,
        },
      };
    },
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;
let signingKey: FeedSigningKey;
let previousTrustedKeys: readonly string[];
let previousEnvironment: string;
let readinessServer: Server | null = null;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(async () => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  // The `store/paths` module captures `homedir()` once at module
  // load - drop the module cache so each test sees its own tmp HOME.
  vi.resetModules();
  fsMocks.failManifestRenameTarget = null;
  fsMocks.failHelperPreparation = false;
  fsMocks.failBinaryRenameTarget = null;
  fsMocks.feedVersion = "1.5.1";
  fsMocks.feedSha256 = "0".repeat(64);
  windowsHandoff.serviceStartCalls = 0;
  windowsHandoff.hostRunning = false;
  windowsHandoff.serviceCalls = [];
  windowsHandoff.readinessPort = null;
  windowsHandoff.currentProcess = true;
  windowsHandoff.waitingForDemand = false;
  windowsHandoff.gonePids = [];
  signingKey = createFeedSigningKey();
  previousTrustedKeys = config.hostTrustedPubkeys;
  previousEnvironment = config.environment;
  config.hostTrustedPubkeys = [signingKey.publicKeyText];
  config.environment = "production";
  // The fixture rewires this module's Windows task readers below. Load it
  // before the test body so a cold transform cannot overlap the next case.
  await import("../host-restart");
});

afterEach(async () => {
  if (readinessServer !== null) {
    readinessServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      readinessServer?.close((error) => (error ? reject(error) : resolve()));
    });
    readinessServer = null;
  }
  config.hostTrustedPubkeys = previousTrustedKeys;
  config.environment = previousEnvironment;
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
});

interface StubCalls {
  readonly calls: string[];
  readonly events?: string[];
  // What `relaunchAfterRestart` actually received. Recorded because the whole
  // point of splitting restart into halves is that the stop's verdict reaches
  // the relaunch - a stub that discards the argument cannot show that.
  relaunchStop: RestartStop | null;
}

interface StubController {
  install: () => Promise<void>;
  uninstall: () => Promise<void>;
  status: () => Promise<{
    state: "stopped";
    version: null;
    listenUrl: null;
    pid: null;
  }>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  restart: () => Promise<void>;
  // Parameters mirrored from the real `ServiceController`, not elided to
  // `()`. A zero-arg stub type is the same erasure as the duplicated call
  // tokens: it makes the argument the halves exist to carry invisible to
  // both the compiler and the assertions.
  stopForRestart: (label: ServiceLabel) => Promise<RestartStop>;
  relaunchAfterRestart: (
    label: ServiceLabel,
    stop: RestartStop,
  ) => Promise<void>;
}

function makeStubController(calls: StubCalls): StubController {
  return {
    install: async () => undefined,
    uninstall: async () => undefined,
    status: async () => ({
      state: "stopped" as const,
      version: null,
      listenUrl: null,
      pid: null,
    }),
    stop: async () => {
      calls.calls.push("stop");
    },
    start: async () => {
      calls.calls.push("start");
    },
    restart: async () => {
      calls.calls.push("restart");
    },
    // DISTINCT tokens, deliberately.
    //
    // These used to push "stop"/"start" - the same tokens as the plain
    // primitives - so every `toEqual(["stop", "start"])` below passed
    // identically whether `host restart` used the cooperative halves this
    // changeset introduces or fell back to the old `stop()` + `start()` path.
    // The suite could not observe the distinction it exists to protect.
    stopForRestart: async () => {
      calls.calls.push("stopForRestart");
      calls.events?.push("stop");
      return { forcedRecycle: false };
    },
    relaunchAfterRestart: async (_label, stop) => {
      calls.calls.push("relaunchAfterRestart");
      calls.events?.push("relaunch");
      calls.relaunchStop = stop;
    },
  };
}

function writeManifest(opts: {
  readonly liveBinaryPath: string;
  readonly stagedBinaryPath: string;
  readonly version: string;
}): string {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(cliDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: "1.4.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: opts.liveBinaryPath,
        source: "manual",
        pendingUpgrade: {
          version: opts.version,
          stagedBinaryPath: opts.stagedBinaryPath,
          stagedAt: "2026-05-10T00:00:00Z",
          reason: "binary-locked",
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  return manifestPath;
}

function peImage(payload: Buffer): Buffer {
  const header = Buffer.alloc(68);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(64, 0x3c);
  header.write("PE\0\0", 64, "binary");
  return Buffer.concat([header, payload]);
}

async function signedCliEvidence(
  version: string,
  sha256: string,
): Promise<string> {
  const platformAsset = {
    available: true,
    unavailableReason: null,
    url: `https://example.test/cli/${version}/win32-x64`,
    sizeBytes: 1,
    sha256,
    signatureUrl: `https://example.test/cli/${version}/win32-x64.minisig`,
    signatureAlgorithm: "minisign",
    publicKeyId: signingKey.keyId,
  };
  return signFeedPayload(
    JSON.stringify(
      feedPayload({
        feed: "cli",
        target: "production",
        latest: version,
        versions: [
          {
            version,
            releaseNotesUrl: `https://example.test/releases/${version}`,
            platforms: {
              "win32-x64": platformAsset,
              "linux-x64": platformAsset,
            },
          },
        ],
      }),
    ),
    signingKey,
  );
}

async function withBootTaskDefinition<T>(
  label: ServiceLabel,
  action: (queryCalls: string[]) => Promise<T>,
  modes: readonly ("logon" | "boot" | "disabled" | "unavailable")[],
  events: string[] | null,
): Promise<T> {
  const windows = await import("../../service/platforms/windows");
  const queryCalls: string[] = [];
  const queries: readonly ScheduledTaskXmlQuery[] = modes.map((mode) =>
    mode === "unavailable"
      ? { kind: "failed", reason: "Task Scheduler is unavailable" }
      : {
          kind: "xml",
          xml: windows.buildScheduledTaskXml(
            {
              label,
              cli: { command: "C:\\Traycer\\traycer.exe", args: [] },
              windowsBootRunLevel: mode === "boot" ? "HighestAvailable" : null,
            },
            "S-1-5-21-1234-5678-9012-1001",
            mode !== "disabled",
          ),
        },
  );
  windows.setWindowsTaskUserSidReaderForTests(
    () => "S-1-5-21-1234-5678-9012-1001",
  );
  windows.setWindowsTaskHiddenProbeForTests(async () => false);
  windows.setWindowsDefinitionDepsForTests({
    queryTaskXml: async (taskName) => {
      const mode = modes[Math.min(queryCalls.length, modes.length - 1)];
      queryCalls.push(taskName);
      if (mode !== undefined) events?.push(`query:${mode}`);
      return (
        queries[Math.min(queryCalls.length - 1, queries.length - 1)] ?? {
          kind: "failed",
          reason: "test fixture has no task definition",
        }
      );
    },
    predictCli: async () => {
      throw new Error("predictCli should not be called");
    },
    resolveCli: async () => {
      throw new Error("resolveCli should not be called");
    },
  });
  try {
    return await action(queryCalls);
  } finally {
    windows.setWindowsDefinitionDepsForTests(null);
    windows.setWindowsTaskHiddenProbeForTests(null);
    windows.setWindowsTaskUserSidReaderForTests(null);
  }
}

interface RestartArgsBaseline {
  readonly environment: "production" | "dev";
  readonly force: boolean;
  readonly controller: StubController;
  readonly label: { readonly id: string };
  readonly parentPid: number;
  readonly platform: NodeJS.Platform;
  readonly spawnImpl: (
    command: string,
    args: readonly string[],
    options: unknown,
  ) => {
    readonly pid: number | undefined;
    unref: () => void;
    kill: () => void;
    readonly exited: Promise<{
      readonly exitCode: number | null;
      readonly errorMessage: string | null;
    }>;
  };
  readonly writeImpl: (path: string, body: string) => void;
  readonly armWait: {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly waitMs: number;
    readonly pollIntervalMs: number;
  };
}

// A clock the helper's arm wait runs on without waiting.
function fakeArmWait(): RestartArgsBaseline["armWait"] {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    waitMs: 10_000,
    pollIntervalMs: 100,
  };
}

// Most existing tests don't care about helper scheduling - they
// exercise the POSIX path where finalize either succeeds or surfaces
// a manifest-state outcome and the helper isn't invoked. The default
// platform is "linux" so the Windows helper branch stays inert; the
// spawn/write stubs throw if accidentally invoked so a regression
// would be caught.
function defaultArgs(controller: StubController): RestartArgsBaseline {
  return {
    environment: "production",
    force: false,
    controller,
    label: {
      id: "ai.traycer.host.production",
      displayName: "Traycer Host",
      environment: "production",
    } as never,
    parentPid: 4242,
    platform: "linux",
    spawnImpl: (() => {
      throw new Error(
        "spawnImpl should not be invoked on POSIX still-locked path",
      );
    }) as RestartArgsBaseline["spawnImpl"],
    writeImpl: (() => {
      throw new Error(
        "writeImpl should not be invoked on POSIX still-locked path",
      );
    }) as RestartArgsBaseline["writeImpl"],
    armWait: fakeArmWait(),
  };
}

function testActuators(
  args: RestartArgsBaseline,
  events: string[] | undefined,
) {
  return {
    stop: () => args.controller.stopForRestart(args.label as ServiceLabel),
    relaunch: (stopped: RestartStop) =>
      args.controller.relaunchAfterRestart(args.label as ServiceLabel, stopped),
    connectWindowsRestart: async () => ({
      begin: async () => {
        events?.push("owner-armed");
      },
      issuingStop: async () => undefined,
      stopped: () => {
        events?.push("stop-reported");
      },
      close: () => undefined,
    }),
  };
}

function writtenReceiptPath(): string {
  const dir = join(workHome, ".traycer", "cli");
  const receipt = readdirSync(dir).find((name) =>
    /^post-finalize\.[a-f0-9-]{36}\.json$/u.test(name),
  );
  if (receipt === undefined) throw new Error("finalize receipt missing");
  return join(dir, receipt);
}

describe("restartWithPendingCliUpgradeFinalize", () => {
  it("refuses an unsupported boot-task downgrade before stopping the host", async () => {
    const binDir = join(workHome, "bin");
    mkdirSync(binDir, { recursive: true });
    const liveBinaryPath = join(binDir, "traycer.exe");
    const stagedBinaryPath = join(binDir, "traycer-1.5.1.exe");
    const liveBytes = Buffer.from([0x4d, 0x5a, 1, 2, 3]);
    const stagedBytes = Buffer.from([0x4d, 0x5a, 4, 5, 6]);
    writeFileSync(liveBinaryPath, liveBytes);
    writeFileSync(stagedBinaryPath, stagedBytes);
    fsMocks.feedVersion = "1.5.1";
    fsMocks.feedSha256 = createHash("sha256").update(stagedBytes).digest("hex");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.1",
    });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "1.5.2-rc.1";
    manifest.pendingUpgrade.allowDowngrade = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const { serviceLabelFor } = await import("../../service/label");
    const label = serviceLabelFor("production");
    const args = {
      ...defaultArgs(controller),
      label,
      platform: "win32" as const,
    };

    await withBootTaskDefinition(
      label,
      async (queryCalls) => {
        const { CLI_ERROR_CODES } = await import("../../runner/errors");
        await expect(
          restartWithPendingCliUpgradeFinalize(
            args as never,
            testActuators(args, undefined),
          ),
        ).rejects.toMatchObject({
          code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
          message: expect.stringContaining("--start-at-boot"),
          exitCode: 1,
        });

        expect(queryCalls).toHaveLength(1);
        expect(calls.calls).toEqual([]);
        expect(readFileSync(liveBinaryPath)).toEqual(liveBytes);
        expect(readFileSync(stagedBinaryPath)).toEqual(stagedBytes);
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
          version: "1.5.2-rc.1",
          pendingUpgrade: {
            version: "1.5.1",
            allowDowngrade: true,
            stagedBinaryPath,
          },
        });
      },
      ["boot"],
      null,
    );
  });

  it("retries unavailable Task Scheduler twice before stop for a newer signed staged release and digest-bound installed image", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const binDir = join(workHome, "scheduler-unavailable-bin");
    mkdirSync(binDir, { recursive: true });
    const liveBinaryPath = join(binDir, "traycer.exe");
    const stagedBinaryPath = join(binDir, "traycer-1.5.1.exe");
    const installedBytes = peImage(
      Buffer.from(
        "traycer:windows-unattended-service:1:ed362e23-7428-47cf-b857-ff24ea69d5d2\n",
      ),
    );
    const stagedBytes = peImage(Buffer.from("signed 1.5.1 image"));
    writeFileSync(liveBinaryPath, installedBytes);
    writeFileSync(stagedBinaryPath, stagedBytes);
    const installedSha256 = createHash("sha256")
      .update(installedBytes)
      .digest("hex");
    const stagedSha256 = createHash("sha256").update(stagedBytes).digest("hex");
    fsMocks.feedVersion = "1.5.1";
    fsMocks.feedSha256 = stagedSha256;
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.1",
    });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "1.5.0";
    manifest.pendingUpgrade.windowsEvidence = "signed-feed-v1";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(
      `${liveBinaryPath}.release-evidence.json`,
      await signedCliEvidence("1.5.0", installedSha256),
    );
    writeFileSync(
      `${stagedBinaryPath}.release-evidence.json`,
      await signedCliEvidence("1.5.1", stagedSha256),
    );

    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const { serviceLabelFor } = await import("../../service/label");
    const label = serviceLabelFor("production");
    const args = {
      ...defaultArgs(controller),
      label,
      platform: "win32" as const,
    };

    await withBootTaskDefinition(
      label,
      async (queryCalls) => {
        await expect(
          restartWithPendingCliUpgradeFinalize(
            args as never,
            testActuators(args, undefined),
          ),
        ).rejects.toMatchObject({
          code: "E_CLI_UPGRADE_BOOT_TASK_UNSUPPORTED",
          message: expect.stringContaining("Task Scheduler is available"),
        });
        expect(queryCalls).toHaveLength(2);
        expect(calls.calls).toEqual([]);
        expect(readFileSync(liveBinaryPath)).toEqual(installedBytes);
        expect(readFileSync(stagedBinaryPath)).toEqual(stagedBytes);
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
          version: "1.5.0",
          pendingUpgrade: {
            version: "1.5.1",
            windowsEvidence: "signed-feed-v1",
          },
        });
      },
      ["unavailable", "unavailable"],
      null,
    );
  });

  it("binds the verified staged digest and confirms the recovery owner before stop", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { captureWindowsCliFixture } =
      await import("../../__tests__/support/windows-cli-entry-image");
    captureWindowsCliFixture(process.execPath);
    const binDir = join(workHome, "guarded-bin");
    mkdirSync(binDir, { recursive: true });
    const liveBinaryPath = join(binDir, "traycer.exe");
    const stagedBinaryPath = join(binDir, "traycer-1.5.1.exe");
    const liveBytes = peImage(Buffer.from("installed image"));
    const stagedBytes = peImage(
      Buffer.concat([
        Buffer.from("release image"),
        Buffer.from(
          "traycer:windows-unattended-service:1:ed362e23-7428-47cf-b857-ff24ea69d5d2\n",
        ),
      ]),
    );
    writeFileSync(liveBinaryPath, liveBytes);
    writeFileSync(stagedBinaryPath, stagedBytes);
    const stagedSha256 = createHash("sha256").update(stagedBytes).digest("hex");
    fsMocks.feedVersion = "1.5.2";
    fsMocks.feedSha256 = stagedSha256;
    fsMocks.failBinaryRenameTarget = liveBinaryPath;
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.1",
    });

    const events: string[] = [];
    const calls: StubCalls = { calls: [], relaunchStop: null, events };
    const controller = makeStubController(calls);
    writeFileSync(
      `${stagedBinaryPath}.release-evidence.json`,
      await signedCliEvidence("1.5.1", stagedSha256),
    );
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const { serviceLabelFor } = await import("../../service/label");
    const label = serviceLabelFor("production");
    const argsBase = defaultArgs(controller);
    let helperScriptPath: string | null = null;
    const args = {
      ...argsBase,
      label,
      platform: "win32" as const,
      spawnImpl: (
        command: string,
        _argv: readonly string[],
        _options: unknown,
      ) => {
        expect(command).toMatch(
          /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu,
        );
        const scriptPath = helperScriptPath;
        if (scriptPath === null)
          throw new Error("helper script was not written");
        writeFileSync(scriptPath.replace(/\.ps1$/, ".armed"), "99001");
        return {
          pid: 99001,
          unref: () => undefined,
          kill: () => undefined,
          exited: Promise.resolve({ exitCode: 0, errorMessage: null }),
        };
      },
      writeImpl: async (path: string, body: string) => {
        if (path.endsWith(".ps1")) helperScriptPath = path;
        writeFileSync(path, body);
      },
      armWait: fakeArmWait(),
    } as RestartArgsBaseline;

    await withBootTaskDefinition(
      label,
      async (queryCalls) => {
        const result = await restartWithPendingCliUpgradeFinalize(
          args as never,
          testActuators(args, events),
        );

        expect(queryCalls).toHaveLength(1);
        expect(result.finalize).toMatchObject({
          status: "still-locked",
          stagedBinaryPath,
          livePath: liveBinaryPath,
          handoff: {
            stagedBinaryPath,
            sha256: stagedSha256,
            windowsEvidence: undefined,
          },
        });
        expect(result.helper).toMatchObject({
          status: "armed",
          helperPid: 99001,
        });
        expect(result.helperArmed).toBe(true);
        expect(events).toEqual([
          "query:logon",
          "owner-armed",
          "stop",
          "stop-reported",
        ]);
        expect(calls.calls).toEqual(["stopForRestart"]);
        expect(readFileSync(liveBinaryPath)).toEqual(liveBytes);
        expect(readFileSync(stagedBinaryPath)).toEqual(stagedBytes);
        expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
          pendingUpgrade: { version: "1.5.1", stagedBinaryPath },
        });
        if (helperScriptPath === null)
          throw new Error("helper script was not written");
        expect(readFileSync(helperScriptPath, "utf8")).toContain(stagedSha256);
      },
      ["logon", "boot"],
      events,
    );
  });

  async function useReadinessServer(server: Server): Promise<void> {
    readinessServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("The readiness server did not bind loopback");
    windowsHandoff.readinessPort = address.port;
  }

  function finalizeContext(): CommandContext {
    return {
      runtime: {
        json: true,
        quiet: false,
        noProgress: false,
        noBootstrap: false,
        nonInteractive: false,
        environment: "production",
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
      output: {
        progress: vi.fn(),
        human: vi.fn(),
        humanRequired: vi.fn(),
        emitResult: vi.fn(),
        emitError: vi.fn(),
      },
      progress: vi.fn(),
    };
  }

  it.each([
    {
      label: "supervisor still alive while a different child serves",
      gone: [99001],
      stop: "effect-unknown",
      live: true,
      answers: [],
      result: { status: "incumbent-live", stop: "effect-unknown" },
      starts: 0,
    },
    {
      label: "stop refused before mutation",
      gone: [],
      stop: "not-issued",
      live: true,
      answers: [],
      result: { status: "incumbent-live", stop: "not-issued" },
      starts: 0,
    },
    {
      label: "successor already answering",
      gone: [99001, 99004],
      stop: "effect-unknown",
      live: true,
      answers: [200],
      result: { status: "ready", runtimeVersion: "1.4.0" },
      starts: 0,
    },
    {
      label: "503 then ready after one guarded start",
      gone: [99001, 99004],
      stop: "stopped",
      live: false,
      answers: [503, 200],
      result: { status: "ready", runtimeVersion: "1.4.0" },
      starts: 1,
    },
    {
      label: "503 at deadline",
      gone: [99001, 99004],
      stop: "stopped",
      live: false,
      answers: [503],
      result: { status: "not-ready" },
      starts: 1,
    },
    {
      label: "the responding process is replaced mid-probe",
      gone: [99001, 99004],
      stop: "stopped",
      live: false,
      answers: [200],
      result: { status: "not-ready" },
      starts: 1,
    },
  ])(
    "reports the Windows recovery observation for $label",
    async ({ label, gone, live, stop, answers, result, starts }) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const { buildCliFinalizeUpgradeCommand } =
        await import("../cli-finalize-upgrade");
      windowsHandoff.gonePids = gone;
      windowsHandoff.hostRunning = live;
      windowsHandoff.waitingForDemand = !live;
      const statuses: number[] = [];
      await useReadinessServer(
        createServer((request, response) => {
          expect(request.url).toBe("/activity");
          const status =
            answers[Math.min(statuses.length, answers.length - 1)] ?? 503;
          statuses.push(status);
          if (label === "the responding process is replaced mid-probe")
            windowsHandoff.currentProcess = false;
          response.writeHead(status, { "content-type": "application/json" });
          response.end('{"busy":false}');
        }),
      );
      const identity = formatWindowsProcessStartIdentity(
        "2026-01-01T00:00:00.0000000Z",
      );
      const frame = Buffer.from(
        JSON.stringify({
          supervisor: { pid: 99004, identity },
          runtime: { pid: 99001, identity },
        }),
      ).toString("base64url");
      const now = Math.floor(uptime() * 1000);
      const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
      if (originalStdin === undefined)
        throw new Error("The stdin property is missing");
      Object.defineProperty(process, "stdin", {
        value: Readable.from([
          `start ${now + 10_000} ${now} ${stop} ${frame}\n`,
        ]),
      });
      try {
        const outcome = await buildCliFinalizeUpgradeCommand({
          expectedStagedPath: join(workHome, "pending.exe"),
          windowsWorkerReceiptId: "c3349888-373c-47cd-ab5a-0b415dc54dbd",
        })(finalizeContext());
        expect(outcome.data).toEqual({ serviceObservation: result });
        expect(windowsHandoff.serviceStartCalls).toBe(starts);
        expect([...new Set(statuses)]).toEqual(answers);
      } finally {
        Object.defineProperty(process, "stdin", originalStdin);
      }
    },
  );

  it.each([
    {
      evidence: "without",
      result: "boot-before-stop",
      modes: ["logon", "boot"],
    },
    {
      evidence: "with",
      result: "boot-before-stop",
      modes: ["logon", "boot"],
    },
    {
      evidence: "with",
      result: "swapped",
      modes: ["logon", "logon", "logon"],
    },
  ] as const)(
    "finalizes under one start owner ($result, $evidence signed legacy sidecar)",
    async ({ evidence, result, modes }) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const { captureWindowsCliFixture } =
        await import("../../__tests__/support/windows-cli-entry-image");
      const runnerPath = process.execPath;
      captureWindowsCliFixture(runnerPath);
      const binDir = join(workHome, "legacy-helper-bin");
      mkdirSync(binDir, { recursive: true });
      const liveBinaryPath = join(binDir, "traycer.exe");
      const stagedBinaryPath = join(binDir, "traycer-1.5.1.exe");
      const liveBytes = peImage(Buffer.from("installed legacy image"));
      const stagedBytes = peImage(
        Buffer.from(
          "traycer:windows-unattended-service:1:ed362e23-7428-47cf-b857-ff24ea69d5d2\n",
        ),
      );
      writeFileSync(liveBinaryPath, liveBytes);
      writeFileSync(stagedBinaryPath, stagedBytes);
      fsMocks.feedVersion = "1.5.1";
      fsMocks.failBinaryRenameTarget = liveBinaryPath;
      const manifestPath = writeManifest({
        liveBinaryPath,
        stagedBinaryPath,
        version: "1.5.1",
      });
      const signedDigest =
        evidence === "with"
          ? createHash("sha256").update(stagedBytes).digest("hex")
          : undefined;
      if (signedDigest !== undefined) {
        writeFileSync(
          `${stagedBinaryPath}.release-evidence.json`,
          await signedCliEvidence("1.5.1", signedDigest),
        );
      }

      const events: string[] = [];
      const calls: StubCalls = { calls: [], relaunchStop: null, events };
      const controller = makeStubController(calls);
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const { serviceLabelFor } = await import("../../service/label");
      const { buildCliFinalizeUpgradeCommand } =
        await import("../cli-finalize-upgrade");
      const label = serviceLabelFor("production");
      let helperScriptPath: string | null = null;
      const args = {
        ...defaultArgs(controller),
        label,
        platform: "win32" as const,
        spawnImpl: (
          command: string,
          argv: readonly string[],
          _options: unknown,
        ) => {
          expect(command).toMatch(
            /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu,
          );
          expect(argv).toContain("-EncodedCommand");
          if (helperScriptPath === null)
            throw new Error("helper script was not written");
          writeFileSync(helperScriptPath.replace(/\.ps1$/, ".armed"), "99002");
          return {
            pid: 99002,
            unref: () => undefined,
            kill: () => undefined,
            exited: Promise.resolve({ exitCode: 0, errorMessage: null }),
          };
        },
        writeImpl: async (path: string, body: string) => {
          if (path.endsWith(".ps1")) helperScriptPath = path;
          writeFileSync(path, body);
        },
        armWait: fakeArmWait(),
      } as RestartArgsBaseline;

      await withBootTaskDefinition(
        label,
        async (queryCalls) => {
          const restart = await restartWithPendingCliUpgradeFinalize(
            args as never,
            testActuators(args, undefined),
          );
          expect(restart.finalize.status).toBe("still-locked");
          expect(restart.helper).toMatchObject({
            status: "armed",
            helperPid: 99002,
          });
          expect(restart.helperArmed).toBe(true);
          expect(queryCalls).toHaveLength(1);
          expect(events).toEqual(["query:logon", "stop"]);
          expect(calls.calls).toEqual(["stopForRestart"]);
          if (helperScriptPath === null)
            throw new Error("helper script was not written");
          const helperScript = readFileSync(helperScriptPath, "utf8");
          expect(helperScript).toContain(
            `[System.IO.File]::Copy(${powershellSingleQuoted(runnerPath)}, $invokeBinary, $false)`,
          );
          expect(helperScript).toContain("--legacy-windows-handoff");
          expect(helperScript).toContain(
            `--expected-staged-path=${stagedBinaryPath}`,
          );
          if (signedDigest !== undefined) {
            expect(helperScript).toContain(
              `--expected-staged-sha256=${signedDigest}`,
            );
          }

          fsMocks.failBinaryRenameTarget = null;
          const command = buildCliFinalizeUpgradeCommand({
            legacyDetached: true,
            expectedStagedPath: stagedBinaryPath,
            expectedStagedSha256: signedDigest,
          });
          const finalize = await command({
            runtime: {
              json: false,
              quiet: false,
              noProgress: false,
              noBootstrap: false,
              nonInteractive: false,
              environment: "production",
              logger: {
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
              },
            },
            output: {
              progress: vi.fn(),
              human: vi.fn(),
              humanRequired: vi.fn(),
              emitResult: vi.fn(),
              emitError: vi.fn(),
            },
            progress: vi.fn(),
          });

          expect(queryCalls).toHaveLength(modes.length);
          expect(events).toEqual([
            "query:logon",
            "stop",
            ...modes.slice(1).map((mode) => `query:${mode}`),
          ]);
          expect(windowsHandoff.serviceCalls).toEqual(["start"]);
          expect(windowsHandoff.hostRunning).toBe(true);
          expect(finalize.data).toMatchObject({ serviceRestore: "started" });
          if (result === "swapped") {
            expect(finalize.data).toMatchObject({ status: "swapped" });
            expect(readFileSync(liveBinaryPath)).toEqual(stagedBytes);
            expect(existsSync(stagedBinaryPath)).toBe(false);
            expect(
              JSON.parse(readFileSync(manifestPath, "utf8")),
            ).toMatchObject({
              version: "1.5.1",
            });
            return;
          }
          expect(finalize.data).toMatchObject({ status: "swap-failed" });
          expect(finalize.human).not.toContain(workHome);
          expect(JSON.stringify(finalize.data)).not.toContain(workHome);
          expect(
            JSON.parse(readFileSync(writtenReceiptPath(), "utf8")),
          ).toMatchObject({
            status: "swap-failed",
            livePath: liveBinaryPath,
            stagedBinaryPath,
            errorMessage: expect.stringContaining(
              "could not verify the CLI binary",
            ),
            serviceStartError: null,
          });
          expect(readFileSync(liveBinaryPath)).toEqual(liveBytes);
          expect(readFileSync(stagedBinaryPath)).toEqual(stagedBytes);
          expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
            version: "1.4.0",
            pendingUpgrade: { version: "1.5.1", stagedBinaryPath },
          });
        },
        modes,
        events,
      );
    },
  );

  it("stops, finalises the staged binary, then starts (lifecycle order matters)", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });

    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const args = defaultArgs(controller);
    const result = await restartWithPendingCliUpgradeFinalize(
      args as never,
      testActuators(args, undefined),
    );

    expect(calls.calls).toEqual(["stopForRestart", "relaunchAfterRestart"]);
    // The halves exist so the stop's verdict reaches the relaunch — macOS
    // needs `forcedRecycle` to decide how to bring the job back. Asserting the
    // call order alone would pass against a relaunch that ignored it.
    expect(calls.relaunchStop).toEqual({ forcedRecycle: false });
    expect(result.finalize.status).toBe("finalised");
    if (result.finalize.status === "finalised") {
      expect(result.finalize.version).toBe("1.5.0");
      expect(result.finalize.previousVersion).toBe("1.4.0");
    }
    expect(result.helper).toBeNull();
    expect(result.helperArmed).toBe(false);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("staged-bytes-1.5.0");
    expect(existsSync(stagedBinaryPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.0");
    expect(reread.pendingUpgrade).toBeNull();
  });

  it("records a swapped marker when the binary moves but the manifest update fails", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });
    fsMocks.failManifestRenameTarget = manifestPath;

    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const args = defaultArgs(controller);
    const result = await restartWithPendingCliUpgradeFinalize(
      args as never,
      testActuators(args, undefined),
    );

    expect(result.finalize.status).toBe("manifest-update-failed");
    expect(calls.calls).toEqual(["stopForRestart", "relaunchAfterRestart"]);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("staged-bytes-1.5.0");
    expect(existsSync(stagedBinaryPath)).toBe(false);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.version).toBe("1.4.0");
    expect(manifest.pendingUpgrade.version).toBe("1.5.0");
    const marker = JSON.parse(readFileSync(writtenReceiptPath(), "utf8"));
    expect(marker).toMatchObject({
      status: "swapped",
      livePath: liveBinaryPath,
      stagedBinaryPath,
      serviceStartError: null,
    });
    expect(marker.errorMessage).toContain("manifest rename failed");
  });

  it("returns no-pending and still cycles the service when no upgrade is staged", async () => {
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.5.0",
          installedAt: "2026-05-01T00:00:00Z",
          binaryPath: join(workHome, "bin", "traycer"),
          source: "manual",
          pendingUpgrade: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const args = defaultArgs(controller);
    const result = await restartWithPendingCliUpgradeFinalize(
      args as never,
      testActuators(args, undefined),
    );
    expect(result.finalize.status).toBe("no-pending");
    expect(calls.calls).toEqual(["stopForRestart", "relaunchAfterRestart"]);
    expect(result.helper).toBeNull();
  });

  it("returns no-manifest when CLI has never been installed and still cycles the service", async () => {
    // Fresh machine: no CLI install manifest on disk. The restart
    // command must still cycle the host service - supervisor users
    // depend on `host restart` even before any CLI upgrade has
    // happened.
    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const args = defaultArgs(controller);
    const result = await restartWithPendingCliUpgradeFinalize(
      args as never,
      testActuators(args, undefined),
    );
    expect(result.finalize.status).toBe("no-manifest");
    expect(calls.calls).toEqual(["stopForRestart", "relaunchAfterRestart"]);
    expect(result.helper).toBeNull();
  });

  it("keeps an ordinary Windows relaunch failure outside CLI upgrade restoration", async () => {
    const calls: StubCalls = { calls: [], relaunchStop: null };
    const args = {
      ...defaultArgs(makeStubController(calls)),
      platform: "win32" as const,
    };
    const relaunchError = new Error("ordinary Windows relaunch failed");
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");

    await expect(
      restartWithPendingCliUpgradeFinalize(args as never, {
        stop: testActuators(args, undefined).stop,
        relaunch: async () => {
          throw relaunchError;
        },
      }),
    ).rejects.toBe(relaunchError);
    expect(calls.calls).toEqual(["stopForRestart"]);
    expect(windowsHandoff.serviceCalls).toEqual([]);
  });

  // Locked Windows case: the final rename fails with EBUSY while the
  // verified sibling copy can still be prepared.
  // `sentinel` plays what the helper script's guard wrote before the CLI's
  // arm wait gave up, including a late arm during the abandonment write.
  type HelperSentinel =
    | "armed"
    | "in-job"
    | "arm-publish-failed"
    | "runner-replaced"
    | "none"
    | "late-arm"
    | "prep-failed"
    | "arm-blocked"
    | "commit-failed"
    | "commit-blocked";
  async function runWindowsStillLocked(sentinel: HelperSentinel) {
    const { captureWindowsCliFixture } =
      await import("../../__tests__/support/windows-cli-entry-image");
    const runnerPath = join(workHome, "runner.exe");
    const runnerBytes = "original packaged runner";
    writeFileSync(runnerPath, runnerBytes);
    captureWindowsCliFixture(runnerPath);
    const runnerDigest = createHash("sha256").update(runnerBytes).digest("hex");
    const lockedDir = join(workHome, "locked-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer.exe");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0.exe");
    const stagedBytes = Buffer.from("staged-bytes-1.5.0");
    writeFileSync(stagedBinaryPath, stagedBytes);
    fsMocks.feedVersion = "1.5.0";
    fsMocks.feedSha256 = createHash("sha256").update(stagedBytes).digest("hex");
    fsMocks.failBinaryRenameTarget = liveBinaryPath;
    writeFileSync(
      `${stagedBinaryPath}.release-evidence.json`,
      await signedCliEvidence("1.5.0", fsMocks.feedSha256),
    );
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });
    const originalManifest = readFileSync(manifestPath, "utf8");
    fsMocks.failHelperPreparation = sentinel === "prep-failed";

    const { rmSync } = await import("node:fs");
    const sentinelFiles: string[] = [];
    const blocking =
      sentinel === "arm-blocked" || sentinel === "commit-blocked";
    const blockedIo = Promise.withResolvers<void>();
    try {
      const calls: StubCalls = { calls: [], relaunchStop: null };
      const controller = makeStubController(calls);
      const spawnCalls: Array<{
        command: string;
        args: readonly string[];
      }> = [];
      const writeCalls: Array<{ path: string; body: string }> = [];
      const spawnStub: RestartArgsBaseline["spawnImpl"] = (command, args) => {
        spawnCalls.push({ command, args });
        if (
          sentinel === "armed" ||
          sentinel === "commit-failed" ||
          sentinel === "commit-blocked"
        ) {
          const armedPath = (writeCalls[0]?.path ?? "").replace(
            /\.ps1$/,
            ".armed",
          );
          writeFileSync(armedPath, "99001");
          sentinelFiles.push(armedPath);
        } else if (
          sentinel === "in-job" ||
          sentinel === "arm-publish-failed" ||
          sentinel === "runner-replaced"
        ) {
          const notArmedPath = (writeCalls[0]?.path ?? "").replace(
            /\.ps1$/,
            ".not-armed",
          );
          if (sentinel === "runner-replaced") {
            // Recording spawner models the native helper edge. Native
            // PowerShell coverage executes the rendered guard itself.
            writeFileSync(runnerPath, "replacement runner bytes");
            expect(
              createHash("sha256")
                .update(readFileSync(runnerPath))
                .digest("hex"),
            ).not.toBe(runnerDigest);
          }
          writeFileSync(
            notArmedPath,
            sentinel === "runner-replaced" ? "runner-unverified" : sentinel,
          );
          sentinelFiles.push(notArmedPath);
        }
        return {
          pid: 1,
          unref: () => undefined,
          kill: () => undefined,
          exited: Promise.resolve({ exitCode: 0, errorMessage: null }),
        };
      };
      const writeStub: RestartArgsBaseline["writeImpl"] = async (
        path,
        body,
      ) => {
        writeCalls.push({ path, body });
        if (sentinel === "commit-failed" && path.endsWith(".committed")) {
          throw new Error("commit denied");
        }
        if (
          (sentinel === "commit-blocked" && path.endsWith(".committed")) ||
          (sentinel === "arm-blocked" && path.endsWith(".ps1"))
        ) {
          blockedIo.resolve();
          await new Promise<void>(() => undefined);
        }
      };
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const args = {
        ...defaultArgs(controller),
        platform: "win32",
        spawnImpl: spawnStub,
        writeImpl: writeStub,
      } as RestartArgsBaseline;
      const { serviceLabelFor } = await import("../../service/label");
      if (blocking)
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = withBootTaskDefinition(
        serviceLabelFor("production"),
        () =>
          restartWithPendingCliUpgradeFinalize(
            args as never,
            testActuators(args, undefined),
          ),
        ["logon"],
        null,
      );
      const expectsHandoff =
        sentinel === "armed" ||
        sentinel === "commit-failed" ||
        sentinel === "commit-blocked";
      const knownRefusal =
        sentinel === "in-job" || sentinel === "runner-replaced";
      const verified =
        expectsHandoff || knownRefusal
          ? pending
          : pending.then(
              () => {
                throw new Error("An unarmed helper was admitted");
              },
              (error: unknown) => {
                expect(error).toMatchObject({
                  message: expect.stringContaining(
                    "The CLI upgrade helper did not arm.",
                  ),
                });
                return null;
              },
            );
      if (blocking) {
        await blockedIo.promise;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const result = await verified;
      if (sentinel === "late-arm") {
        const armedPath = (writeCalls[0]?.path ?? "").replace(
          /\.ps1$/u,
          ".armed",
        );
        writeFileSync(armedPath, "99001");
        sentinelFiles.push(armedPath);
      }
      if (
        sentinel === "runner-replaced" ||
        sentinel === "prep-failed" ||
        sentinel === "late-arm"
      ) {
        expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
        expect(readFileSync(liveBinaryPath, "utf8")).toBe("live-bytes");
        expect(readFileSync(stagedBinaryPath)).toEqual(stagedBytes);
      }
      return {
        calls,
        result,
        spawnCalls,
        writeCalls,
        liveBinaryPath,
        stagedBinaryPath,
        stagedSha256: fsMocks.feedSha256,
        runnerPath,
        runnerDigest,
      };
    } finally {
      if (blocking) vi.useRealTimers();
      for (const f of sentinelFiles) rmSync(f, { force: true });
    }
  }

  it("hands the Windows relaunch to the armed helper without reporting it restored", async () => {
    const run = await runWindowsStillLocked("armed");
    expect(run.calls.calls).toEqual(["stopForRestart"]);
    expect(run.result?.serviceRestore).toBeNull();
    expect(run.result?.helper).not.toBeNull();
    expect(run.result?.helper?.status).toBe("armed");
    expect(run.result?.helper?.helperPid).toBe(99001);
    expect(run.result?.helperArmed).toBe(true);
    expect(run.spawnCalls).toHaveLength(1);
    expect(run.spawnCalls[0]?.command).toMatch(
      /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu,
    );
    expect(run.spawnCalls[0]?.args).toContain("-EncodedCommand");
    expect(run.spawnCalls[0]?.args).not.toContain("-File");
    expect(run.writeCalls).toHaveLength(2);
    expect(run.writeCalls[1]?.path).toMatch(/\.committed$/u);
    expect(run.writeCalls[1]?.body).toBe("99001");
    const script = run.writeCalls[0]?.body ?? "";
    expect(script).toContain("$ParentPid = 4242");
    expect(script).toContain(run.liveBinaryPath);
    expect(script).toContain(run.stagedBinaryPath);
    expect(run.stagedSha256).toBe(
      createHash("sha256")
        .update(Buffer.from("staged-bytes-1.5.0"))
        .digest("hex"),
    );
    expect(script).toContain("('traycer-cli-' + [Guid]::NewGuid())");
    expect(script).toContain(
      "$invokeBinary = Join-Path $invokeDir 'traycer.exe'",
    );
    expect(script).toContain(
      `[System.IO.File]::Copy(${powershellSingleQuoted(run.runnerPath)}, $invokeBinary, $false)`,
    );
    const openIndex = script.indexOf(
      "$stagedHandle = [System.IO.File]::Open($invokeBinary, 'Open', 'Read', 'Read')",
    );
    const digestIndex = script.indexOf(
      `if ($digest -ine '${run.runnerDigest}')`,
    );
    const armIndex = script.indexOf("# END ARM GUARD");
    const invokeIndex = script.indexOf("function Invoke-Worker");
    expect(script).toContain(`--expected-staged-sha256=${run.stagedSha256}`);
    expect(openIndex).toBeGreaterThan(-1);
    expect(digestIndex).toBeGreaterThan(openIndex);
    expect(armIndex).toBeGreaterThan(digestIndex);
    expect(invokeIndex).toBeGreaterThan(armIndex);
    expect(script).toContain("finally {");
    expect(script).toContain("$stagedHandle.Dispose()");
    expect(script).toContain(
      "Remove-Item -LiteralPath $invokeDir -Recurse -Force -ErrorAction SilentlyContinue",
    );
  });

  it.each([
    "prep-failed",
    "arm-blocked",
    "none",
    "late-arm",
    "arm-publish-failed",
  ] as const)(
    "keeps the host untouched if the helper cannot arm (%s)",
    async (fault) => {
      const run = await runWindowsStillLocked(fault);
      expect(run.calls.calls).toEqual([]);
      expect(
        run.writeCalls.some(({ path }) => path.endsWith(".committed")),
      ).toBe(false);
    },
  );

  it.each(["in-job", "runner-replaced"] as const)(
    "restarts through the parent after an explicit %s refusal",
    async (fault) => {
      const run = await runWindowsStillLocked(fault);
      expect(run.calls.calls).toEqual([
        "stopForRestart",
        "relaunchAfterRestart",
      ]);
      expect(run.result).toMatchObject({
        helperArmed: false,
        finalize: { status: "still-locked" },
      });
      expect(
        run.writeCalls.some(({ path }) => path.endsWith(".committed")),
      ).toBe(false);
    },
  );

  it.each(["commit-failed", "commit-blocked"] as const)(
    "keeps the armed helper as the only restoration owner after %s",
    async (fault) => {
      const run = await runWindowsStillLocked(fault);
      expect(run.calls.calls).toEqual(["stopForRestart"]);
      expect(run.result).toMatchObject({
        helperArmed: true,
        serviceRestore: "restore-failed",
      });
      expect(run.writeCalls[1]?.path).toMatch(/\.committed$/u);
    },
  );

  it("on POSIX still-locked, leaves pendingUpgrade visible and does NOT schedule the helper", async () => {
    // POSIX still-locked is a genuine read-only-install case, not a
    // current-process-holds-binary case. There is no benefit to a
    // detached helper there - the next CLI run can retry once the
    // operator fixes the install dir. Doctor still surfaces
    // pendingUpgrade.
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const lockedDir = join(workHome, "ro-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging-posix");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    writeManifest({ liveBinaryPath, stagedBinaryPath, version: "1.5.0" });

    const { chmodSync } = await import("node:fs");
    chmodSync(lockedDir, 0o555);

    try {
      const calls: StubCalls = { calls: [], relaunchStop: null };
      const controller = makeStubController(calls);
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const args = defaultArgs(controller);
      const result = await restartWithPendingCliUpgradeFinalize(
        args as never,
        testActuators(args, undefined),
      );
      expect(result.finalize.status).toBe("still-locked");
      expect(result.helper).toBeNull();
      // POSIX falls through to the normal start() - supervisor not
      // affected by the read-only install dir.
      expect(calls.calls).toEqual(["stopForRestart", "relaunchAfterRestart"]);
      const reread = JSON.parse(
        readFileSync(
          join(workHome, ".traycer", "cli", "manifest.json"),
          "utf8",
        ),
      );
      expect(reread.pendingUpgrade.version).toBe("1.5.0");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it("applies a prior helper's post-finalize marker (swapped) before cycling the service, clearing pendingUpgrade", async () => {
    // Simulates a Windows machine where the helper from a previous
    // `host restart` invocation succeeded after the CLI exited.
    // The marker file is on disk; this restart cycle reads it,
    // clears pendingUpgrade in the manifest, then proceeds with the
    // standard stop/start cycle.
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    // The helper already moved staged → live, so only the live file
    // exists. We mirror that here.
    writeFileSync(liveBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });
    // Marker written by a prior helper run.
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          status: "swapped",
          attemptedAt: "2026-05-11T00:00:00Z",
          livePath: liveBinaryPath,
          stagedBinaryPath,
          errorMessage: null,
          serviceStartError: null,
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const calls: StubCalls = { calls: [], relaunchStop: null };
    const controller = makeStubController(calls);
    const { restartWithPendingCliUpgradeFinalize } =
      await import("../host-restart");
    const args = defaultArgs(controller);
    const result = await restartWithPendingCliUpgradeFinalize(
      args as never,
      testActuators(args, undefined),
    );

    expect(result.markerReconcile?.status).toBe("applied-swapped");
    expect(calls.calls).toEqual(["stopForRestart", "relaunchAfterRestart"]);
    expect(result.helper).toBeNull();
    // pendingUpgrade is now null and the marker has been consumed.
    expect(existsSync(markerPath)).toBe(false);
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.0");
    expect(reread.pendingUpgrade).toBeNull();
  });

  it("applies a prior helper's swap-failed marker, consumes the marker, and surfaces the error message", async () => {
    // The previous helper attempt failed during the move. The marker
    // reconcile records the error and consumes the marker so we don't
    // re-apply it next cycle. (Whether the subsequent in-process
    // finalize succeeds depends on the install dir's writability;
    // either way the marker reconcile contract is independent.)
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const lockedDir = join(workHome, "ro-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging-failed");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });
    const markerPath = join(workHome, ".traycer", "cli", "post-finalize.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: "swap-failed",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath,
        errorMessage: "MoveFileEx error 5: Access denied",
        serviceStartError: null,
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const { chmodSync } = await import("node:fs");
    // Strip parent-dir write so the in-process finalize also returns
    // still-locked. That's the realistic shape for a swap-failed
    // marker: the underlying lock is still in place and the next
    // retry should keep pendingUpgrade visible.
    chmodSync(lockedDir, 0o555);

    try {
      const calls: StubCalls = { calls: [], relaunchStop: null };
      const controller = makeStubController(calls);
      const { restartWithPendingCliUpgradeFinalize } =
        await import("../host-restart");
      const args = defaultArgs(controller);
      const result = await restartWithPendingCliUpgradeFinalize(
        args as never,
        testActuators(args, undefined),
      );
      expect(result.markerReconcile?.status).toBe("applied-swap-failed");
      if (result.markerReconcile?.status === "applied-swap-failed") {
        expect(result.markerReconcile.errorMessage).toContain("Access denied");
      }
      expect(existsSync(markerPath)).toBe(false);
      const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
      // The marker reconcile alone does not clear pendingUpgrade on a
      // swap-failed outcome; the in-process finalize also failed
      // (locked dir), so pendingUpgrade survives.
      expect(reread.pendingUpgrade).not.toBeNull();
      expect(reread.pendingUpgrade.version).toBe("1.5.0");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });
});
