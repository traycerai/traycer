import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noopLogger } from "../../logger";
import type { CommandContext, CommandFn } from "../../runner/runner";

// The read-only contract of the commands that ask about the OS service, on
// each service manager: with a host installed and its job ABSENT - the lookup
// miss a converging path would answer by registering - they report the miss
// and issue no write. The commands and the platform controllers are real; only
// the processes they would spawn are faked, at every spawn route they have
// (`runCommand`, `runCommandForBytes`, and the doctor's own `execFile` and
// `execFileSync` probes). A verb nothing here has listed as a read counts as a
// write, so a new probe has to be declared rather than passing unnoticed.

const mocks = vi.hoisted(() => {
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    platform: "darwin" as "darwin" | "linux" | "win32",
    calls,
    // How each service manager answers for a job it does not have.
    run(command: string, args: readonly string[]) {
      calls.push({ command, args });
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
      // The task-definition read's own "no such task".
      if (command === "powershell") {
        return { stdout: "", stderr: "", exitCode: 2 };
      }
      if (command.endsWith("whoami.exe")) {
        const account = '"PC\\person","S-1-5-21-1-2-3-1001"\n';
        return { stdout: account, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
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
  const refuse = (route: string) => () => {
    throw new Error(`unexpected ${route}: no route but the fakes may spawn`);
  };
  return {
    ...actual,
    spawn: refuse("spawn"),
    execFile: Object.assign(refuse("callback execFile"), {
      [promisify.custom]: async (command: string, args: readonly string[]) => {
        const result = mocks.run(command, args);
        if (result.exitCode === 0) return result;
        throw Object.assign(new Error(`${command} failed`), {
          code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      },
    }),
    execFileSync: (command: string, args: readonly string[]) => {
      const result = mocks.run(command, args);
      if (result.exitCode !== 0) throw new Error(`${command} failed`);
      return result.stdout;
    },
  };
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

import { DOCTOR_ISSUE_CODES } from "../../doctor/issues";
import { writeHostInstallRecord } from "../../manifest/host-install";
import {
  createServiceController,
  serviceLabelFor,
  serviceManifestPath,
} from "../../service";
import { setWindowsStartEvidenceDepsForTests } from "../../service/platforms/windows";
import { captureSpawnEvidenceBaseline } from "../../host/spawn-evidence";
import { hostDoctorCommand } from "../host-doctor";
import { hostStatusCommand } from "../host-status";
import { serviceStatusCommand } from "../service-status";

type ServicePlatform = typeof mocks.platform;

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

// PowerShell has no verb of its own: its scripts are read for the Task
// Scheduler calls that change something.
const TASK_SCHEDULER_WRITE =
  /RegisterTask|DeleteTask|\.Run\(|\.Stop\(|\.Enabled\s*=/u;

function isServiceManagerRead({ command, args }: Call): boolean {
  switch (command) {
    case "launchctl":
      return args[0] === "print";
    case "systemctl":
      return [
        "show",
        "show-environment",
        "is-active",
        "is-system-running",
      ].includes(args.find((arg) => !arg.startsWith("-")) ?? "");
    case "loginctl":
      return args[0] === "show-user";
    case "schtasks":
      return args[0] === "/Query";
    case "powershell":
      return !args.some((arg) => TASK_SCHEDULER_WRITE.test(arg));
    default:
      return ["reg", "icacls", "whoami.exe"].some((tool) =>
        command.endsWith(tool),
      );
  }
}

const label = serviceLabelFor("production");

// The file a registration leaves on POSIX. Windows has none: the task lives in
// Task Scheduler, so there its `/Create` is the whole write.
function manifestOn(platform: ServicePlatform): string | null {
  return platform === "win32" ? null : serviceManifestPath(label);
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

function usePlatform(platform: ServicePlatform): void {
  mocks.platform = platform;
  Object.defineProperty(process, "platform", { value: platform });
}

beforeEach(async () => {
  mocks.calls.length = 0;
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
});

afterEach(() => {
  const manifest = manifestOn(mocks.platform);
  if (manifest !== null) rmSync(manifest, { force: true });
  setWindowsStartEvidenceDepsForTests(null);
  Object.defineProperty(process, "platform", { value: realPlatform });
});

const READ_COMMANDS: readonly (readonly [
  string,
  CommandFn,
  // What only a run that reached the lookup miss can say.
  (data: unknown) => void,
])[] = [
  [
    "host status",
    hostStatusCommand,
    (data) => expect(data).toMatchObject({ running: false }),
  ],
  [
    "host service status",
    serviceStatusCommand,
    (data) => expect(data).toMatchObject({ state: "not-installed" }),
  ],
  [
    "host doctor",
    hostDoctorCommand,
    (data) =>
      expect(data).toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: DOCTOR_ISSUE_CODES.SERVICE_NOT_REGISTERED,
          }),
        ]),
      }),
  ],
];

describe.each([
  ["darwin", "launchctl", "bootstrap"],
  ["linux", "systemctl", "enable"],
  ["win32", "schtasks", "/Create"],
] as const)("%s, job absent", (platform, manager, registerVerb) => {
  it.each(READ_COMMANDS)(
    "%s reports the miss and writes nothing",
    async (_name, command, reachedTheMiss) => {
      usePlatform(platform);

      const result = await command(makeCtx());

      reachedTheMiss(result.data);
      expect(mocks.calls.filter((c) => !isServiceManagerRead(c))).toEqual([]);
      const manifest = manifestOn(platform);
      if (manifest !== null) expect(existsSync(manifest)).toBe(false);
    },
  );

  // The other half of the contract, and what gives the empty lists above their
  // meaning: this fake and this classifier do see a registration.
  it("install registers the job", async () => {
    usePlatform(platform);
    const cli = join(homedir(), "traycer");
    writeFileSync(cli, "", { mode: 0o755 });
    // No host answers the fake's `/Run`; the install would wait out the proof
    // that one started.
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

    const writes = mocks.calls.filter((c) => !isServiceManagerRead(c));
    expect(
      writes.some(
        (c) => c.command === manager && c.args.includes(registerVerb),
      ),
    ).toBe(true);
    const manifest = manifestOn(platform);
    if (manifest !== null) expect(existsSync(manifest)).toBe(true);
  });
});
