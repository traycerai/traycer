import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceController, ServiceLabel } from "../../service";

// `host apply` over a service registration that cannot simply be started: the
// bytes are committed and the command SUCCEEDS with a `postSwapWarning`,
// `runningActivated` false, and neither a `postSwapError` (which is what a
// failure is) nor a rollback. Two causes: the registration's owner disabled
// it (the re-registration carries that over and starts nothing), or the
// Scheduled Task is another Windows user's (the ownership gate refuses the
// write). The real service install lifecycle runs; only the controller / OS /
// contender boundaries are mocked (the harness of `apply-real-lifecycle.test.ts`).

// dropped promise. This suite closes both gaps: the lifecycle constructors
// are the real ones, only the controller / OS / contender boundaries are
// mocked, and every barrier is held open on a deferred promise so the
// actuator behind it must be proven not to have run.

type Environment = "dev" | "production";

let sandboxRoot = "";

function hostHomeFor(environment: Environment): string {
  return join(sandboxRoot, "host", environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
}
function stagingRootFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install-staging");
}
function stagedDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "staged");
}

const mocks = vi.hoisted(() => ({
  sandboxHome: "",
  controller: null as ServiceController | null,
  busyCheckCalls: 0,
  verifyCapabilityCalls: 0,
  // Every `(serviceLabel)` the wrapper's adoption publisher was invoked
  // with. Non-empty proves the publisher reached a real service start, not
  // merely that it was handed to the lifecycle (D-15's assertion, upgraded:
  // the real lifecycle actually calls it).
  adoptionPublishedFor: [] as string[],
  serviceManagerMayRespawnMock: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mocks.sandboxHome || actual.tmpdir(),
  };
});

vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async () => {
    mocks.busyCheckCalls += 1;
  },
}));

// The one function that would refuse a test-authored capability. Everything
// else in the contender module stays real - see `apply.test.ts` for the same
// narrow stub and why the capability itself cannot be forged.
vi.mock("../../host/update-contender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-contender")>();
  return {
    ...actual,
    requireCliUpdateMutationCapability: async (): Promise<void> => {
      mocks.verifyCapabilityCalls += 1;
    },
  };
});

// The far end of the wrapper's adoption chain: `update-mutation.ts` closes
// over this, `apply.ts` hands the closure to the lifecycle, and the real
// lifecycle invokes it immediately before asking the OS to start the host.
vi.mock("../../host/host-start-adoption", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/host-start-adoption")>();
  return {
    ...actual,
    publishHostStartAdoption: async (
      _capability: unknown,
      _contenderOptions: unknown,
      serviceLabel: string,
    ) => {
      mocks.adoptionPublishedFor.push(serviceLabel);
      return {
        waitForSpawn: async (): Promise<void> => undefined,
        cancel: async (): Promise<void> => undefined,
      };
    },
  };
});

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: (): ServiceController => {
      const controller = mocks.controller;
      if (controller === null) {
        throw new Error("no controller harness installed for this test");
      }
      return controller;
    },
    serviceLabelFor: (environment: Environment): ServiceLabel => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
    // `observeSwapQuiescence`'s post-stop check asks this facade (never
    // `platforms/` directly), which shells out to `launchctl print` /
    // `systemctl --user is-active` for real when it reaches the "no process
    // right now" arm - on a machine with a loaded, crash-throttled Traycer
    // agent, that reads the developer's own launchd/systemd state and
    // refuses the commit. `false` keeps every existing fixture here clearing
    // as an ordinary quiescent machine would.
    serviceManagerMayRespawn: (
      ...callArgs: Parameters<typeof actual.serviceManagerMayRespawn>
    ) => mocks.serviceManagerMayRespawnMock(...callArgs),
  };
});
mocks.serviceManagerMayRespawnMock.mockResolvedValue(false);

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: async () => ({
    command: "/usr/local/bin/traycer",
    args: ["host", "start"],
  }),
}));

// Reads the invoking user's REAL LaunchAgent plist on darwin. Partial mocks
// (not wholesale replacements) - `service/index.ts` imports
// `createMacosController` / `createLinuxController` from these same modules,
// and a wholesale factory here would silently drop them, working only by
// luck of what a given test happens to touch (CodeRabbit finding).
vi.mock("../../service/platforms/macos", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/macos")>();
  return {
    ...actual,
    readRegisteredCliInvocation: async () => null,
  };
});

// Shell out to schtasks / powershell / taskkill. `install-lifecycle.ts` and
// `service/index.ts` import the real module - `createWindowsController` among
// others - so a wholesale replacement here would drop those exports and work
// only by luck of what a given test touches. Spread the actual module instead.
vi.mock("../../service/platforms/windows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/platforms/windows")>();
  return {
    ...actual,
    killLingeringSlotProcesses: async () => undefined,
    describeSlotLockHolders: async () => [],
    epochMicrosNow: () => 0,
  };
});

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  return {
    ...actual,
    hostHomeDir: (environment: Environment) => hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostStagingRoot: (environment: Environment) => stagingRootFor(environment),
    hostStagedDir: (environment: Environment) => stagedDirFor(environment),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
    ensureHostStagingRoot: async (environment: Environment) => {
      mkdirSync(stagingRootFor(environment), { recursive: true });
    },
  };
});

import { applyHostWithAttempt } from "../../host/update-mutation";
import type { WithCliUpdateContenderOptions } from "../../host/update-contender";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import { currentInstallArch, currentInstallPlatform } from "../install";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { reportServiceInstallKeptDisabled } from "../../service/registration-repair";
import { serviceLabelFor } from "../../service/label";
import {
  SERVICE_TASK_NOT_OWNED_MESSAGE,
  serviceTaskNotOwnedError,
} from "../../service/platforms/windows-task-gate";
import {
  createWindowsController,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../../service/platforms/windows";
import { SERVICE_KEPT_DISABLED_WARNING } from "../../service/registration-owner";
import {
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";

const ENV: Environment = "production";
const fakeCapability: UpdateMutationCapability = { hostHomeDir: "unused" };
const fakeContenderOptions: WithCliUpdateContenderOptions = {
  environment: ENV,
  reason: "test-apply-service-warning",
  waitMs: 0,
  pollIntervalMs: 0,
  admission: "legacy-update-shadow",
};

async function writeInstallAndStage(): Promise<void> {
  const installDir = installDirFor(ENV);
  mkdirSync(installDir, { recursive: true });
  const executablePath = join(installDir, "traycer-host");
  writeFileSync(executablePath, "installed-bytes");
  const record: HostInstallRecord = {
    installId: "installed-id",
    version: "1.0.0",
    runtimeVersion: null,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    installedAt: new Date().toISOString(),
    source: { kind: "registry", value: "1.0.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: new Date().toISOString(),
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath,
    executableSha256: null,
  };
  await writeHostInstallRecord(ENV, record);
  const stagedDir = stagedDirFor(ENV);
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(join(stagedDir, "traycer-host"), "staged-bytes");
  const staged: HostStagedRecord = {
    schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
    stageId: "test-stage-id",
    version: "2.0.0",
    runtimeVersion: null,
    archiveSha256: "b".repeat(64),
    sizeBytes: 1,
    source: { kind: "registry", value: "2.0.0" },
    signatureKeyId: "test-key",
    signatureVerifiedAt: new Date().toISOString(),
    executablePath: "traycer-host",
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    executableSha256: null,
  };
  await writeHostStagedRecordAt(stagedDir, staged);
}

// A registered, STOPPED service whose install does what the Windows
// controller does in the case under test.
function controllerWhoseInstall(
  install: () => Promise<void>,
  calls: string[],
): ServiceController {
  return {
    status: async () => ({
      state: "stopped",
      version: null,
      listenUrl: null,
      pid: null,
    }),
    install: async () => {
      calls.push("install");
      await install();
    },
    uninstall: async () => undefined,
    stop: async () => {
      calls.push("stop");
    },
    start: async () => {
      calls.push("start");
    },
    restart: async () => undefined,
    stopForRestart: async () => ({ forcedRecycle: false }),
    relaunchAfterRestart: async () => {
      calls.push("relaunch");
    },
    hostStartAdoptionLabel: async (serviceLabel) => serviceLabel.id,
    retireCompetingRegistration: async () => ({ kind: "nothing-to-retire" }),
    takeoverDesktopRegistration: async () => ({ kind: "not-applicable" }),
  };
}

function applyOptions() {
  return {
    environment: ENV,
    force: false,
    noService: false,
    expectedStageFingerprint: null,
    acceptStoreFormatLoss: false,
    onProgress: () => undefined,
    expectedStagedVersion: null,
    onWillCommitStaged: null,
    onWillDisruptHost: null,
    hooks: { beforeSwapCommit: async () => {}, afterSwap: async () => {} },
  };
}

describe("host apply over a registration that is disabled, or another user's", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-apply-svc-warning-"));
    mocks.sandboxHome = sandboxRoot;
    mocks.controller = null;
    mocks.busyCheckCalls = 0;
    mocks.verifyCapabilityCalls = 0;
    mocks.adoptionPublishedFor = [];
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("control: an ordinary re-registration activates the host, with no warning", async () => {
    await writeInstallAndStage();
    const calls: string[] = [];
    mocks.controller = controllerWhoseInstall(async () => undefined, calls);
    const outcome = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      "terminal",
      applyOptions(),
    );
    expect(outcome).toMatchObject({
      outcome: "applied",
      runningActivated: true,
      postSwapError: null,
      postSwapWarning: null,
    });
  });

  it("a registration its owner disabled: applied, warning E_SERVICE_REGISTRATION_DISABLED, runningActivated false, no postSwapError", async () => {
    await writeInstallAndStage();
    const calls: string[] = [];
    // What the Windows controller's install does over a disabled task: keep
    // it disabled, report that, start nothing.
    mocks.controller = controllerWhoseInstall(async () => {
      reportServiceInstallKeptDisabled();
    }, calls);
    const outcome = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      "terminal",
      applyOptions(),
    );
    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") throw new Error("unreachable");
    expect(outcome.postSwapWarning?.code).toBe(
      CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
    );
    expect(outcome.postSwapWarning?.message).toContain(
      "disabled in Task Scheduler",
    );
    expect(outcome.runningActivated).toBe(false);
    expect(outcome.postSwapError).toBeNull();
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "staged-bytes",
    );
  });

  it("another user's task: applied, warning E_SERVICE_TASK_NOT_OWNED with the refusal's copy, runningActivated false, no postSwapError", async () => {
    await writeInstallAndStage();
    const calls: string[] = [];
    mocks.controller = controllerWhoseInstall(async () => {
      throw serviceTaskNotOwnedError(
        serviceLabelFor(ENV),
        "create",
        "other-owner",
      );
    }, calls);
    const outcome = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      "terminal",
      applyOptions(),
    );
    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") throw new Error("unreachable");
    expect(outcome.postSwapWarning).toEqual({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: SERVICE_TASK_NOT_OWNED_MESSAGE,
      details: { reason: "other-owner" },
    });
    expect(outcome.runningActivated).toBe(false);
    expect(outcome.postSwapError).toBeNull();
  });

  // T08 ruling 13: a task whose owner could not be confirmed is refused the
  // same way and carried as the same warning code, but the warning never
  // says another Windows user owns it.
  it("a task whose owner could not be confirmed: applied, warning E_SERVICE_TASK_NOT_OWNED with the unconfirmed copy and reason", async () => {
    await writeInstallAndStage();
    const calls: string[] = [];
    mocks.controller = controllerWhoseInstall(async () => {
      throw serviceTaskNotOwnedError(
        serviceLabelFor(ENV),
        "create",
        "unconfirmed",
      );
    }, calls);
    const outcome = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      "terminal",
      applyOptions(),
    );
    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") throw new Error("unreachable");
    expect(outcome.postSwapWarning).toEqual({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message:
        "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.",
      details: { reason: "unconfirmed" },
    });
    expect(outcome.runningActivated).toBe(false);
  });

  it("a failure that is neither stays a postSwapError with no warning", async () => {
    await writeInstallAndStage();
    const calls: string[] = [];
    mocks.controller = controllerWhoseInstall(async () => {
      throw new Error("schtasks /Create failed");
    }, calls);
    const outcome = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      "terminal",
      applyOptions(),
    );
    expect(outcome).toMatchObject({
      outcome: "applied",
      postSwapWarning: null,
      runningActivated: false,
    });
    if (outcome.outcome !== "applied") throw new Error("unreachable");
    expect(outcome.postSwapError).toContain("schtasks /Create failed");
  });
});

// Test 31b (T08 ruling 11): the whole chain with no mock at the seam. An
// explicit `host apply` runs the real install lifecycle, which re-registers
// the stopped service through the REAL Windows controller's `install` (on a
// fake process runner); between the gate's read and the create's confirm-read
// the task is disabled by its owner. The disable must be carried into the
// write, no `/Run` made, and the apply must end with the typed kept-disabled
// warning - the report crossing the controller -> lifecycle seam. `host
// apply` never registers a service the lifecycle reads as not installed (no
// bootstrap), so the bootstrap branch, where finding 4 lived, is driven the
// same way from the lifecycle in
// `service/__tests__/install-lifecycle-bootstrap-windows-real.test.ts`.
describe("31b: host apply over the real Windows controller, a disable injected mid-staging", () => {
  const CALLER_SID = "S-1-5-21-1000-2000-3000-1001";

  function callerTaskXml(enabled: boolean): string {
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals>
  <Settings><Enabled>${enabled ? "true" : "false"}</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>C:\\traycer.exe</Command></Exec></Actions>
</Task>`;
  }

  interface RecordedCall {
    readonly command: string;
    readonly args: readonly string[];
  }

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-apply-svc-31b-"));
    mocks.sandboxHome = sandboxRoot;
    mocks.controller = null;
    mocks.adoptionPublishedFor = [];
  });

  afterEach(() => {
    setWindowsDefinitionDepsForTests(null);
    setWindowsTaskInstallDepsForTests(null);
    setWindowsTaskUserSidReaderForTests(null);
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("a stopped registration: the write carries Enabled=false, 0 /Run, and the apply ends applied with the kept-disabled warning", async () => {
    await writeInstallAndStage();
    setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
    // The gate's own read finds the caller's task enabled; every later
    // read - the confirm-read after staging - finds it disabled by its
    // owner.
    const answers: readonly ScheduledTaskXmlQuery[] = [
      { kind: "xml", xml: callerTaskXml(true) },
      { kind: "xml", xml: callerTaskXml(false) },
    ];
    let reads = 0;
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        if (answer === undefined) throw new Error("unreachable");
        return answer;
      },
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const staged: boolean[] = [];
    setWindowsTaskInstallDepsForTests({
      stageTaskDefinition: async (_options, _userId, settingsEnabled) => {
        staged.push(settingsEnabled);
        return {
          tmpDir: join(sandboxRoot, "stage"),
          xmlPath: join(sandboxRoot, `stage-${String(staged.length)}.xml`),
        };
      },
      removeStagedTaskDefinition: async () => undefined,
    });
    const osCalls: RecordedCall[] = [];
    const run: ProcessRunner = async (command, args) => {
      osCalls.push({ command, args: [...args] });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const windows = createWindowsController(run, { now: () => 0 });
    const lifecycleCalls: string[] = [];
    mocks.controller = {
      ...controllerWhoseInstall(async () => undefined, lifecycleCalls),
      install: (options) => windows.install(options),
    };

    const outcome = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      "terminal",
      applyOptions(),
    );

    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") throw new Error("unreachable");
    expect(outcome.postSwapWarning).toEqual(SERVICE_KEPT_DISABLED_WARNING);
    expect(outcome.postSwapError).toBeNull();
    expect(outcome.runningActivated).toBe(false);
    // The disable reached the write: staged enabled from the first read,
    // staged again disabled from the confirm-read, and written once.
    expect(staged).toEqual([true, false]);
    const schtasks = osCalls.filter((call) => call.command === "schtasks");
    expect(schtasks.filter((call) => call.args[0] === "/Create")).toHaveLength(
      1,
    );
    expect(schtasks.filter((call) => call.args[0] === "/Run")).toEqual([]);
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "staged-bytes",
    );
  });
});
