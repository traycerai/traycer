import { mkdtempSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// `host uninstall` over a Scheduled Task another Windows user owns, driven
// through the REAL Windows controller on a fake runner, so what this proves is
// the whole chain: the command's payload and the verbs the controller issued.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-host-uninstall-owner-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

const CLI_HOME = mkdtempSync(
  join(tmpdir(), "traycer-host-uninstall-owner-cli-"),
);
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) => join(CLI_HOME, environment),
  };
});

afterAll(async () => {
  await rm(CLI_HOME, { recursive: true, force: true });
  await rm(osHome.current, { recursive: true, force: true });
});

const mocks = vi.hoisted(() => ({
  removeHostPidMetadata: vi.fn(),
}));
vi.mock("../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: mocks.removeHostPidMetadata,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" }),
  publishedHostProcessGone: () => false,
}));
vi.mock("../../service/platforms/desktop-agent-shutdown", () => ({
  requestCooperativeShutdownReporting: async () => ({ kind: "no-host" }),
}));
vi.mock("../../service/process-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/process-runner")>();
  return {
    ...actual,
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
});

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  const record =
    (level: string) =>
    (message: string, fields: unknown): void => {
      logged.lines.push(`${level} ${message} ${JSON.stringify(fields)}`);
    };
  return {
    ...actual,
    createCliLogger: () => ({
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    }),
  };
});

import { noopLogger } from "../../logger";
import {
  createWindowsController,
  setWindowsAccountSidResolverForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
  type ScheduledTaskXmlQuery,
} from "../../service/platforms/windows";
import { SERVICE_TASK_LEFT_IN_PLACE_MESSAGE } from "../../service/platforms/windows-task-gate";
import { serviceLabelFor } from "../../service";
import {
  runHostUninstall,
  type HostUninstallActuators,
  type RunHostUninstallDeps,
} from "../host-uninstall";

const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const OTHER_SID = "S-1-5-21-1111-2222-3333-1002";
const label = serviceLabelFor("dev");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function taskXml(userId: string): string {
  return `<Task><Principals><Principal id="Author"><UserId>${userId}</UserId></Principal></Principals><Settings><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>x</Command></Exec></Actions></Task>`;
}

let registered: ScheduledTaskXmlQuery = { kind: "absent" };

function slotRunner(): { runner: ProcessRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let live = [401];
  const runner: ProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const script = args.find((arg) => arg.includes("GetProcessById")) ?? "";
    if (
      command === "powershell.exe" &&
      args.some((arg) => arg.includes("Get-CimInstance Win32_Process"))
    ) {
      return {
        stdout: JSON.stringify(
          live.map((pid) => ({
            ProcessId: pid,
            ParentProcessId: 1,
            ClaimedParentProcessId: 1,
            Created: 0,
            Slot: true,
          })),
        ),
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "powershell.exe" && script.includes("$process.Kill()")) {
      const killed = new Set(
        [...script.matchAll(/ProcessId = (\d+);/g)].map((m) => Number(m[1])),
      );
      live = live.filter((pid) => !killed.has(pid));
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { runner, calls };
}

function launcherPath(): string {
  return join(CLI_HOME, label.environment, "host-start-hidden.vbs");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function depsWith(runner: ProcessRunner): RunHostUninstallDeps {
  return {
    readPublishedHost: async () => null,
    probeProcessExited: async () => "dead",
    createServiceController: () =>
      createWindowsController(runner, { now: () => 0 }),
    uninstallHost: async (options) => ({
      removedRecord: null,
      removedInstallDir: true,
      removedStagedDir: true,
      purgedRuntime: options.purgeChannelRuntime,
    }),
  };
}

const actuators: HostUninstallActuators = {
  uninstall: (controller, options) => controller.uninstall(options),
  stop: (controller, stopLabel, options) => controller.stop(stopLabel, options),
  verifyMutationCapability: async (): Promise<void> => undefined,
  discardAttemptRecord: null,
};

const context = {
  environment: "dev" as const,
  logger: noopLogger,
  progress: () => undefined,
};

const MUTATING = ["/End", "/Run", "/Create", "/Delete"];
const mutatingVerbs = (calls: readonly RecordedCall[]): string[] =>
  calls
    .filter(
      (call) =>
        call.command === "schtasks" && MUTATING.includes(call.args[0] ?? ""),
    )
    .map((call) => call.args[0] ?? "");
const folderDeletes = (calls: readonly RecordedCall[]) =>
  calls.filter((call) => call.args.some((arg) => arg.includes("DeleteFolder")));
const kills = (calls: readonly RecordedCall[]) =>
  calls.filter((call) =>
    call.args.some((arg) => arg.includes("$process.Kill()")),
  );

beforeEach(async () => {
  logged.lines.length = 0;
  mocks.removeHostPidMetadata.mockReset();
  mocks.removeHostPidMetadata.mockResolvedValue(undefined);
  Object.defineProperty(process, "platform", { value: "win32" });
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  setWindowsAccountSidResolverForTests(async () => null);
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => registered,
    predictCli: async () => {
      throw new Error("not used");
    },
    resolveCli: async () => {
      throw new Error("not used");
    },
  });
  await mkdir(dirname(launcherPath()), { recursive: true });
  await writeFile(launcherPath(), "launcher", "utf8");
});

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(null);
  setWindowsDefinitionDepsForTests(null);
  const nonDebug = logged.lines.filter((line) => !line.startsWith("debug "));
  for (const secret of [CALLER_SID, OTHER_SID]) {
    expect(nonDebug.join("\n")).not.toContain(secret);
  }
});

describe("host uninstall --all over a Scheduled Task another Windows user owns", () => {
  it("finishes this account's teardown and leaves the task: 0 /End, 0 /Delete, 0 folder delete; the sweep ran, the launcher and pid.json are gone; exit 0 with the warning", async () => {
    registered = { kind: "xml", xml: taskXml(OTHER_SID) };
    const { runner, calls } = slotRunner();

    const result = await runHostUninstall(
      { all: true },
      context,
      depsWith(runner),
      actuators,
    );

    expect(result.exitCode).toBe(0);
    expect(mutatingVerbs(calls)).toEqual([]);
    expect(folderDeletes(calls)).toHaveLength(0);
    expect(kills(calls).length).toBeGreaterThanOrEqual(1);
    expect(await exists(launcherPath())).toBe(false);
    expect(mocks.removeHostPidMetadata).toHaveBeenCalled();
    expect(result.data).toMatchObject({
      serviceWarning: {
        code: "E_SERVICE_TASK_NOT_OWNED",
        message: SERVICE_TASK_LEFT_IN_PLACE_MESSAGE,
        details: { reason: "other-owner" },
      },
    });
    expect(result.human ?? "").toContain(SERVICE_TASK_LEFT_IN_PLACE_MESSAGE);
    // The observed registration is another user's, so this account
    // deregistered nothing and says so.
    expect(result.human ?? "").not.toMatch(/deregistered OS service/i);
  });

  it("the result and the human line name no account", async () => {
    registered = { kind: "xml", xml: taskXml(OTHER_SID) };
    const { runner } = slotRunner();
    const result = await runHostUninstall(
      { all: true },
      context,
      depsWith(runner),
      actuators,
    );
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(OTHER_SID);
    expect(everything).not.toContain(CALLER_SID);
    expect(everything).not.toMatch(/S-1-\d/);
  });

  it("an unconfirmed task is left in place too", async () => {
    registered = { kind: "failed", reason: "access denied" };
    const { runner, calls } = slotRunner();
    const result = await runHostUninstall(
      { all: true },
      context,
      depsWith(runner),
      actuators,
    );
    expect(result.exitCode).toBe(0);
    expect(mutatingVerbs(calls)).toEqual([]);
    // T08 ruling 13: left in place as before, but not reported as another
    // user's - nothing confirmed whose it is.
    expect(result.data).toMatchObject({
      serviceWarning: {
        code: "E_SERVICE_TASK_NOT_OWNED",
        message:
          "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task in place; everything of yours was removed.",
        details: { reason: "unconfirmed" },
      },
    });
    expect(result.human ?? "").not.toContain("another Windows user");
  });

  it("control: the caller's own task is ended, deleted and its folder swept, and there is no warning", async () => {
    registered = { kind: "xml", xml: taskXml(CALLER_SID) };
    const { runner, calls } = slotRunner();
    const result = await runHostUninstall(
      { all: true },
      context,
      depsWith(runner),
      actuators,
    );
    expect(mutatingVerbs(calls)).toEqual(
      expect.arrayContaining(["/End", "/Delete"]),
    );
    expect(folderDeletes(calls)).toHaveLength(1);
    expect(result.data).toMatchObject({ serviceWarning: null });
    expect(result.human ?? "").not.toContain(
      SERVICE_TASK_LEFT_IN_PLACE_MESSAGE,
    );
  });
});

describe("bare host uninstall over another user's task", () => {
  it("removes the bytes, touches no registration, and carries the warning", async () => {
    registered = { kind: "xml", xml: taskXml(OTHER_SID) };
    const { runner, calls } = slotRunner();
    const result = await runHostUninstall(
      { all: false },
      context,
      depsWith(runner),
      actuators,
    );
    expect(result.exitCode).toBe(0);
    expect(mutatingVerbs(calls)).toEqual([]);
    expect(result.data).toMatchObject({
      serviceWarning: {
        code: "E_SERVICE_TASK_NOT_OWNED",
        message: SERVICE_TASK_LEFT_IN_PLACE_MESSAGE,
      },
    });
  });
});
