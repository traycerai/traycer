import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ownProcessStartIdentityAsync,
  ownProcessStartTimeMsAsync,
} from "@traycer-clients/shared/host-lock/process-identity";
import { noopLogger } from "../../logger";
import type { CommandContext, CommandFn } from "../../runner/runner";

// The read-only contract of the commands that ask about the OS service, on
// each service manager, with a host installed, its job ABSENT and the default
// lifecycle mode: the state a converging path would answer by registering. The
// commands and the platform controllers are real; every `node:child_process`
// export they could start a process with is replaced and recorded, so each row
// pins its exact list of calls and a new call fails whichever export it takes.
// A changed read has to change the list here, which is where it gets looked at.

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  // A refused route's second argument may be an options object or a callback.
  const record = (command: string, args: unknown) => {
    calls.push([command, ...(Array.isArray(args) ? args : [])].join(" "));
  };
  return {
    platform: process.platform as NodeJS.Platform,
    calls,
    // How each service manager answers for a job it does not have.
    run(command: string, args: readonly string[]) {
      record(command, args);
      if (command === "launchctl" && args[0] === "print") {
        return { stdout: "", stderr: "Could not find service", exitCode: 113 };
      }
      if (command === "schtasks" && args[0] === "/Query") {
        return {
          stdout: "",
          stderr: "ERROR: The system cannot find the file specified.",
          exitCode: 1,
        };
      }
      // This process's own identity, read once for a lock's metadata.
      if (command === "ps") {
        const stdout = args.includes("lstart=")
          ? "Sun Nov  1 07:00:00 2026\n"
          : "00:00\n";
        return { stdout, stderr: "", exitCode: 0 };
      }
      // The PATH check's two reads, which must differ for it to report.
      if (args.includes("--version")) {
        const version = command.includes("elsewhere") ? "1.0.0" : "1.5.2";
        return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
      }
      // The task-definition read's own "no such task".
      if (command === "powershell") {
        return { stdout: "", stderr: "", exitCode: 2 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    // A route nothing here is meant to use: recorded first, because the caller
    // may swallow the throw.
    refuse(route: string) {
      return (command: string, args: unknown) => {
        record(command, args);
        throw new Error(`unexpected ${route}`);
      };
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => mocks.platform };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  type ExecFileCallback = (
    error: Error | null,
    stdout: string,
    stderr: string,
  ) => void;
  const fake = {
    spawn: mocks.refuse("spawn"),
    spawnSync: mocks.refuse("spawnSync"),
    exec: mocks.refuse("exec"),
    execSync: mocks.refuse("execSync"),
    fork: mocks.refuse("fork"),
    execFile: Object.assign(
      (
        command: string,
        args: readonly string[],
        _options: object,
        callback: ExecFileCallback,
      ) => {
        const { stdout, stderr, exitCode } = mocks.run(command, args);
        const failure = exitCode === 0 ? null : new Error(`${command} failed`);
        callback(failure, stdout, stderr);
      },
      {
        [promisify.custom]: async (
          command: string,
          args: readonly string[],
        ) => {
          const result = mocks.run(command, args);
          if (result.exitCode === 0) return result;
          throw Object.assign(new Error(`${command} failed`), {
            code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        },
      },
    ),
    execFileSync: (command: string, args: readonly string[]) => {
      const result = mocks.run(command, args);
      if (result.exitCode !== 0) throw new Error(`${command} failed`);
      return result.stdout;
    },
  };
  const faked = { ...actual, ...fake };
  // The default export too: `...actual` alone leaves it real.
  return { ...faked, default: faked };
});

// Reads this process's `/proc/self/cgroup`, which has no answer off Linux and
// nothing to do with which verbs an install issues.
vi.mock("../../host/cgroup-relocation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/cgroup-relocation")>();
  return { ...actual, assertNotInsideHostUnit: async () => undefined };
});

vi.mock("../../service/process-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/process-runner")>();
  return {
    ...actual,
    runCommand: async (
      command: string,
      args: readonly string[],
      options: { readonly tolerateNonZeroExit: boolean },
    ) => {
      const result = mocks.run(command, args);
      if (result.exitCode !== 0 && !options.tolerateNonZeroExit) {
        throw new actual.ProcessRunError(
          `${command} failed`,
          command,
          args,
          result.exitCode,
          result.stdout,
          result.stderr,
        );
      }
      return result;
    },
    runCommandForBytes: async (command: string, args: readonly string[]) => {
      const result = mocks.run(command, args);
      return { ...result, stdout: Buffer.from(result.stdout) };
    },
  };
});

import { config } from "../../config";
import { DOCTOR_ISSUE_CODES } from "../../doctor/issues";
import { captureSpawnEvidenceBaseline } from "../../host/spawn-evidence";
import { writeHostInstallRecord } from "../../manifest/host-install";
import {
  createServiceController,
  serviceLabelFor,
  serviceManifestPath,
  windowsTaskName,
} from "../../service";
import {
  setWindowsStartEvidenceDepsForTests,
  setWindowsTaskUserSidReaderForTests,
} from "../../service/platforms/windows";
import {
  cliCredentialsPath,
  cliLogPath,
  hostDoctorLeasePath,
} from "../../store/paths";
import { hostDoctorCommand } from "../host-doctor";
import { hostStatusCommand } from "../host-status";
import { wellKnownCliBinaryPath } from "../../store/well-known-cli";
import { serviceStatusCommand } from "../service-status";

const label = serviceLabelFor("production");
const credentialsPath = cliCredentialsPath("production");

// The CLI's own log and the doctor's lease change on a read by design.
const BOOKKEEPING = [
  cliLogPath(config.environment),
  hostDoctorLeasePath(config.environment),
];

function homeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = readdirSync(homedir(), {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (BOOKKEEPING.includes(path)) continue;
    // A link counts: it is all `systemctl enable` leaves.
    if (entry.isSymbolicLink()) files[path] = `-> ${readlinkSync(path)}`;
    else if (entry.isFile()) files[path] = readFileSync(path, "base64");
  }
  return files;
}

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
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

const realPlatform = process.platform;

function usePlatform(platform: NodeJS.Platform): void {
  mocks.platform = platform;
  Object.defineProperty(process, "platform", { value: platform });
}

// Read once per process and kept, so otherwise whichever test ran first would
// own these calls in its list.
beforeAll(async () => {
  await ownProcessStartTimeMsAsync();
  await ownProcessStartIdentityAsync();
});

let filesBefore: Record<string, string>;

beforeEach(async () => {
  await writeHostInstallRecord("production", {
    installId: "install-1",
    version: "1.2.3",
    runtimeVersion: null,
    platform: "linux",
    arch: "x64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "1.2.3" },
    archiveSha256: "a".repeat(64),
    executableSha256: null,
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath: join(homedir(), "traycer-host"),
  });
  // Without one the doctor's Windows ACL probe has nothing to read.
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, "{}");
  filesBefore = homeFiles();
  mocks.calls.length = 0;
});

afterEach(() => {
  for (const path of Object.keys(homeFiles())) {
    if (!(path in filesBefore)) rmSync(path);
  }
  setWindowsStartEvidenceDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
  usePlatform(realPlatform);
  vi.unstubAllEnvs();
});

const gui = `gui/${process.getuid?.() ?? 0}`;
const launchdLookups = [
  `launchctl print ${gui}/${label.id}`,
  `launchctl print ${gui}/${label.id}.agent`,
];
const taskQuery = `schtasks /Query /TN ${windowsTaskName(label)}`;
// The task-definition read, whole: PowerShell has no verb to compare, so the
// script is the call.
const taskDefinitionRead =
  "powershell -NoProfile -NonInteractive -Command try{$s=New-Object -ComObject Schedule.Service;$s.Connect()}catch{[Console]::Error.Write('0x{0:X8}' -f $_.Exception.HResult);exit 4};try{$x=[string]$s.GetFolder('\\').GetTask($env:TRAYCER_TASK_NAME).Xml}catch{$e=$_.Exception;if($e.InnerException){$e=$e.InnerException};if(($e.HResult -eq -2147024894) -or ($e.HResult -eq -2147024893)){exit 2};[Console]::Error.Write('0x{0:X8}' -f $e.HResult);exit 4};[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($x)));exit 0";

interface ReadCommand {
  readonly run: CommandFn;
  // What only this command, run to its end on this state, can say.
  readonly reports: object;
}

const HOST_STATUS: ReadCommand = {
  run: hostStatusCommand,
  reports: {
    running: false,
    pidMetadata: null,
    bootstrap: null,
    updateAttempt: null,
    lastUpdateAttempt: null,
    updateLockHolder: null,
    lifecycle: { policy: { state: "absent", mode: "background" } },
  },
};
const SERVICE_STATUS: ReadCommand = {
  run: serviceStatusCommand,
  reports: { state: "not-installed", pid: null, version: null },
};
const HOST_DOCTOR: ReadCommand = {
  run: hostDoctorCommand,
  reports: {
    // By title too: the doctor files a failed status read under the same code.
    issues: expect.arrayContaining([
      expect.objectContaining({
        code: DOCTOR_ISSUE_CODES.SERVICE_NOT_REGISTERED,
        title: "Service not registered",
      }),
    ]),
  },
};

describe.each([
  {
    platform: "darwin",
    registers: "launchctl bootstrap",
    serviceStatusCalls: launchdLookups,
    doctorCalls: [...launchdLookups, ...launchdLookups],
  },
  {
    platform: "linux",
    registers: "systemctl --user enable",
    serviceStatusCalls: [],
    doctorCalls: ["systemctl --user show-environment"],
  },
  {
    platform: "win32",
    registers: "schtasks /Create",
    serviceStatusCalls: [taskQuery],
    doctorCalls: [
      taskQuery,
      taskDefinitionRead,
      taskDefinitionRead,
      `icacls ${credentialsPath}`,
    ],
  },
] as const)(
  "$platform, job absent",
  ({ platform, registers, serviceStatusCalls, doctorCalls }) => {
    it.each([
      { name: "host status", command: HOST_STATUS, calls: [] },
      {
        name: "host service status",
        command: SERVICE_STATUS,
        calls: serviceStatusCalls,
      },
      { name: "host doctor", command: HOST_DOCTOR, calls: doctorCalls },
    ])(
      "$name issues exactly its reads and changes no file",
      async ({ command, calls }) => {
        usePlatform(platform);

        const result = await command.run(makeCtx());

        expect(result.data).toMatchObject(command.reports);
        // Sorted: the doctor's probes run concurrently.
        expect(mocks.calls.toSorted()).toEqual(calls.toSorted());
        expect(homeFiles()).toEqual(filesBefore);
      },
    );

    // The other half of the contract, on the same fake: the empty lists above
    // are not an empty recorder.
    it("install registers the job", async () => {
      usePlatform(platform);
      const cli = join(homedir(), "traycer");
      writeFileSync(cli, "", { mode: 0o755 });
      setWindowsTaskUserSidReaderForTests(() => "S-1-5-21-1-2-3-1001");
      // No host answers the fake's `/Run`; the install would wait out the
      // proof that one started.
      setWindowsStartEvidenceDepsForTests({
        captureBaseline: captureSpawnEvidenceBaseline,
        createEvidenceReader: () => ({
          collect: async () => ({
            kind: "starting-marker",
            reason: "post-baseline starting marker",
            marker: null,
            pid: null,
          }),
        }),
        sleep: async () => undefined,
        verifyTimeoutMs: 5_000,
        verifyPollMs: 1,
      });

      await createServiceController().install({
        label,
        cli: { command: cli, args: [] },
        enableLinger: false,
      });

      expect(mocks.calls).toContainEqual(expect.stringContaining(registers));
      if (platform !== "win32") {
        expect(existsSync(serviceManifestPath(label))).toBe(true);
      }
    });
  },
);

// The rows above have no slot, so the doctor's PATH check spawns nothing there.
it("host doctor adds exactly two version reads with another CLI ahead of the slot", async () => {
  usePlatform("darwin");
  const slot = wellKnownCliBinaryPath("production");
  const other = join(homedir(), "elsewhere/traycer");
  for (const cli of [slot, other]) {
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "", { mode: 0o755 });
  }
  vi.stubEnv("PATH", dirname(other));
  const files = homeFiles();

  const result = await hostDoctorCommand(makeCtx());

  expect(result.data).toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({
        code: DOCTOR_ISSUE_CODES.CLI_SHADOWED_ON_PATH,
      }),
    ]),
  });
  expect(mocks.calls.toSorted()).toEqual(
    [
      ...launchdLookups,
      ...launchdLookups,
      `${other} --version`,
      `${slot} --version`,
    ].toSorted(),
  );
  expect(homeFiles()).toEqual(files);
});
