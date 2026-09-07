import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";

import {
  buildLaunchAgentPlist,
  classifyLaunchdPrintOutput,
  createMacosController,
  isSmAppServiceLaunchAgentPath,
  readRegisteredCliInvocation,
  type ProcessRunner,
} from "../macos";
import {
  buildCompatibleHostStartScript,
  buildHostStartLauncherScript,
} from "../host-start-script";
import {
  ProcessRunError,
  ProcessSpawnError,
  type RunResult,
} from "../../process-runner";
import type { ServiceController } from "../../index";
import {
  serviceLabelFor,
  serviceLauncherScriptPath,
  smAppServiceAgentLabelId,
} from "../../label";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import {
  isServiceMutationAuthorityError,
  ServiceMutationAuthorityError,
} from "../../mutation-authority";
import { didServiceRegistrationCommit } from "../../cli-invocation-record";

const execFileAsync = promisify(execFile);

const MOCKS = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  readHostPidMetadataEvidence: vi.fn(),
  isProcessAlive: vi.fn(),
  cliLoggerWarn: vi.fn(),
  cliLoggerInfo: vi.fn(),
  requestCooperativeShutdown: vi.fn(),
  forceStopHostProcess: vi.fn(),
  readProcessStartIdentity: vi.fn(),
  getPublishedProcessIdentityVerdict: vi.fn(),
  probeHostHealth: vi.fn(),
}));

// The cooperative-shutdown RPC flow and the forced-kill path each have their
// own unit suite (`desktop-agent-shutdown.test.ts`); here they are a seam so
// the controller tests pin the ROUTING (which outcome leads to which launchd
// calls and which error) without dialing a WebSocket or signalling a real
// pid. This is a WHOLE-MODULE factory - every export of
// `desktop-agent-shutdown` used by `macos.ts` must be listed here, or the
// missing one comes back `undefined` and silently breaks the caller.
vi.mock("../desktop-agent-shutdown", () => ({
  requestCooperativeShutdown: MOCKS.requestCooperativeShutdown,
  forceStopHostProcess: MOCKS.forceStopHostProcess,
}));

// `uninstallService` warns through the real CLI logger when it boots out an
// SMAppService-owned label. The real logger appends to the invoking user's
// actual `~/.traycer` log file - stub it so the suite stays hermetic and the
// warning is assertable.
vi.mock("../../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      // `info` is assertable (not an anonymous fn) because the eviction line
      // IS the contract: `retireCompetingRegistration`'s outcome is
      // deliberately not threaded through the install lifecycle, so this log
      // is the only record that a running host was booted out.
      info: MOCKS.cliLoggerInfo,
      warn: MOCKS.cliLoggerWarn,
      error: vi.fn(),
    }),
  };
});

const HOST_PID_METADATA = {
  pid: 4242,
  hostId: "test-host",
  version: "1.2.3",
  websocketUrl: "ws://127.0.0.1:1234/rpc",
  startedAt: "2026-07-12T00:00:00.000Z",
};

vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: MOCKS.readHostPidMetadata,
  readHostPidMetadataEvidence: MOCKS.readHostPidMetadataEvidence,
}));

vi.mock("../../../store/cli-lock", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../store/cli-lock")>();
  return { ...actual, isProcessAlive: MOCKS.isProcessAlive };
});

// `probeLabelForTakeover` reads a live pid's start identity, and
// `processMayLiveOn` asks whether launchd's process is still the one it
// published - both live in `store/process-identity`. Stubbed the same way
// as `cli-lock` above so the takeover tests control the recycled-pid
// evidence directly instead of reading the real OS process table.
vi.mock("../../../store/process-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../store/process-identity")>();
  return {
    ...actual,
    readProcessStartIdentity: MOCKS.readProcessStartIdentity,
    getPublishedProcessIdentityVerdict:
      MOCKS.getPublishedProcessIdentityVerdict,
  };
});

// `refuseIfPublishedHostAlive` dials `probeHostHealth` once for an
// `indeterminate` verdict whose record predates identity tracking, to tell
// a still-running hand-run host apart from a stale record left behind by
// one long gone. Stubbed so the takeover tests control that dial directly
// instead of opening a real loopback socket.
vi.mock("../../health-probe", () => ({
  probeHostHealth: MOCKS.probeHostHealth,
}));

// Test isolation: `serviceManifestPath` normally resolves to the REAL
// `~/Library/LaunchAgents/<label>.plist` (via `os.homedir()`, which ignores
// `$HOME`), so running this suite would write - and `afterEach`-remove - the
// developer's actual host LaunchAgent, deregistering a running host.
// Redirect the manifest path to a private, uniquely-created temp dir so the
// suite never touches real macOS service registration or follows a predictable
// path another local user could pre-create.
const TEST_LAUNCH_AGENTS_DIR = mkdtempSync(
  join(tmpdir(), "traycer-macos-service-test-"),
);
vi.mock("../../label", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../label")>();
  return {
    ...actual,
    serviceManifestPath: (label: { readonly id: string }) =>
      join(TEST_LAUNCH_AGENTS_DIR, `${label.id}.plist`),
  };
});

// Ticket a849b064: macOS CLI service install must distinguish benign
// idempotent launchctl states (service already loaded) from real
// failures (permission denied, malformed plist, missing program, ...).
// Real failures should surface as `SERVICE_INSTALL_FAILED` /
// `SERVICE_CONTROL_FAILED` so Doctor + first-launch can rely on the
// signal. Tests below stub `launchctl` to exercise each path.

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

function buildSuccessResult(): RunResult {
  return { stdout: "", stderr: "", exitCode: 0 };
}

function buildLaunchctlError(args: {
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number;
  readonly command: string;
  readonly cmdArgs: readonly string[];
}): ProcessRunError {
  return new ProcessRunError(
    `${args.command} ${args.cmdArgs.join(" ")} exited with code ${args.exitCode}: ${args.stderr.trim() || args.stdout.trim()}`,
    args.command,
    args.cmdArgs,
    args.exitCode,
    args.stdout,
    args.stderr,
  );
}

describe("macOS service lifecycle", () => {
  const label = serviceLabelFor("production");
  const tempPlistDir = TEST_LAUNCH_AGENTS_DIR;
  let createdPlistPath: string | null = null;

  it("gives the host an 8,192 soft file-descriptor limit", () => {
    const plist = buildLaunchAgentPlist({
      label,
      cli: { command: "/usr/local/bin/traycer", args: [] },
    });

    expect(plist).toContain(`<key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>`);
    expect(plist).not.toContain("HardResourceLimits");
  });

  it("binds adoption to the loaded SMAppService agent label", async () => {
    const agentLabelId = smAppServiceAgentLabelId(label);
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] !== "print") {
        return buildSuccessResult();
      }
      const target = args[1] ?? "";
      if (target.endsWith(`/${agentLabelId}`)) {
        return {
          stdout: [
            "\tpath = (submitted by smd.321)",
            "\ttype = Submitted",
            "\tmanaged_by = com.apple.xpc.ServiceManagement",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "not loaded", exitCode: 1 };
    };

    const controller = createMacosController(runner);
    await expect(controller.hostStartAdoptionLabel(label)).resolves.toBe(
      agentLabelId,
    );
    expect(
      calls.some((call) => call.args[1]?.endsWith(`/${agentLabelId}`)),
    ).toBe(true);
  });

  // Change 9 (PR #1480 review round 4): the desktop-agent probe's `.catch`
  // used to fold EVERY launchctl failure into `not-loaded`, including a
  // revoked mutation capability - which would route adoption to the CLI's
  // own logical label and publish a grant the Desktop supervisor rejects.
  // The probe is advisory only for genuine launchctl faults (a hung/
  // unspawnable process, "not found"); an authority loss must propagate so
  // the caller parks/aborts instead of silently mis-adopting.
  it("propagates a service-mutation-authority loss from the desktop-agent probe instead of reading it as not-loaded", async () => {
    const agentLabelId = smAppServiceAgentLabelId(label);
    const authorityError = new ServiceMutationAuthorityError(
      new Error("maintenance lease revoked"),
    );
    const runner: ProcessRunner = async (command, args) => {
      if (args[0] !== "print") {
        return buildSuccessResult();
      }
      const target = args[1] ?? "";
      if (target.endsWith(`/${agentLabelId}`)) {
        throw authorityError;
      }
      return { stdout: "", stderr: "not loaded", exitCode: 1 };
    };

    const controller = createMacosController(runner);
    await expect(controller.hostStartAdoptionLabel(label)).rejects.toBe(
      authorityError,
    );
  });

  // Without this key, background-task management names the login item
  // after ProgramArguments[0] - literally "sh" from an "Unknown
  // Developer" - on every CLI-registered install (dev machines and the
  // desktop's takeover fallback alike). The association groups it under
  // the Traycer app in System Settings → Login Items.
  it("associates the LaunchAgent with the Traycer desktop app so Login Items does not show it as 'sh'", () => {
    const plist = buildLaunchAgentPlist({
      label,
      cli: { command: "/usr/local/bin/traycer", args: [] },
    });

    expect(plist).toContain(`<key>AssociatedBundleIdentifiers</key>
  <array>
    <string>ai.traycer.desktop</string>
  </array>`);
  });

  it("starts both an N-1 CLI without --service-label and a current CLI with it, preserving leading invocation args", async () => {
    const work = mkdtempSync(join(tmpdir(), "traycer-host-start-compat-"));
    const oldCli = join(work, "old-cli.sh");
    const newCli = join(work, "new-cli.sh");
    const oldArgs = join(work, "old-args.txt");
    const newArgs = join(work, "new-args.txt");
    const script = buildCompatibleHostStartScript("ai.traycer.host.compat");
    try {
      // An N-1 CLI has no `host capabilities` subcommand at all: commander
      // prints "unknown command" on stderr and exits 1. Reproduced exactly,
      // including the non-empty stderr the emitted script must swallow.
      await writeFile(
        oldCli,
        `#!/bin/sh
if [ "$1" = "host" ] && [ "$2" = "capabilities" ]; then
  echo "error: unknown command 'capabilities'" >&2
  exit 1
fi
printf '%s\\n' "$@" > ${JSON.stringify(oldArgs)}
`,
        "utf8",
      );
      await writeFile(
        newCli,
        `#!/bin/sh
if [ "$1" = "--entry=cli-entry.js" ] && [ "$2" = "host" ] && [ "$3" = "adoption-nonce" ]; then printf '%s\\n' '11111111-1111-4111-8111-111111111111'; exit 0; fi
if [ "$1" = "--entry=cli-entry.js" ] && [ "$2" = "host" ] && [ "$3" = "capabilities" ] && [ "$4" = "--has" ] && { [ "$5" = "service-label" ] || [ "$5" = "host-start-adoption-v2" ]; }; then exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(newArgs)}
`,
        "utf8",
      );
      await chmod(oldCli, 0o700);
      await chmod(newCli, 0o700);

      await execFileAsync("/bin/sh", ["-c", script, oldCli]);
      await execFileAsync("/bin/sh", [
        "-c",
        script,
        newCli,
        "--entry=cli-entry.js",
      ]);

      expect(await readFile(oldArgs, "utf8")).toBe("host\nstart\n");
      expect(await readFile(newArgs, "utf8")).toBe(
        "--entry=cli-entry.js\nhost\nstart\n--service-label\nai.traycer.host.compat\n--adoption-nonce\n11111111-1111-4111-8111-111111111111\n",
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("keeps the labelled compatibility arm when a current CLI has no adoption nonce", async () => {
    const work = mkdtempSync(join(tmpdir(), "traycer-host-start-no-nonce-"));
    const cli = join(work, "cli.sh");
    const args = join(work, "args.txt");
    const script = buildCompatibleHostStartScript("ai.traycer.host.compat");
    try {
      await writeFile(
        cli,
        `#!/bin/sh
if [ "$2" = "capabilities" ]; then exit 0; fi
if [ "$2" = "adoption-nonce" ]; then exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(args)}
`,
        "utf8",
      );
      await chmod(cli, 0o700);
      await execFileAsync("/bin/sh", ["-c", script, cli]);
      await expect(readFile(args, "utf8")).resolves.toBe(
        "host\nstart\n--service-label\nai.traycer.host.compat\n",
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // Runs the emitted launcher through its own `#!/bin/sh` shebang rather than
  // naming an interpreter, which Windows does not honour.
  it.skipIf(process.platform === "win32")(
    "launcher file: starts both an N-1 CLI without --service-label and a current CLI with it, preserving leading invocation args",
    async () => {
      const work = mkdtempSync(join(tmpdir(), "traycer-host-start-launcher-"));
      const launcher = join(work, "traycer-host-start");
      const oldCli = join(work, "old-cli.sh");
      const newCli = join(work, "new-cli.sh");
      const oldArgs = join(work, "old-args.txt");
      const newArgs = join(work, "new-args.txt");
      try {
        await writeFile(
          launcher,
          buildHostStartLauncherScript("ai.traycer.host.compat"),
          "utf8",
        );
        await chmod(launcher, 0o755);
        await writeFile(
          oldCli,
          `#!/bin/sh
if [ "$1" = "host" ] && [ "$2" = "capabilities" ]; then
  echo "error: unknown command 'capabilities'" >&2
  exit 1
fi
printf '%s\\n' "$@" > ${JSON.stringify(oldArgs)}
`,
          "utf8",
        );
        await writeFile(
          newCli,
          `#!/bin/sh
if [ "$1" = "--entry=cli-entry.js" ] && [ "$2" = "host" ] && [ "$3" = "adoption-nonce" ]; then printf '%s\\n' '11111111-1111-4111-8111-111111111111'; exit 0; fi
if [ "$1" = "--entry=cli-entry.js" ] && [ "$2" = "host" ] && [ "$3" = "capabilities" ] && [ "$4" = "--has" ] && { [ "$5" = "service-label" ] || [ "$5" = "host-start-adoption-v2" ]; }; then exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(newArgs)}
`,
          "utf8",
        );
        await chmod(oldCli, 0o700);
        await chmod(newCli, 0o700);

        await execFileAsync(launcher, [oldCli]);
        await execFileAsync(launcher, [newCli, "--entry=cli-entry.js"]);

        expect(await readFile(oldArgs, "utf8")).toBe("host\nstart\n");
        expect(await readFile(newArgs, "utf8")).toBe(
          "--entry=cli-entry.js\nhost\nstart\n--service-label\nai.traycer.host.compat\n--adoption-nonce\n11111111-1111-4111-8111-111111111111\n",
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );
  // Field observation 2026-07-28 (sfltool dumpbtm): with `/bin/sh` as
  // ProgramArguments[0], BTM recorded `Name: sh, Parent Identifier:
  // Unknown Developer` for every CLI-registered install, and
  // AssociatedBundleIdentifiers alone was probed and ignored for that
  // shape. The plist must execute the per-label launcher file, whose
  // basename is what macOS shows.
  it("puts the per-label launcher file first in ProgramArguments so BTM names the item traycer-host-start", () => {
    const plist = buildLaunchAgentPlist({
      label,
      cli: { command: "/usr/local/bin/traycer", args: ["--entry=e.js"] },
    });

    const launcherPath = serviceLauncherScriptPath(label);
    expect(launcherPath.endsWith(`/${label.id}/traycer-host-start`)).toBe(true);
    expect(plist).toContain(`<key>ProgramArguments</key>
  <array>
    <string>${launcherPath}</string>
    <string>/usr/local/bin/traycer</string>
    <string>--entry=e.js</string>
  </array>`);
    expect(plist).not.toContain("/bin/sh");
  });

  // The blocker this contract replaces: `--service-label` used to be passed
  // only when it appeared in `host start --help` output, so applying the
  // file's own `.hideHelp()` convention to an "Internal:" option silently
  // dropped the identity binding with every test still green. Pin that the
  // emitted script asks the machine contract and nothing else.
  it("probes the capability subcommand, never help output", () => {
    const script = buildCompatibleHostStartScript("ai.traycer.host.compat");
    expect(script).toContain("host capabilities --has service-label");
    expect(script).not.toContain("--help");
    expect(script).not.toContain("grep");
  });

  // systemd's ExecStart guard rejects these characters outright, and the
  // macOS plist shares this exact script - keep the one emitter honest for
  // both consumers.
  it("emits a single-line script free of characters systemd mis-parses", () => {
    const script = buildCompatibleHostStartScript("ai.traycer.host.compat");
    expect(script).not.toMatch(/[%;\n\t]/);
  });

  beforeEach(() => {
    createdPlistPath = null;
    MOCKS.readHostPidMetadata.mockReset();
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    MOCKS.readHostPidMetadataEvidence.mockReset();
    MOCKS.readHostPidMetadataEvidence.mockResolvedValue({ kind: "absent" });
    MOCKS.isProcessAlive.mockReset();
    MOCKS.isProcessAlive.mockReturnValue(false);
    MOCKS.readProcessStartIdentity.mockReset();
    MOCKS.readProcessStartIdentity.mockReturnValue(null);
    MOCKS.getPublishedProcessIdentityVerdict.mockReset();
    MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("indeterminate");
    MOCKS.probeHostHealth.mockReset();
    MOCKS.probeHostHealth.mockResolvedValue({
      healthy: false,
      detail: "no host",
    });
    MOCKS.cliLoggerWarn.mockReset();
    MOCKS.cliLoggerInfo.mockReset();
    MOCKS.requestCooperativeShutdown.mockReset();
    // No test may reach the cooperative flow without staging an explicit
    // outcome - an unstaged call resolving `undefined` would satisfy
    // loosely-written assertions by accident.
    MOCKS.requestCooperativeShutdown.mockRejectedValue(
      new Error("requestCooperativeShutdown outcome not staged in this test"),
    );
    MOCKS.forceStopHostProcess.mockReset();
    // Same discipline as the cooperative flow above, for the forced-kill seam.
    MOCKS.forceStopHostProcess.mockRejectedValue(
      new Error("forceStopHostProcess outcome not staged in this test"),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    // installService writes a plist to ~/Library/LaunchAgents/<label>.plist
    // - clean it up so a failed run doesn't leak between tests. We only
    // touch the specific test label to avoid clobbering a real install
    // on the developer's machine.
    if (createdPlistPath !== null) {
      await rm(createdPlistPath, { force: true });
    }
  });

  afterAll(async () => {
    await rm(tempPlistDir, { recursive: true, force: true });
  });

  it("on an existing registration runs print → bootout → bootstrap → kickstart and returns cleanly", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await controller.install({
      label,
      cli: { command: "/usr/local/bin/traycer", args: [] },
      enableLinger: false,
    });
    // `print` probes whether the service is already loaded; when it is
    // (mock returns exit=0), the install path tears down the existing
    // registration via bootout before bootstrapping the freshly-written
    // plist - that's what makes Re-register survive the "already
    // loaded" / EIO case launchctl bootstrap would otherwise hit.
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
    // The register step must NOT force-kill a healthy host: `-k` would
    // make launchd block the respawn for the plist's ThrottleInterval.
    const kickstart = calls.find((c) => c.args[0] === "kickstart");
    expect(kickstart?.args).not.toContain("-k");
    const plistContents = await readFile(createdPlistPath, "utf8");
    expect(plistContents).toContain(label.id);
    // No --environment - the host resolves its slot from config.environment.
    expect(plistContents).not.toContain("--environment");
  });

  it("writes the plist and registers regardless of TRAYCER_HOST_SKIP_SERVICE_REGISTER (env hack removed)", async () => {
    const previous = process.env.TRAYCER_HOST_SKIP_SERVICE_REGISTER;
    process.env.TRAYCER_HOST_SKIP_SERVICE_REGISTER = "1";
    try {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        return buildSuccessResult();
      };
      const controller = createMacosController(runner);
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      });
      // The CLI is the sole owner now - the legacy host-delegation env
      // var must no longer short-circuit registration.
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "bootstrap",
        "kickstart",
      ]);
      const plistContents = await readFile(createdPlistPath, "utf8");
      expect(plistContents).toContain(label.id);
    } finally {
      if (previous === undefined) {
        delete process.env.TRAYCER_HOST_SKIP_SERVICE_REGISTER;
      } else {
        process.env.TRAYCER_HOST_SKIP_SERVICE_REGISTER = previous;
      }
    }
  });

  it("on a fresh machine (print fails with exit≠0) skips bootout entirely so a failed bootstrap can't leave the user worse off than before", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args, options) => {
      calls.push({ command, args });
      if (args[0] === "print") {
        // `launchctl print` returns non-zero when the service isn't
        // loaded. isServiceLoaded honours `tolerateNonZeroExit:true` by
        // resolving with a non-zero `RunResult` rather than throwing,
        // so the install path observes "not loaded" and skips bootout.
        if (options.tolerateNonZeroExit) {
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Could not find specified service\n",
          stdout: "",
          exitCode: 113,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootstrap",
      "kickstart",
    ]);
  });

  it("surfaces a real launchctl bootout failure (permission denied) as SERVICE_INSTALL_FAILED instead of silently swallowing it", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootout") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Bootout failed: 5: Operation not permitted\n",
          stdout: "",
          exitCode: 5,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining("bootout"),
    });
    // Both print probes (CLI + agent label) + bootout attempted;
    // bootstrap/kickstart never run.
    expect(calls.map((c) => c.args[0])).toEqual(["print", "print", "bootout"]);
  });

  it("on bootstrap 'already loaded' races, reloads via bootout → bootstrap rather than kickstarting the cache", async () => {
    const calls: RecordedCall[] = [];
    let bootstrapAttempts = 0;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootstrap") {
        bootstrapAttempts += 1;
        // First bootstrap loses a race (another process re-loaded the
        // job). Retry path must bootout + bootstrap again so launchd
        // reads the on-disk plist; a bare kickstart would keep the
        // cached definition.
        if (bootstrapAttempts === 1) {
          throw buildLaunchctlError({
            command,
            cmdArgs: args,
            stderr: "Bootstrap failed: 37: Service is already loaded\n",
            stdout: "",
            exitCode: 37,
          });
        }
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "print",
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
  });
  it("fails closed when race-recovery bootout is denied", async () => {
    const calls: RecordedCall[] = [];
    let bootstrapAttempts = 0;
    let bootoutAttempts = 0;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootstrap") {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) {
          throw buildLaunchctlError({
            command,
            cmdArgs: args,
            stderr: "Bootstrap failed: 37: Service is already loaded\n",
            stdout: "",
            exitCode: 37,
          });
        }
      }
      if (args[0] === "bootout") {
        bootoutAttempts += 1;
        if (bootoutAttempts === 2) {
          throw buildLaunchctlError({
            command,
            cmdArgs: args,
            stderr: "Boot-out failed: 5: Operation not permitted\n",
            stdout: "",
            exitCode: 5,
          });
        }
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);

    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "print",
      "bootout",
    ]);
  });

  it("treats a second 'already loaded' after the reload bootout as a concurrent installer's fresh definition - install succeeds and kickstarts it", async () => {
    // Every path that bootstraps this label rewrites the manifest first, so
    // a racer that re-bootstrapped between our bootout and bootstrap loaded
    // a freshly regenerated plist - NOT the stale cache the reload evicts.
    // This used to be misreported as SERVICE_INSTALL_FAILED.
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootstrap") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Bootstrap failed: 37: Service is already loaded\n",
          stdout: "",
          exitCode: 37,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);

    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "print",
      "bootout",
      "bootstrap",
      "print",
      "kickstart",
    ]);
  });
  it("refuses to bootout Desktop's SMAppService job when it wins the reload race before the recovery bootout", async () => {
    // A competing registrar that re-loads the label between the CLI's
    // failed first bootstrap and the reload recovery's own bootout may be
    // Desktop's SMAppService, not another CLI process. The reload must
    // re-verify ownership and refuse to bootout/bootstrap Desktop's job.
    const calls: RecordedCall[] = [];
    const smPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist";
    let cliPrintAttempts = 0;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "print") {
        // The agent-label probe reads not-loaded on this machine.
        if (args[1]?.endsWith(".agent") === true) {
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        cliPrintAttempts += 1;
        // First CLI-label print (installService's upfront check) sees no
        // SMAppService owner; the reload recovery's re-check (second
        // CLI-label print) finds Desktop's SMAppService won the race.
        if (cliPrintAttempts >= 2) {
          return { stdout: `path = ${smPath}\n`, stderr: "", exitCode: 0 };
        }
        return buildSuccessResult();
      }
      if (args[0] === "bootstrap") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Bootstrap failed: 37: Service is already loaded\n",
          stdout: "",
          exitCode: 37,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);

    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining("SMAppService"),
    });
    // The re-check runs BEFORE the recovery bootout - no second
    // bootout/bootstrap/kickstart against Desktop's job.
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "print",
    ]);
  });

  it("refuses to treat a post-bootout 'already loaded' as a benign race win when Desktop's SMAppService is the new owner", async () => {
    // Mirror of the above, one step later: Desktop's SMAppService can also
    // win the race in the window between the reload's OWN bootout and its
    // bootstrap retry. The existing "concurrent installer" benign-success
    // path must not kickstart Desktop's job.
    const calls: RecordedCall[] = [];
    const smPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist";
    let cliPrintAttempts = 0;
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "print") {
        // The agent-label probe reads not-loaded on this machine.
        if (args[1]?.endsWith(".agent") === true) {
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        cliPrintAttempts += 1;
        // Third CLI-label print (post-bootout re-check inside the reload)
        // finds Desktop's SMAppService now owns the label.
        if (cliPrintAttempts >= 3) {
          return { stdout: `path = ${smPath}\n`, stderr: "", exitCode: 0 };
        }
        return buildSuccessResult();
      }
      if (args[0] === "bootstrap") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Bootstrap failed: 37: Service is already loaded\n",
          stdout: "",
          exitCode: 37,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);

    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining("SMAppService"),
    });
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "print",
      "bootout",
      "bootstrap",
      "print",
    ]);
    expect(calls.some((c) => c.args[0] === "kickstart")).toBe(false);
  });

  it.skip("inherits the regenerated descriptor limit through a real re-register/spawn", () => {
    // This requires mutating the live user's LaunchAgent and launchd state;
    // the suite intentionally redirects manifests to a private temp dir.
  });

  it("surfaces a real launchctl bootstrap failure (permission denied) as SERVICE_INSTALL_FAILED", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootstrap") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Bootstrap failed: 5: Operation not permitted\n",
          stdout: "",
          exitCode: 5,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
    // We never reach kickstart when bootstrap fails for real, but the
    // print probe + bootout reload step still ran.
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
    ]);
  });

  it("surfaces a launchctl kickstart failure as SERVICE_CONTROL_FAILED", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "kickstart") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Could not kickstart service: 3\n",
          stdout: "",
          exitCode: 3,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
    });
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
  });

  // `registrationCommitted: true` is the signal `didServiceRegistrationCommit`
  // reads: `bootstrap` already succeeded here (launchd holds the
  // registration), so a caller holding a host-start adoption lease must
  // honour it rather than treat this as a clean pre-registration failure.
  it("marks a kickstart failure after a successful bootstrap as a committed registration", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "kickstart") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Could not kickstart service: 3\n",
          stdout: "",
          exitCode: 3,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    let caught: unknown = null;
    try {
      await controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      details: { registrationCommitted: true },
    });
    expect(didServiceRegistrationCommit(caught)).toBe(true);
  });

  // The negative twin: a `bootstrap` failure happens BEFORE the registration
  // is in launchd's hands, so it must never carry the committed flag.
  it("does not mark a bootstrap failure (pre-registration) as a committed registration", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootstrap") {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Bootstrap failed: 5: Operation not permitted\n",
          stdout: "",
          exitCode: 5,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    let caught: unknown = null;
    try {
      await controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
    expect(didServiceRegistrationCommit(caught)).toBe(false);
  });

  it("uses a bounded launchd completion barrier when pid metadata is missing", async () => {
    const calls: Array<{
      readonly args: readonly string[];
      readonly timeoutMs: number;
      readonly tolerateNonZeroExit: boolean;
    }> = [];
    const runner: ProcessRunner = async (_command, args, options) => {
      calls.push({
        args,
        timeoutMs: options.timeoutMs,
        tolerateNonZeroExit: options.tolerateNonZeroExit,
      });
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);

    await controller.uninstall({ label });

    expect(calls).toEqual([
      {
        // Advisory ownership probes (SMAppService warnings) - tolerated
        // non-zero so a clean machine skips straight to the bootouts.
        args: ["print", `gui/${process.getuid?.() ?? 0}/${label.id}`],
        timeoutMs: 10_000,
        tolerateNonZeroExit: true,
      },
      {
        args: ["print", `gui/${process.getuid?.() ?? 0}/${label.id}.agent`],
        timeoutMs: 10_000,
        tolerateNonZeroExit: true,
      },
      {
        // Agent label first - it is the live job on post-label-split
        // Desktop machines.
        args: [
          "bootout",
          "--wait",
          `gui/${process.getuid?.() ?? 0}/${label.id}.agent`,
        ],
        timeoutMs: SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS,
        tolerateNonZeroExit: false,
      },
      {
        args: [
          "bootout",
          "--wait",
          `gui/${process.getuid?.() ?? 0}/${label.id}`,
        ],
        timeoutMs: SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS,
        tolerateNonZeroExit: false,
      },
    ]);
    expect(MOCKS.readHostPidMetadata).not.toHaveBeenCalled();
    expect(MOCKS.isProcessAlive).not.toHaveBeenCalled();
  });

  it("treats an already-removed launchd service as a successful uninstall", async () => {
    const runner: ProcessRunner = async (command, args) => {
      throw buildLaunchctlError({
        command,
        cmdArgs: args,
        stderr: "Boot-out failed: 3: No such process\n",
        stdout: "",
        exitCode: 3,
      });
    };
    const controller = createMacosController(runner);

    await expect(controller.uninstall({ label })).resolves.toBeUndefined();
  });

  it("surfaces a real bootout failure and preserves the service manifest", async () => {
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await writeFile(createdPlistPath, "test manifest", "utf8");
    const runner: ProcessRunner = async (command, args) => {
      throw buildLaunchctlError({
        command,
        cmdArgs: args,
        stderr: "Boot-out failed: 1: Operation not permitted\n",
        stdout: "",
        exitCode: 1,
      });
    };
    const controller = createMacosController(runner);

    await expect(controller.uninstall({ label })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("Operation not permitted"),
    });
    await expect(readFile(createdPlistPath, "utf8")).resolves.toBe(
      "test manifest",
    );
  });

  it("surfaces a bootout timeout instead of treating it as already removed", async () => {
    const runner: ProcessRunner = async (command, args) => {
      throw new ProcessRunError(
        `${command} ${args.join(" ")} timed out`,
        command,
        args,
        -1,
        "",
        "",
      );
    };
    const controller = createMacosController(runner);

    await expect(controller.uninstall({ label })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("timed out"),
    });
  });

  it("waits through delayed host exit when stopping", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const runner: ProcessRunner = async () => buildSuccessResult();
    const controller = createMacosController(runner);

    const stopping = controller.stop(label, { force: false });
    await vi.advanceTimersByTimeAsync(300);

    await expect(stopping).resolves.toBeUndefined();
    expect(MOCKS.isProcessAlive).toHaveBeenCalledTimes(3);
  });

  it("rejects when a stopped host remains alive through the shutdown timeout, naming --force as the escalation path", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    const runner: ProcessRunner = async () => buildSuccessResult();
    const controller = createMacosController(runner);

    const stopping = controller.stop(label, { force: false });
    const result = expect(stopping).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("stop did not take effect"),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();

    await result;
    // Without --force this is a dead end unless the message names the way
    // out - never escalates to SIGKILL on its own. Re-assert against the
    // SAME already-settled promise (not a fresh call) - a second `stop()`
    // would need its own ~32s fake-timer advance to time out too.
    await expect(stopping).rejects.toMatchObject({
      message: expect.stringContaining("Re-run with --force"),
    });
  });

  // CLI-owned `stop --force` goes straight to the child-kill engine
  // (`forceStopHostProcess`) from the OUTSET - no launchd TERM relay first,
  // no wait, no launchd kill of ANY kind, KILL or otherwise. Round 5 had
  // force escalate ONLY after outliving the plain SIGTERM's wait (stacking
  // a second full exit grace on a wedged host); round 6 removed that double
  // grace entirely, so these cases no longer need fake timers - the force
  // path never waits inside `stopService` at all. `launchctl kill KILL` is
  // still never used at the job: the job's service process is the
  // `host start` SUPERVISOR, and SIGKILL is untrappable -
  // `KeepAlive{Crashed:true}` would respawn a replacement that reads the
  // on-disk stop intent as already-served and starts a FRESH host, undoing
  // the stop. Escalating against the identity-verified HOST CHILD instead
  // leaves the supervisor alive to consume the intent and exit cleanly, so
  // the job stays down. Reuses the exact `MOCKS.forceStopHostProcess`
  // stubbing pattern the Desktop-managed force tests below already
  // establish - same seam, same outcome union, different caller.
  describe("CLI-owned stop --force (straight to forceStopHostProcess, no launchd kill of any kind)", () => {
    function stageForceStop(): {
      calls: RecordedCall[];
      controller: ServiceController;
    } {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        return buildSuccessResult();
      };
      return { calls, controller: createMacosController(runner) };
    }

    it("goes straight to forceStopHostProcess with operation 'stop' - no TERM, no KILL, no wait on pid.json at all", async () => {
      const { calls, controller } = stageForceStop();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.stop(label, { force: true }),
      ).resolves.toBeUndefined();

      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith(
        label.environment,
        "stop",
      );
      // No launchctl kill of any kind - neither the old TERM relay nor a
      // KILL at the job - ever happens on the force path now.
      const launchctlKillCalls = calls.filter(
        (call) => call.command === "launchctl" && call.args[0] === "kill",
      );
      expect(launchctlKillCalls).toEqual([]);
      // The instance-matched pid.json purge lives entirely inside
      // `forceStopHostProcess` (mocked here) - `stopService` itself never
      // reads pid.json on the force path.
      expect(MOCKS.readHostPidMetadata).not.toHaveBeenCalled();
    });

    it("resolves when forceStopHostProcess reports no-host (the pid was already gone)", async () => {
      const { controller } = stageForceStop();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "no-host" });

      await expect(
        controller.stop(label, { force: true }),
      ).resolves.toBeUndefined();
    });

    it("throws SERVICE_CONTROL_FAILED naming the missing endpoint when forceStopHostProcess reports no-metadata", async () => {
      const { controller } = stageForceStop();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "no-metadata" });

      await expect(
        controller.stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("no host endpoint is published"),
      });
    });

    it("throws SERVICE_CONTROL_FAILED naming the identity refusal when forceStopHostProcess reports identity-unverified", async () => {
      const { controller } = stageForceStop();
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "identity-unverified",
        pid: 4242,
      });

      await expect(
        controller.stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("could not verify"),
      });
    });

    it("throws SERVICE_CONTROL_FAILED naming the survived-SIGKILL pid when forceStopHostProcess reports hung", async () => {
      const { controller } = stageForceStop();
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });

      await expect(
        controller.stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("the stop did not take effect."),
      });
    });
  });

  it("forces a recycle on the CLI-owned restart, because the supervisor outlives the host pid it waited on", async () => {
    // `stopService` waits on the pid `pid.json` publishes - the HOST. The
    // launchd job is the SUPERVISOR, and it outlives its child by the whole
    // post-mortem (stderr end wait, tee flush, crash-report scan), longer still
    // when a grandchild holds the inherited stderr open. In that window the
    // host is gone, this call has returned, and launchd still considers the job
    // running - so the plain kickstart `forcedRecycle: false` selects is a
    // silent no-op and the "successful" restart leaves no host.
    //
    // It used to be survivable by accident: the supervisor exited with its
    // signalled child's code and `KeepAlive{SuccessfulExit:false}` respawned it.
    // That respawn is exactly what made `host stop` come back, so removing it
    // was the point - and it left this path with nothing underneath.
    //
    // This whole branch of `stopForRestart` had no test; all four lived on the
    // Desktop-managed path.
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(false);
    const runner: ProcessRunner = async () => buildSuccessResult();
    const controller = createMacosController(runner);

    await expect(
      controller.stopForRestart(label, { force: false }),
    ).resolves.toEqual({
      forcedRecycle: true,
    });
  });

  it("recycles rather than plain-kickstarts when relaunching a CLI-owned restart", async () => {
    // The other half: `forcedRecycle` only matters if the relaunch honours it.
    // Assert the exact invocation, not "some argument list contains -k": the
    // latter passes for any call carrying that flag anywhere, which is not
    // evidence that `launchctl kickstart -k` was the thing issued.
    const calls: { command: string; args: readonly string[] }[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);

    await expect(
      controller.relaunchAfterRestart(label, { forcedRecycle: true }),
    ).resolves.toBeUndefined();

    expect(
      calls.some(
        (c) =>
          c.command === "launchctl" &&
          c.args[0] === "kickstart" &&
          c.args[1] === "-k",
      ),
    ).toBe(true);
  });

  it("detects SMAppService in-bundle LaunchAgent paths", () => {
    expect(
      isSmAppServiceLaunchAgentPath(
        "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist",
      ),
    ).toBe(true);
    expect(
      isSmAppServiceLaunchAgentPath(
        "/Users/me/Applications/Traycer Staging.app/Contents/Library/LaunchAgents/ai.traycer.host.staging.plist",
      ),
    ).toBe(true);
    expect(
      isSmAppServiceLaunchAgentPath(
        "/Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      ),
    ).toBe(false);
    expect(
      classifyLaunchdPrintOutput(
        `gui/501/ai.traycer.host = {\n\tpath = /Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist\n\tstate = running\n}\n`,
      ),
    ).toEqual({
      kind: "smappservice",
      path: "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist",
    });
  });

  // Verbatim `launchctl print` output captured from a macOS build that
  // reports SMAppService jobs WITHOUT an in-bundle plist path. Keying
  // ownership on the bundle path alone classified this as `cli-or-other`,
  // which silently disarmed every SMAppService guard at once and let
  // `host install` bootstrap a second host beside Desktop's agent.
  it("classifies an SMAppService job that reports no bundle path", () => {
    const printOutput = [
      "gui/501/ai.traycer.host.staging.agent = {",
      "\tactive count = 1",
      "\tpath = (submitted by smd.321)",
      "\ttype = Submitted",
      "\tmanaged_by = com.apple.xpc.ServiceManagement",
      "\tstate = running",
      "",
      "\tprogram identifier = Contents/Library/LaunchAgents/Traycer Staging Host.app/Contents/MacOS/traycer (mode: 2)",
      "\tparent bundle identifier = ai.traycer.desktop.staging",
      "\targuments = {",
      "\t\tContents/Library/LaunchAgents/Traycer Staging Host.app/Contents/MacOS/traycer",
      "\t\thost",
      "\t\tstart",
      "\t}",
      "",
      "\tenvironment = {",
      "\t\tOSLogRateLimit => 64",
      "\t\tXPC_SERVICE_NAME => ai.traycer.host.staging.agent",
      "\t}",
      "}",
      "",
    ].join("\n");

    expect(classifyLaunchdPrintOutput(printOutput)).toEqual({
      kind: "smappservice",
      path: "(submitted by smd.321)",
    });
  });

  it("classifies a raw CLI-bootstrapped LaunchAgent as cli-or-other", () => {
    const printOutput = [
      "gui/501/ai.traycer.host = {",
      "\tactive count = 1",
      "\tpath = /Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      "\ttype = LaunchAgent",
      "\tstate = running",
      "",
      "\tprogram = /Users/me/.traycer/cli/bin/traycer",
      "\targuments = {",
      "\t\t/Users/me/.traycer/cli/bin/traycer",
      "\t\thost",
      "\t\tstart",
      "\t}",
      "}",
      "",
    ].join("\n");

    expect(classifyLaunchdPrintOutput(printOutput)).toEqual({
      kind: "cli-or-other",
      path: "/Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      pid: null,
    });
  });

  it("classifies a raw CLI-bootstrapped LaunchAgent with a live pid as cli-or-other with that pid", () => {
    const printOutput = [
      "gui/501/ai.traycer.host = {",
      "\tactive count = 1",
      "\tpath = /Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      "\ttype = LaunchAgent",
      "\tstate = running",
      "\tpid = 4242",
      "",
      "\tprogram = /Users/me/.traycer/cli/bin/traycer",
      "\targuments = {",
      "\t\t/Users/me/.traycer/cli/bin/traycer",
      "\t\thost",
      "\t\tstart",
      "\t}",
      "}",
      "",
    ].join("\n");

    expect(classifyLaunchdPrintOutput(printOutput)).toEqual({
      kind: "cli-or-other",
      path: "/Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      pid: 4242,
    });
  });

  it("treats a zero or non-numeric pid field as no live process", () => {
    const printOutputZero = [
      "gui/501/ai.traycer.host = {",
      "\tpath = /Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      "\ttype = LaunchAgent",
      "\tpid = 0",
      "\tprogram = /Users/me/.traycer/cli/bin/traycer",
      "}",
      "",
    ].join("\n");

    expect(classifyLaunchdPrintOutput(printOutputZero)).toEqual({
      kind: "cli-or-other",
      path: "/Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      pid: null,
    });

    const printOutputNonNumeric = [
      "gui/501/ai.traycer.host = {",
      "\tpath = /Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      "\ttype = LaunchAgent",
      "\tpid = (null)",
      "\tprogram = /Users/me/.traycer/cli/bin/traycer",
      "}",
      "",
    ].join("\n");

    expect(classifyLaunchdPrintOutput(printOutputNonNumeric)).toEqual({
      kind: "cli-or-other",
      path: "/Users/me/Library/LaunchAgents/ai.traycer.host.plist",
      pid: null,
    });
  });

  it("treats managed_by and type as independent SMAppService signals", () => {
    expect(
      classifyLaunchdPrintOutput(
        "gui/501/x = {\n\tmanaged_by = com.apple.xpc.ServiceManagement\n}\n",
      ),
    ).toEqual({
      kind: "smappservice",
      path: "(SMAppService-managed; no plist path)",
    });
    expect(
      classifyLaunchdPrintOutput("gui/501/x = {\n\ttype = Submitted\n}\n"),
    ).toEqual({
      kind: "smappservice",
      path: "(SMAppService-managed; no plist path)",
    });
  });

  it("reports externally-managed when launchd loads the label from an SMAppService path even if a stale raw plist exists", async () => {
    // Collision case: leftover CLI LaunchAgents file + Desktop SMAppService
    // already owns the same label. Status must not claim CLI-"registered"
    // (host update would take the existing-registration reload path against
    // Desktop's BTM registration) but must also not claim "not-installed"
    // (auto-bootstrap would select "service repair" and run into
    // installService's SMAppService refusal on every `traycer login`).
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await writeFile(createdPlistPath, "stale cli plist", "utf8");
    const smPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist";
    const runner: ProcessRunner = async (command, args, options) => {
      if (args[0] === "print") {
        if (options.tolerateNonZeroExit) {
          return {
            stdout: `gui/501/${label.id} = {\n\tpath = ${smPath}\n}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);

    await expect(controller.status(label)).resolves.toEqual({
      state: "externally-managed",
      version: null,
      listenUrl: null,
      pid: null,
    });
    // Must not consult pid metadata for an SMAppService-owned label.
    expect(MOCKS.readHostPidMetadata).not.toHaveBeenCalled();
  });

  it("uninstall still boots out an SMAppService-owned label but warns about the surviving login-item record", async () => {
    // Asymmetry with install's refusal is deliberate: removal intent wins
    // (a user whose .app is already gone must not be stranded with an
    // un-removable agent), but on macOS <= 25 the SMAppService record can
    // survive the bootout and respawn the host at next login - that residue
    // must not be silent.
    const calls: RecordedCall[] = [];
    const smPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist";
    const runner: ProcessRunner = async (command, args, options) => {
      calls.push({ command, args });
      if (args[0] === "print" && options.tolerateNonZeroExit) {
        return { stdout: `path = ${smPath}\n`, stderr: "", exitCode: 0 };
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);

    await expect(controller.uninstall({ label })).resolves.toBeUndefined();
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootout",
    ]);
    // One warning per SMAppService-owned label: this stub reports both the
    // CLI label and the agent label as SMAppService-loaded.
    expect(MOCKS.cliLoggerWarn).toHaveBeenCalledTimes(2);
    expect(MOCKS.cliLoggerWarn.mock.calls[0]?.[0]).toContain("Login Items");
  });

  it("attempts the CLI-label bootout even when the agent-label bootout fails hard, and preserves the manifest since teardown is unconfirmed", async () => {
    // Agent label is iterated first (it's the live job on migrated
    // machines); a hard failure there must not skip the CLI-label bootout -
    // "best-effort per target", not "stop at the first failure". The
    // manifest survives because teardown never fully confirmed - deleting
    // it here would make a still-loaded CLI job misreport as not-installed.
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await writeFile(createdPlistPath, "test manifest", "utf8");
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootout" && args.some((a) => a.endsWith(".agent"))) {
        throw buildLaunchctlError({
          command,
          cmdArgs: args,
          stderr: "Boot-out failed: 1: Operation not permitted\n",
          stdout: "",
          exitCode: 1,
        });
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);

    await expect(controller.uninstall({ label })).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining(`${label.id}.agent`),
    });
    expect(calls.map((c) => c.args[0])).toEqual([
      "print",
      "print",
      "bootout",
      "bootout",
    ]);
    // Pin the actual targets, not just the command names: a buggy
    // implementation that bootouts the agent target twice (and never
    // touches the CLI label) would also produce two "bootout" calls and a
    // ".agent"-containing error message, passing the assertions above.
    const bootoutTargets = calls
      .filter((call) => call.args[0] === "bootout")
      .map((call) => call.args[call.args.length - 1]);
    expect(bootoutTargets[0]?.endsWith(`/${label.id}.agent`)).toBe(true);
    expect(bootoutTargets[1]?.endsWith(`/${label.id}`)).toBe(true);
    await expect(readFile(createdPlistPath, "utf8")).resolves.toBe(
      "test manifest",
    );
  });

  it("refuses install when the label is already loaded from an SMAppService path", async () => {
    const calls: RecordedCall[] = [];
    const smPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist";
    const runner: ProcessRunner = async (command, args, options) => {
      calls.push({ command, args });
      if (args[0] === "print") {
        if (options.tolerateNonZeroExit) {
          return {
            stdout: `path = ${smPath}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);

    const rejection: unknown = await controller
      .install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining("SMAppService"),
    });
    // The advice must work from this exact state: `service uninstall`
    // deliberately never refuses. `host ensure --no-service-register` is a
    // bytes-only no-op on an installed, satisfied machine and must never
    // reappear as the suggested fix.
    expect(rejection).toMatchObject({
      message: expect.stringContaining("traycer host service uninstall"),
    });
    expect(rejection).not.toMatchObject({
      message: expect.stringContaining("no-service-register"),
    });
    // Must not bootout/bootstrap or rewrite the label under SMAppService.
    expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    await expect(readFile(createdPlistPath, "utf8")).rejects.toThrow();
  });

  it("refuses install when Desktop's post-label-split AGENT label is SMAppService-loaded - the CLI label itself reads clean", async () => {
    // Post-split Desktop machines run the host under `<label>.agent` and
    // leave the CLI label unloaded with no raw manifest. A manual
    // `service install` here would bootstrap a SECOND host beside
    // Desktop's - the agent-label probe must refuse it.
    const calls: RecordedCall[] = [];
    const smAgentPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.agent.plist";
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "print") {
        if (args[1]?.endsWith(".agent") === true) {
          return { stdout: `path = ${smAgentPath}\n`, stderr: "", exitCode: 0 };
        }
        return {
          stdout: "",
          stderr: "Could not find specified service\n",
          exitCode: 113,
        };
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);

    const rejection: unknown = await controller
      .install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining(`${label.id}.agent`),
    });
    // The refusal must route to the working consent path (`--takeover`),
    // never the `--no-service-register` no-op.
    expect(rejection).toMatchObject({
      message: expect.stringContaining("--takeover"),
    });
    // Also steers toward the cheaper fix when the caller just wants the
    // Desktop-managed host running again - no ownership change needed.
    expect(rejection).toMatchObject({
      message: expect.stringContaining("traycer host restart"),
    });
    expect(rejection).not.toMatchObject({
      message: expect.stringContaining("no-service-register"),
    });
    // Both probes ran; nothing was booted out, bootstrapped, or written.
    expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
    await expect(readFile(createdPlistPath, "utf8")).rejects.toThrow();
  });

  it("reports externally-managed when only the post-label-split AGENT label is SMAppService-loaded", async () => {
    // Migrated machine: CLI label unloaded, raw manifest deleted by the
    // desktop's register cycle, host running under `<label>.agent`.
    // `not-installed` here would send doctor/auto-bootstrap into
    // installService's agent-label refusal on every `traycer login`.
    const smAgentPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.agent.plist";
    const runner: ProcessRunner = async (command, args, options) => {
      if (args[0] === "print" && options.tolerateNonZeroExit) {
        if (args[1]?.endsWith(".agent") === true) {
          return { stdout: `path = ${smAgentPath}\n`, stderr: "", exitCode: 0 };
        }
        return {
          stdout: "",
          stderr: "Could not find specified service\n",
          exitCode: 113,
        };
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);

    await expect(controller.status(label)).resolves.toEqual({
      state: "externally-managed",
      version: null,
      listenUrl: null,
      pid: null,
    });
    expect(MOCKS.readHostPidMetadata).not.toHaveBeenCalled();
  });

  describe("Desktop-managed stop/start/restart (cooperative, never a refusal)", () => {
    // On a migrated machine the host runs under `<label>.agent` and the CLI
    // label has no job. These operations used to refuse outright ("use the
    // Traycer app") - which cornered exactly the users whose Desktop app
    // was the broken part. Now: stop/restart ask the RUNNING HOST to stand
    // down over its lifecycle-claim RPCs, start/restart relaunch via
    // kickstart of the AGENT label, and no arm ever bootouts/bootstraps
    // the registration Desktop owns.
    const smAgentPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.agent.plist";
    const agentTarget = `gui/${process.getuid?.() ?? 0}/${label.id}.agent`;

    function stageDesktopManagedRunner(): {
      calls: RecordedCall[];
      controller: ServiceController;
    } {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print" && args[1]?.endsWith(".agent") === true) {
          return { stdout: `path = ${smAgentPath}\n`, stderr: "", exitCode: 0 };
        }
        return buildSuccessResult();
      };
      return { calls, controller: createMacosController(runner) };
    }

    it("stop asks the host to stand down and touches no launchd job", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.stop(label, { force: false }),
      ).resolves.toBeUndefined();
      // The third argument is the RESTART INTENT the host acts on: a plain
      // stop must say `"shutdown"`, or the host would publish a restart
      // tombstone and every attached window would sit in
      // `restarting-expected` for the full episode waiting for a host that is
      // not coming back.
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledWith(
        label.environment,
        "stop",
        "shutdown",
      );
      // Only the advisory ownership probe ran - no kill, no bootout.
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("stop surfaces a busy denial instead of escalating over live work, and names --force as the escape hatch", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "busy" });

      await expect(
        controller.stop(label, { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: expect.stringContaining("work in progress"),
      });
      // The denial is a dead end without knowing the escape hatch exists -
      // the message names it rather than leaving the user to find `--force`
      // in `--help`.
      await expect(
        controller.stop(label, { force: false }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("--force"),
      });
      expect(MOCKS.forceStopHostProcess).not.toHaveBeenCalled();
      expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
    });

    it("stop with --force kills the host pid directly and never dials the cooperative-shutdown RPC", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.stop(label, { force: true }),
      ).resolves.toBeUndefined();

      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith(
        label.environment,
        "stop",
      );
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      // Only the advisory ownership probe ran - force mutates no launchd
      // registration and issues no lifecycle RPC.
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("stop with --force resolves even when the pid was already gone", async () => {
      const { controller } = stageDesktopManagedRunner();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "no-host" });

      await expect(
        controller.stop(label, { force: true }),
      ).resolves.toBeUndefined();
    });

    it("stop with --force surfaces a control-failed error when the pid survives SIGKILL", async () => {
      const { controller } = stageDesktopManagedRunner();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "hung", pid: 4242 });

      await expect(
        controller.stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("survived SIGKILL"),
      });
    });

    it("stop with --force surfaces a control-failed error when the pid's identity could not be verified", async () => {
      // `forceStopHostProcess` itself refuses to signal a pid it cannot
      // prove is still the host (a recycled-pid impostor risk) - this pins
      // that the macOS routing surfaces that refusal as an honest error
      // rather than silently reporting success or crashing on an unhandled
      // outcome variant.
      const { controller } = stageDesktopManagedRunner();
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "identity-unverified",
        pid: 4242,
      });

      await expect(
        controller.stop(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("could not verify"),
      });
    });

    it("stop names the takeover escape hatch when the host RPC is unreachable", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "dial timeout",
      });

      const rejection: unknown = await controller
        .stop(label, { force: false })
        .then(() => null)
        .catch((error: unknown) => error);
      expect(rejection).toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining(`${label.id}.agent`),
      });
      // The routing must include a path the user can take when the Desktop
      // app itself is the thing that is broken - and never the
      // `--no-service-register` no-op.
      expect(rejection).toMatchObject({
        message: expect.stringContaining("traycer host service uninstall"),
      });
      expect(rejection).toMatchObject({
        message: expect.stringContaining("dial timeout"),
      });
      expect(rejection).not.toMatchObject({
        message: expect.stringContaining("no-service-register"),
      });
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("start kickstarts the AGENT label - the job launchd can actually start", async () => {
      const { calls, controller } = stageDesktopManagedRunner();

      await expect(controller.start(label)).resolves.toBeUndefined();
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.map((c) => c.args[0])).toEqual(["print", "kickstart"]);
      expect(calls[1]?.args).toEqual(["kickstart", agentTarget]);
    });

    it("restart cooperatively stops, then plain-kickstarts the agent label", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(controller.restart(label)).resolves.toBeUndefined();
      // ...and the restart half says `"restart"`, which is the whole point:
      // it is what lets the host tell every client the outage is deliberate.
      // The two call sites must DIFFER - an intent hardcoded the same in both
      // places would pass a presence-only assertion.
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledWith(
        label.environment,
        "restart",
        "restart",
      );
      expect(calls.map((c) => c.args[0])).toEqual(["print", "kickstart"]);
      // Plain kickstart - the host already exited; `-k` would be a
      // gratuitous kill of nothing.
      expect(calls[1]?.args).toEqual(["kickstart", agentTarget]);
    });

    it("restart of an unreachable host recycles the job with kickstart -k", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "dial timeout",
      });

      await expect(controller.restart(label)).resolves.toBeUndefined();
      // The host cannot be asked nicely (RPC dead); an explicit restart
      // recycles at the launchd level - still no registration mutation.
      expect(calls.map((c) => c.args[0])).toEqual(["print", "kickstart"]);
      expect(calls[1]?.args).toEqual(["kickstart", "-k", agentTarget]);
    });

    it("restart surfaces a busy denial without killing the job", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "busy" });

      await expect(controller.restart(label)).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: expect.stringContaining("work in progress"),
      });
      // No kickstart of any kind was issued over live work.
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    /*
     * The restart HALVES, which is what `traycer host restart` actually calls.
     *
     * `restart()` above has always recycled an unreachable host, but the
     * command could never reach it: it was spelled `stop()` then `start()`,
     * and `stop()` throws on exactly the unreachable/hung outcomes the
     * recycle exists for. So the command died on the broken-host state it
     * was added to repair while these platform tests stayed green against a
     * primitive production never called. These rows pin the halves instead.
     */
    it("stopForRestart does NOT throw where stop does - an unreachable host reports forcedRecycle so the command reaches its relaunch", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "dial timeout",
      });

      await expect(
        controller.stopForRestart(label, { force: false }),
      ).resolves.toEqual({
        forcedRecycle: true,
      });
      // Contrast, on the identical staged outcome: `stop` is terminal here.
      // If this ever stops throwing, the two are the same operation and the
      // finding this row exists for has been re-introduced by convergence.
      await expect(
        controller.stop(label, { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      });
      // Neither half mutates launchd - only the advisory ownership probe.
      expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
    });

    /*
     * Unreadable pid metadata is not proof the host is gone, and each half
     * takes the safe direction for its own operation.
     */
    it("stop refuses rather than reporting success when no endpoint is published", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "no-metadata",
      });

      await expect(
        controller.stop(label, { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("cannot be asked to stand down"),
      });
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("stopForRestart forces a recycle when no endpoint is published - a plain kickstart of a job launchd still thinks is running is a no-op", async () => {
      const { controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "no-metadata",
      });

      await expect(
        controller.stopForRestart(label, { force: false }),
      ).resolves.toEqual({
        forcedRecycle: true,
      });
    });

    it("stopForRestart forces a recycle when the published pid is gone - the child exited or lost its pid, but launchd's job may still be up", async () => {
      // `publishedHostProcessGone` made this outcome reachable for a LIVE pid
      // that now belongs to an unrelated process; before that a recycled pid
      // dialled the dead endpoint and arrived here as `unreachable`, which
      // already recycled. Either way `no-host` is a fact about the CHILD, and
      // a plain kickstart of a job launchd still considers running is a
      // no-op - the restart would report success having done nothing.
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "no-host" });

      await expect(
        controller.stopForRestart(label, { force: false }),
      ).resolves.toEqual({
        forcedRecycle: true,
      });
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("restart of a host whose published pid is gone recycles the job with kickstart -k", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "no-host" });

      await expect(controller.restart(label)).resolves.toBeUndefined();
      expect(calls.map((c) => c.args[0])).toEqual(["print", "kickstart"]);
      expect(calls[1]?.args).toEqual(["kickstart", "-k", agentTarget]);
    });

    it("stopForRestart reports no forced recycle when the host really stood down", async () => {
      const { controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.stopForRestart(label, { force: false }),
      ).resolves.toEqual({
        forcedRecycle: false,
      });
    });

    it("stopForRestart still refuses over live work", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "busy" });

      await expect(
        controller.stopForRestart(label, { force: false }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_BUSY,
      });
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("stopForRestart with --force kills the pid directly, never dials the cooperative RPC, and always reports forcedRecycle", async () => {
      const { calls, controller } = stageDesktopManagedRunner();
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.stopForRestart(label, { force: true }),
      ).resolves.toEqual({ forcedRecycle: true });

      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith(
        label.environment,
        "restart",
      );
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      // Every force outcome recycles the job on relaunch - the kill (or the
      // attempt) already happened, so a plain kickstart could still no-op
      // against a supervisor mid-teardown.
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });
    it("relaunchAfterRestart recycles the agent job when the stop half could not ask the host to exit", async () => {
      const { calls, controller } = stageDesktopManagedRunner();

      await expect(
        controller.relaunchAfterRestart(label, { forcedRecycle: true }),
      ).resolves.toBeUndefined();
      // `-k` is load-bearing: the old process was never asked to leave, and
      // launchd treats a plain kickstart of a running job as satisfied - the
      // host would keep serving the old bytes after a "successful" restart.
      expect(calls[1]?.args).toEqual(["kickstart", "-k", agentTarget]);
    });

    it("relaunchAfterRestart plain-kickstarts when the host already exited", async () => {
      const { calls, controller } = stageDesktopManagedRunner();

      await expect(
        controller.relaunchAfterRestart(label, { forcedRecycle: false }),
      ).resolves.toBeUndefined();
      expect(calls[1]?.args).toEqual(["kickstart", agentTarget]);
    });
  });

  describe("takeoverDesktopRegistration", () => {
    // `service install --takeover`: the explicit-consent path out of the
    // agent refusal. Contract under test: cooperative stop first (busy
    // aborts BEFORE launchd is touched), bootout verified by re-probe
    // (a silently failed bootout must fail the takeover, not surface as a
    // confusing second refusal from `install`), and the pre-split arm
    // stays refused (that label is Desktop's own registration).
    const smAgentPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.agent.plist";
    const agentTarget = `gui/${process.getuid?.() ?? 0}/${label.id}.agent`;

    // `cliLabelLoadedAsCliOrOther`, when set, stages the CLI label as a
    // raw `~/Library/LaunchAgents/<label>.plist` load (`cli-or-other`, NOT
    // an in-bundle SMAppService path, and with NO pid - the idle-job case)
    // rather than the plain owned/not-loaded pair `cliLabelOwned` controls.
    // Three non-`.agent` prints matter here: the FIRST (the initial
    // `cliProbe`) and the SECOND (the fresh re-probe `takeoverDesktopRegistration`
    // runs after the agent is retired) both answer loaded; the THIRD (the
    // post-bootout re-probe `unloadCliLabelJob` runs) answers per
    // `afterBootout` - "absent" is launchd's not-found output, "still-loaded"
    // repeats the loaded answer.
    // `agentRunning` puts a `\tpid = 777\n` line on the FIRST agent print -
    // the only one `agentProbe` is read from - so `agentProbe.running` is
    // true and the took-over arm actually makes a cooperative claim. Idle
    // (false) is the default shape most fixtures used before the claim was
    // conditioned on it: `path = ...` alone, no pid or state line.
    function stageTakeoverRunner(input: {
      cliLabelOwned: boolean;
      agentLoadedAfterBootout: boolean;
      agentRunning: boolean;
      cliLabelLoadedAsCliOrOther?: {
        afterBootout: "absent" | "still-loaded";
      };
    }): {
      calls: RecordedCall[];
      controller: ServiceController;
    } {
      const calls: RecordedCall[] = [];
      let agentPrints = 0;
      let cliLabelPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            const loaded =
              agentPrints === 1 ? true : input.agentLoadedAfterBootout;
            const pidLine =
              agentPrints === 1 && input.agentRunning ? "\tpid = 777\n" : "";
            return loaded
              ? {
                  stdout: `path = ${smAgentPath}\n${pidLine}`,
                  stderr: "",
                  exitCode: 0,
                }
              : {
                  stdout: "",
                  stderr: "Could not find specified service\n",
                  exitCode: 113,
                };
          }
          cliLabelPrints += 1;
          if (input.cliLabelLoadedAsCliOrOther !== undefined) {
            const cliOrOther = input.cliLabelLoadedAsCliOrOther;
            const loadedResult = {
              stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n`,
              stderr: "",
              exitCode: 0,
            };
            const notFoundResult = {
              stdout: "",
              stderr: "Could not find specified service\n",
              exitCode: 113,
            };
            if (cliLabelPrints <= 2) return loadedResult;
            return cliOrOther.afterBootout === "still-loaded"
              ? loadedResult
              : notFoundResult;
          }
          return input.cliLabelOwned
            ? {
                stdout: `path = /Applications/Traycer.app/Contents/Library/LaunchAgents/${label.id}.plist\n`,
                stderr: "",
                exitCode: 0,
              }
            : {
                stdout: "",
                stderr: "Could not find specified service\n",
                exitCode: 113,
              };
        }
        return buildSuccessResult();
      };
      return { calls, controller: createMacosController(runner) };
    }

    it("cooperatively stops, boots out the agent, and verifies the bootout took effect", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "stopped",
      });
      // Takeover retires Desktop's registration rather than relaunching it,
      // so nothing is coming back under this identity.
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledWith(
        label.environment,
        "takeover",
        "shutdown",
      );
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "print",
        "print",
      ]);
      expect(calls[2]?.args).toEqual(["bootout", "--wait", agentTarget]);
      // The takeover is an ownership change; the audit line is the only
      // record of it a support thread can recover.
      expect(MOCKS.cliLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("booted out Traycer Desktop's SMAppService"),
        expect.objectContaining({ agentLabel: `${label.id}.agent` }),
      );
    });

    it("aborts on a busy denial before touching launchd", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: true,
        agentRunning: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "busy" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: expect.stringContaining("work in progress"),
      });
      expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
    });

    it("proceeds underneath an unreachable host, logging the degradation", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "dial timeout",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "skipped-unreachable",
      });
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "print",
        "print",
      ]);
      expect(MOCKS.cliLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("could not be stopped cooperatively"),
        expect.objectContaining({ cause: "dial timeout" }),
      );
    });

    /*
     * Verification must be POSITIVE, in both indeterminate shapes.
     *
     * The takeover proceeds on "the agent is gone". Every non-zero
     * `launchctl print` used to collapse to not-loaded, and a thrown probe
     * was caught into not-loaded as well - so an EPERM, a timeout, or a
     * launchctl that could not spawn all read as proof the bootout worked.
     * Registering the CLI LaunchAgent on that evidence leaves BOTH
     * registrations live: two hosts, one data dir - the dual-host state this
     * command exists to resolve.
     */
    it("aborts the takeover when the post-bootout probe fails rather than treating it as proof of absence", async () => {
      const calls: RecordedCall[] = [];
      let agentPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          const target = args[1] ?? "";
          if (target.endsWith(`/${label.id}.agent`)) {
            agentPrints += 1;
            // First probe establishes Desktop ownership; the verification
            // probe afterwards cannot answer.
            if (agentPrints === 1) {
              return {
                stdout: `path = ${smAgentPath}\n`,
                stderr: "",
                exitCode: 0,
              };
            }
            throw new Error("launchctl could not be spawned");
          }
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        return buildSuccessResult();
      };
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("could not confirm"),
      });
    });
    it("refuses on a pre-split machine where the CLI label is Desktop's own registration", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: true,
        agentLoadedAfterBootout: true,
        // Irrelevant here: the pre-split refusal fires on the CLI label's
        // own probe, before the agent's `running` flag is ever read.
        agentRunning: false,
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("traycer host service uninstall"),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      // The agent is probed FIRST (it reads loaded/smappservice here too,
      // via `smAgentPath`) and only THEN the CLI label, whose smappservice
      // read is what trips the refusal.
      expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
    });

    // A job loaded under the AGENT label that Desktop itself never
    // registered - a raw `~/Library/LaunchAgents/<label>.agent.plist`,
    // `cli-or-other` ownership rather than an in-bundle SMAppService path.
    // This command only manages Desktop's own registration, so it refuses
    // rather than bootstrap the CLI label beside a job nobody asked to
    // stand down. Idle here (no pid, no `running` claim to make) - the
    // refusal fires on ownership alone, before any liveness is read.
    it("rejects with SERVICE_INSTALL_FAILED ('is not Traycer Desktop's registration') when the agent label is loaded idle but not by Desktop", async () => {
      const loadedPath = `/Users/me/Library/LaunchAgents/${label.id}.agent.plist`;
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            return {
              stdout: `\tpath = ${loadedPath}\n\ttype = LaunchAgent\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        return buildSuccessResult();
      };

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "is not Traycer Desktop's registration",
        ),
        details: expect.objectContaining({
          agentLabel: `${label.id}.agent`,
          loadedPath,
        }),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("reports not-applicable when Desktop owns nothing", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: true,
        // Irrelevant: this runner and controller are discarded below in
        // favour of `notLoadedRunner`.
        agentRunning: false,
      });
      // Agent print must read not-loaded on the FIRST probe for this case.
      calls.length = 0;
      const notLoadedRunner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: "",
          stderr: "Could not find specified service\n",
          exitCode: 113,
        };
      };
      const cleanController = createMacosController(notLoadedRunner);

      await expect(
        cleanController.takeoverDesktopRegistration(label),
      ).resolves.toEqual({ kind: "not-applicable" });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
      void controller;
    });

    // Rule 3, no-agent arm: `refuseIfPublishedHostAlive` runs even when
    // Desktop owns nothing and the CLI label itself is absent - a hand-run
    // host can still be the one `pid.json` names, and nothing under either
    // label ever asked it to stand down.
    it("rejects with SERVICE_INSTALL_FAILED ('a host is still running') when Desktop owns nothing but a published endpoint's identity verdict is 'current'", async () => {
      const calls: RecordedCall[] = [];
      const notLoadedRunner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: "",
          stderr: "Could not find specified service\n",
          exitCode: 113,
        };
      };
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: null,
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("current");

      await expect(
        createMacosController(notLoadedRunner).takeoverDesktopRegistration(
          label,
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "a host is still running (pid 9001, per its published endpoint)",
        ),
        details: expect.objectContaining({ pid: 9001, verdict: "current" }),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("resolves not-applicable when Desktop owns nothing and a published endpoint's identity verdict is 'mismatch'", async () => {
      const notLoadedRunner: ProcessRunner = async () => ({
        stdout: "",
        stderr: "Could not find specified service\n",
        exitCode: 113,
      });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: null,
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("mismatch");

      await expect(
        createMacosController(notLoadedRunner).takeoverDesktopRegistration(
          label,
        ),
      ).resolves.toEqual({ kind: "not-applicable" });
    });

    // An "indeterminate" verdict on a record that predates identity
    // tracking (`processStartIdentity === null`) cannot be told apart from
    // a host still running by the verdict alone, so `refuseIfPublishedHostAlive`
    // dials the endpoint once via `probeHostHealth`. Nothing answering means
    // the record is stale (most likely a host that crashed without
    // cleaning up `pid.json`), and the reload proceeds under a warning.
    it("resolves not-applicable and warns 'treating the record as stale' when an indeterminate, identity-less record's endpoint answers unhealthy", async () => {
      const notLoadedRunner: ProcessRunner = async () => ({
        stdout: "",
        stderr: "Could not find specified service\n",
        exitCode: 113,
      });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: null,
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue(
        "indeterminate",
      );
      MOCKS.probeHostHealth.mockResolvedValue({
        healthy: false,
        detail: "no host loopback port reachable",
      });

      await expect(
        createMacosController(notLoadedRunner).takeoverDesktopRegistration(
          label,
        ),
      ).resolves.toEqual({ kind: "not-applicable" });
      expect(MOCKS.probeHostHealth).toHaveBeenCalledTimes(1);
      expect(MOCKS.cliLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("treating the record as stale"),
        expect.objectContaining({ pid: 9001 }),
      );
    });

    // The opposite dial result: something DOES answer on the endpoint the
    // record advertises, so it is a host, whatever its identity record
    // says - refused with wording distinct from the "current" branch, since
    // there is no process-identity match here, only a live TCP answer.
    it("rejects with SERVICE_INSTALL_FAILED ('a host answered on the endpoint') when an indeterminate, identity-less record's endpoint answers healthy", async () => {
      const notLoadedRunner: ProcessRunner = async () => ({
        stdout: "",
        stderr: "Could not find specified service\n",
        exitCode: 113,
      });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: null,
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue(
        "indeterminate",
      );
      MOCKS.probeHostHealth.mockResolvedValue({
        healthy: true,
        detail: "process alive and loopback port reachable",
      });

      await expect(
        createMacosController(notLoadedRunner).takeoverDesktopRegistration(
          label,
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "a host answered on the endpoint the published host record",
        ),
        details: expect.objectContaining({
          pid: 9001,
          verdict: "indeterminate",
        }),
      });
    });

    // With a NON-null `processStartIdentity`, an "indeterminate" verdict is
    // a probe fault (the recorded stamp could not be compared), not a
    // record that predates identity tracking - so it refuses like
    // "current", with its OWN wording, and never dials `probeHostHealth`.
    it("rejects with SERVICE_INSTALL_FAILED ('its process identity could not be read') and never dials the endpoint when the record HAS a process identity", async () => {
      const notLoadedRunner: ProcessRunner = async () => ({
        stdout: "",
        stderr: "Could not find specified service\n",
        exitCode: 113,
      });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: "darwin:1699999999.123456",
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue(
        "indeterminate",
      );

      await expect(
        createMacosController(notLoadedRunner).takeoverDesktopRegistration(
          label,
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "its process identity could not be read",
        ),
        details: expect.objectContaining({
          pid: 9001,
          verdict: "indeterminate",
        }),
      });
      expect(MOCKS.probeHostHealth).not.toHaveBeenCalled();
    });

    // A torn or momentarily unreadable pid.json must fail CLOSED, not be
    // folded into "no host" the way `readHostPidMetadata` folds it for
    // discovery callers - the record's absence and its unreadability read
    // identically through that API, and letting the gate pass on "no
    // evidence" is exactly the hostless-bootstrap-beside-a-corpse this
    // command exists to prevent.
    it("rejects with SERVICE_INSTALL_FAILED ('could not be read') when the published record is unreadable (no-agent arm)", async () => {
      const calls: RecordedCall[] = [];
      const notLoadedRunner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: "",
          stderr: "Could not find specified service\n",
          exitCode: 113,
        };
      };
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "unreadable",
        cause: "not valid JSON",
      });

      await expect(
        createMacosController(notLoadedRunner).takeoverDesktopRegistration(
          label,
        ),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("could not be read (not valid JSON)"),
        details: expect.objectContaining({ cause: "not valid JSON" }),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("fails closed when the bootout does not take effect", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: true,
        agentRunning: true,
      });
      // `no-metadata`/`no-host` with a running agent now refuse OUTRIGHT
      // (before any bootout), so this "did not take effect" pin needs an
      // outcome that still proceeds to the bootout - `hung` does.
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "hung",
        pid: 777,
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("did not take effect"),
      });
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "print",
      ]);
    });

    /**
     * The barrier, pinned in the states that need it.
     *
     * `--wait` is the difference between "launchd accepted the request" and
     * "the process is gone". Takeover reaches the bootout with the old host
     * still running in exactly these three outcomes - only `stopped` waited
     * for exit - and the evicted host publishes `pid.json` until the very end
     * of teardown. `service install` then starts the CLI-label host, whose
     * first act is `findLiveIncumbentHost`: a bare bootout lets it read the
     * corpse as a live incumbent, decline, and exit 0, and
     * `KeepAlive{SuccessfulExit: false}` leaves it DOWN until the next login.
     *
     * Asserted per outcome rather than once, because the bug is not "the flag
     * is missing" but "the flag is missing on the path where the host is
     * still alive" - a single row over `stopped` would pass while every
     * dangerous arm regressed.
     */
    // `no-metadata`/`no-host` dropped from this table: with a running
    // agent those two now refuse OUTRIGHT (pinned separately below) instead
    // of proceeding to the bootout, so a row here would have asserted the
    // pre-change behaviour.
    it.each([
      ["unreachable", { kind: "unreachable", cause: "dial failed" }],
      ["hung", { kind: "hung", pid: 4242 }],
    ] as const)(
      "waits for the evicted host to exit before install can race it (%s)",
      async (_name, outcome) => {
        const { calls, controller } = stageTakeoverRunner({
          cliLabelOwned: false,
          agentLoadedAfterBootout: false,
          agentRunning: true,
        });
        MOCKS.requestCooperativeShutdown.mockResolvedValue(outcome);

        await expect(
          controller.takeoverDesktopRegistration(label),
        ).resolves.toMatchObject({ kind: "took-over" });

        const bootout = calls.find((c) => c.args[0] === "bootout");
        expect(bootout?.args).toEqual(["bootout", "--wait", agentTarget]);
      },
    );

    // A running agent process that nobody could ask - `unaskableHost`, the
    // same refusal the CLI-label stand-down uses. `agentProbe.running` gates
    // it: the claim went through `pid.json`, and a fresh host in its first
    // seconds (no-metadata) or between children (no-host) gets no bootout
    // at all here, unlike `unreachable`/`hung` above.
    it.each([
      [
        "no-metadata",
        { kind: "no-metadata" } as const,
        "has not published a live endpoint yet",
      ],
      [
        "no-host",
        { kind: "no-host" } as const,
        "names a host that is gone - exited, or a pid that now belongs to an unrelated process",
      ],
    ] as const)(
      "rejects with SERVICE_INSTALL_FAILED ('%s') and never boots out when a running Desktop-managed agent's claim can find no endpoint to ask",
      async (metadataKind, outcome, messageFragment) => {
        const { calls, controller } = stageTakeoverRunner({
          cliLabelOwned: false,
          agentLoadedAfterBootout: false,
          agentRunning: true,
        });
        MOCKS.requestCooperativeShutdown.mockResolvedValue(outcome);

        await expect(
          controller.takeoverDesktopRegistration(label),
        ).rejects.toMatchObject({
          code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
          message: expect.stringContaining(messageFragment),
          details: expect.objectContaining({
            probedLabel: `${label.id}.agent`,
            metadata: metadataKind,
          }),
        });
        expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
      },
    );

    // The mirror case: an IDLE agent (no process for the claim to have
    // reached in the first place) gets the SAME `no-metadata`/`no-host`
    // answer, but `agentProbe.running` is false, so the refusal above never
    // fires - there was nothing to ask, and the agent is booted out exactly
    // as it would be for any other non-`busy` outcome. No degradation
    // warning either: that only logs for `unreachable`/`hung`.
    it("boots out an idle agent and resolves cooperativeStop 'no-host' when the claim answers no-metadata, with no warning logged", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: false,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "no-metadata",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "no-host",
      });
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual(["bootout", "--wait", agentTarget]);
      expect(MOCKS.cliLoggerWarn).not.toHaveBeenCalled();
    });

    // A dual-registered machine: Desktop's agent AND the raw CLI-label
    // plist are both loaded. `takeoverDesktopRegistration` boots out the
    // agent first (the claim above went through `pid.json`), then - under
    // the same lock - also unloads the CLI label so launchd cannot start
    // it while `installService` writes its files underneath this takeover.
    const cliTarget = `gui/${process.getuid?.() ?? 0}/${label.id}`;

    it("also unloads a CLI-label job loaded beside Desktop's agent, with --wait and a positive re-probe", async () => {
      // The FIRST cli print is `standDownLiveCliLabelHost`'s no-agent probe
      // above (a `cliProbe` reading loaded-idle also short-circuits that
      // check, since only a positive pid trips it); the takeover then reads
      // the CLI label a SECOND time, fresh, after the agent is retired -
      // that fresh read is what this test is pinning.
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
        cliLabelLoadedAsCliOrOther: { afterBootout: "absent" },
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "stopped",
      });
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "print",
        "print",
        "bootout",
        "print",
      ]);
      expect(calls[5]?.args).toEqual(["bootout", "--wait", cliTarget]);
      expect(calls[6]?.args[1]).toEqual(cliTarget);
      // The CLI label was idle (no pid) both times it was read, so its
      // stand-down never itself asks for a claim - only the agent's claim
      // above was made.
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledTimes(1);
      // `standDownLiveCliLabelHost`'s pid-null branch logs the same generic
      // message whether or not an agent was just retired - there is no
      // agent-specific copy any more, so this pins the message it does log.
      expect(MOCKS.cliLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining(
          "the CLI label is loaded with no running process",
        ),
        expect.objectContaining({ label: label.id }),
      );
    });

    it("rejects with SERVICE_INSTALL_FAILED ('did not take effect') when the CLI-label job loaded beside Desktop's agent does not unload", async () => {
      const { controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
        cliLabelLoadedAsCliOrOther: { afterBootout: "still-loaded" },
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      // Re-assert against the SAME already-settled promise (not a fresh
      // call): `stageTakeoverRunner`'s print counters are shared, mutable
      // state, and a second invocation would keep incrementing them into a
      // completely different scenario rather than repeating this one.
      const takeover = controller.takeoverDesktopRegistration(label);
      await expect(takeover).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "did not take effect (the job is still loaded)",
        ),
      });
      await expect(takeover).rejects.toMatchObject({
        message: expect.stringContaining("is already deregistered"),
      });
    });

    // Rule 2: the claim is skipped ONLY when the CLI label is the one
    // holding a process. An idle agent with the CLI label absent is not
    // that case - `pid.json` could still name a hand-run host, so the claim
    // is made here even though the agent itself reports no process.
    it("still makes the cooperative claim for an idle agent when the CLI label is absent, because a hand-run host must be asked", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: false,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "no-host" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "no-host",
      });
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledTimes(1);
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual(["bootout", "--wait", agentTarget]);
    });

    // The other half of rule 2: an idle agent beside a CLI label that DOES
    // hold a process. Here the first claim IS skipped - the CLI label is
    // the one with the process, so the stand-down asks it afterwards, with
    // a claim that reaches only that host. The agent is still booted out
    // unconditionally (idle, so its own liveness check is trivially "no");
    // the CLI label is then re-read fresh and its own stand-down makes the
    // ONLY cooperative claim in this run, and that claim's answer -
    // "stopped" - is what the overall result reports.
    it("skips the first claim for an idle agent when the CLI label holds the process, and reports the stand-down's claim as the outcome", async () => {
      const calls: RecordedCall[] = [];
      let agentPrints = 0;
      let cliPrints = 0;
      const cliLoadedPidResult = {
        stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n\tpid = 4242\n`,
        stderr: "",
        exitCode: 0,
      };
      const notFoundResult = {
        stdout: "",
        stderr: "Could not find specified service\n",
        exitCode: 113,
      };
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            // First probe: idle SMAppService agent (no pid, no state
            // line). Second probe (post-bootout verify): gone.
            return agentPrints === 1
              ? { stdout: `path = ${smAgentPath}\n`, stderr: "", exitCode: 0 }
              : notFoundResult;
          }
          cliPrints += 1;
          // Both reads before the CLI-label bootout - the initial
          // `cliProbe` (decides `claimHere`) and the fresh re-probe after
          // the agent is retired - see the same running process; the third
          // (post-bootout verify) answers absent.
          return cliPrints <= 2 ? cliLoadedPidResult : notFoundResult;
        }
        return buildSuccessResult();
      };
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "stopped",
      });
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledTimes(1);
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "print",
        "print",
        "bootout",
        "print",
      ]);
      expect(calls[2]?.args).toEqual(["bootout", "--wait", agentTarget]);
      expect(calls[5]?.args).toEqual(["bootout", "--wait", cliTarget]);
    });

    // Replaces an older "pre-check" pin: with the dual-live refusal below
    // added, a live pid on the CLI label beside a running agent is caught by
    // THAT guard instead, before any claim is even considered - there is no
    // longer a distinct "claim finds no endpoint" pre-check to pin on its
    // own.
    it("rejects with SERVICE_INSTALL_FAILED ('two hosts on one machine') before any claim or bootout when both the agent and the CLI label report a running process", async () => {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            return {
              stdout: `path = ${smAgentPath}\n\tpid = 777\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n\tpid = 4242\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return buildSuccessResult();
      };

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("two hosts on one machine"),
        details: expect.objectContaining({
          agentLabel: `${label.id}.agent`,
          agentPid: 777,
          cliPid: 4242,
        }),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    // Rule 1 is keyed on both probes' `running`, WHATEVER owns the agent
    // label - not only the SMAppService took-over arm. A pre-split-style
    // machine where the agent label itself was loaded as a raw
    // `~/Library/LaunchAgents/<label>.agent.plist` (`cli-or-other`
    // ownership, not an in-bundle SMAppService path) with a live process
    // beside a running CLI label is refused by the SAME dual-live guard,
    // before the no-agent early return ever reads `agentProbe.ownership`.
    it("rejects with SERVICE_INSTALL_FAILED ('two hosts on one machine') when the agent label is loaded cli-or-other (not SMAppService) and both labels report a running process", async () => {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            return {
              stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.agent.plist\n\ttype = LaunchAgent\n\tpid = 777\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n\tpid = 4242\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return buildSuccessResult();
      };

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("two hosts on one machine"),
        details: expect.objectContaining({
          agentLabel: `${label.id}.agent`,
          agentPid: 777,
          cliPid: 4242,
        }),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    // `agentBootout` shared by the two tests below: `bootout --wait`
    // resolving a NON-ZERO exit is what the runner reports for its own
    // timeout (`tolerateNonZeroExit` turns a hang into exit -1) - the
    // process-alive check below is gated on exactly that, since after a
    // clean exit 0 the pid launchd reported can already have been recycled.
    function stageAgentAliveAfterBootoutRunner(input: {
      bootoutExitCode: number;
    }): ProcessRunner {
      let agentPrints = 0;
      return async (command, args) => {
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            // First probe establishes Desktop ownership with a live pid; the
            // verification probe after `bootout --wait` reads the label
            // gone - the process (checked separately via `isProcessAlive`)
            // is what has not actually exited.
            return agentPrints === 1
              ? {
                  stdout: `path = ${smAgentPath}\n\tpid = 777\n`,
                  stderr: "",
                  exitCode: 0,
                }
              : {
                  stdout: "",
                  stderr: "Could not find specified service\n",
                  exitCode: 113,
                };
          }
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        if (args[0] === "bootout") {
          return { stdout: "", stderr: "", exitCode: input.bootoutExitCode };
        }
        return buildSuccessResult();
      };
    }

    it("rejects with SERVICE_INSTALL_FAILED ('is still running after the wait') when the agent's process survives the bootout wait", async () => {
      const runner = stageAgentAliveAfterBootoutRunner({ bootoutExitCode: -1 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "x",
      });
      MOCKS.isProcessAlive.mockImplementation((pid: number) => pid === 777);

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("is still running after the wait"),
        details: expect.objectContaining({
          agentLabel: `${label.id}.agent`,
          pid: 777,
          verification: "process-alive",
        }),
      });
    });

    it("does not refuse the takeover when the agent's bootout exits cleanly even though `isProcessAlive` reports the reported pid alive (a recycled pid)", async () => {
      const runner = stageAgentAliveAfterBootoutRunner({ bootoutExitCode: 0 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "x",
      });
      MOCKS.isProcessAlive.mockImplementation((pid: number) => pid === 777);

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).resolves.toMatchObject({ kind: "took-over" });
    });

    it("rejects with SERVICE_INSTALL_FAILED ('the wait did not end with its exit') when the agent's state is running but has no pid to verify after the bootout wait", async () => {
      let agentPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            // launchd reports the job running (no pid printed) - the same
            // reading the desktop's parked-registration probe makes. The
            // verification print after bootout reads absent; only the
            // process itself (which cannot be checked without a pid) may
            // still be alive.
            return agentPrints === 1
              ? {
                  stdout: `path = ${smAgentPath}\n\tstate = running\n`,
                  stderr: "",
                  exitCode: 0,
                }
              : {
                  stdout: "",
                  stderr: "Could not find specified service\n",
                  exitCode: 113,
                };
          }
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        if (args[0] === "bootout") {
          return { stdout: "", stderr: "", exitCode: -1 };
        }
        return buildSuccessResult();
      };
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "x",
      });

      await expect(
        createMacosController(runner).takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("the wait did not end with its exit"),
        details: expect.objectContaining({
          agentLabel: `${label.id}.agent`,
          pid: null,
          verification: "process-unverified",
        }),
      });
    });

    // Staging for the two pins below: the agent is running (a live pid on
    // its FIRST print) so the took-over arm's own claim actually fires - a
    // claim is only made when the agent reports a process now. The CLI
    // label is absent on the FIRST print (so the initial
    // `standDownLiveCliLabelHost(..., null)` call from the no-agent branch
    // never fires here - the dual-live guard also stays clear, since the CLI
    // label has no process yet when the agent's claim is made), but loaded
    // with a live pid on the SECOND, fresh print the takeover runs after
    // retiring the agent. That live pid means a real, SECOND cooperative
    // claim is made for the CLI label's own stand-down.
    function stageCliAbsentThenLoadedRunner(input: {
      cliVerifyAfterBootout: "absent" | "still-loaded";
    }): {
      calls: RecordedCall[];
      controller: ServiceController;
    } {
      const calls: RecordedCall[] = [];
      let agentPrints = 0;
      let cliPrints = 0;
      const loadedWithPid = {
        stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n\tpid = 4242\n`,
        stderr: "",
        exitCode: 0,
      };
      const notFound = {
        stdout: "",
        stderr: "Could not find specified service\n",
        exitCode: 113,
      };
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            return agentPrints === 1
              ? {
                  stdout: `path = ${smAgentPath}\n\tpid = 777\n`,
                  stderr: "",
                  exitCode: 0,
                }
              : notFound;
          }
          cliPrints += 1;
          if (cliPrints === 1) return notFound;
          if (cliPrints === 2) return loadedWithPid;
          return input.cliVerifyAfterBootout === "still-loaded"
            ? loadedWithPid
            : notFound;
        }
        return buildSuccessResult();
      };
      return { calls, controller: createMacosController(runner) };
    }

    it("rejects when the CLI label appears with a live pid after the agent is retired and the fresh claim finds no endpoint", async () => {
      const { calls, controller } = stageCliAbsentThenLoadedRunner({
        cliVerifyAfterBootout: "absent",
      });
      MOCKS.requestCooperativeShutdown
        .mockResolvedValueOnce({ kind: "stopped" })
        .mockResolvedValueOnce({ kind: "no-metadata" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "is already deregistered; re-run the command in a moment",
        ),
      });
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledTimes(2);
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(true);
    });

    it("also unloads a CLI-label job that appears with a live pid after the agent is retired, once the fresh claim succeeds", async () => {
      const { calls, controller } = stageCliAbsentThenLoadedRunner({
        cliVerifyAfterBootout: "absent",
      });
      MOCKS.requestCooperativeShutdown
        .mockResolvedValueOnce({ kind: "stopped" })
        .mockResolvedValueOnce({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "stopped",
      });
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        "print",
        "bootout",
        "print",
        "print",
        "bootout",
        "print",
      ]);
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledTimes(2);
    });

    // Rule 3, took-over arm: `refuseIfPublishedHostAlive` runs after the
    // agent is retired and the CLI label's own stand-down has resolved. A
    // "dead" verdict on a leftover `pid.json` is proof the process is gone,
    // so the takeover still succeeds.
    it("still resolves took-over when a published endpoint's identity verdict is 'dead'", async () => {
      const { controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: null,
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("dead");

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "took-over",
        agentLabelId: `${label.id}.agent`,
        cooperativeStop: "stopped",
      });
    });

    // The gate now runs BEFORE the "CLI now owns host registration" audit
    // line - a took-over arm refused at `refuseIfPublishedHostAlive` must
    // never have logged that line, or a support thread would show the
    // ownership hand-off succeeding right above the error that says it
    // didn't.
    it("does not log 'the CLI now owns host registration' when the gate refuses the takeover (verdict 'current')", async () => {
      const { controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "read",
        metadata: {
          pid: 9001,
          hostId: "hand-run-host",
          version: "1.2.3",
          websocketUrl: "ws://127.0.0.1:9001/rpc",
          startedAt: "2026-07-12T00:00:00.000Z",
          processStartIdentity: null,
        },
      });
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("current");

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("a host is still running (pid 9001"),
      });
      expect(MOCKS.cliLoggerInfo).not.toHaveBeenCalledWith(
        expect.stringContaining("the CLI now owns host registration"),
        expect.anything(),
      );
    });

    // The took-over variant: the gate fires AFTER the agent is retired, so
    // the routing tail must name it, exactly like every other refusal this
    // arm can issue post-retirement.
    it("rejects with SERVICE_INSTALL_FAILED ('could not be read') when the published record is unreadable (took-over arm), naming the retired agent", async () => {
      const { controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: false,
        agentRunning: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });
      MOCKS.readHostPidMetadataEvidence.mockResolvedValue({
        kind: "unreadable",
        cause: "not valid JSON",
      });

      const takeover = controller.takeoverDesktopRegistration(label);
      await expect(takeover).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("could not be read (not valid JSON)"),
        details: expect.objectContaining({ cause: "not valid JSON" }),
      });
      await expect(takeover).rejects.toMatchObject({
        message: expect.stringContaining("is already deregistered"),
      });
      expect(MOCKS.cliLoggerInfo).not.toHaveBeenCalledWith(
        expect.stringContaining("the CLI now owns host registration"),
        expect.anything(),
      );
    });
  });

  describe("takeoverDesktopRegistration - standing down a live CLI-label host", () => {
    // No Desktop SMAppService agent is loaded (the `.agent` probe reads
    // not-loaded, exit 113), but the CLI label itself is loaded from a
    // raw `~/Library/LaunchAgents/<label>.plist` path (NOT an in-bundle
    // SMAppService path, so this stays `cli-or-other` rather than
    // tripping the pre-split refusal) with an optional live `pid` -
    // the KeepAlive-respawn race `standDownLiveCliLabelHost` exists to
    // close.
    //
    // `postBootout` controls the SECOND non-`.agent` print (the positive
    // re-probe after `bootout --wait`, mirroring `agentLoadedAfterBootout`
    // in `stageTakeoverRunner` above): "absent" (default) answers with
    // launchd's not-found output, "still-loaded" repeats the loaded
    // answer, and "spawn-failure" throws so the probe reads indeterminate.
    function stageStandDownRunner(input: {
      pid: number | null;
      postBootout?: "absent" | "still-loaded" | "spawn-failure";
      bootoutExitCode?: number;
      // A `state = <value>` line on the FIRST cli-label print - "running"
      // (case-insensitive per `probeLabelForTakeover`) makes the job
      // `running` with no pid to check; anything else (e.g. "waiting")
      // exercises the idle path with an explicit non-running state instead
      // of no state line at all.
      stateLine?: "running" | "waiting";
    }): {
      calls: RecordedCall[];
      controller: ServiceController;
    } {
      const calls: RecordedCall[] = [];
      let cliLabelPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            return {
              stdout: "",
              stderr: "Could not find specified service\n",
              exitCode: 113,
            };
          }
          cliLabelPrints += 1;
          if (cliLabelPrints === 1) {
            const pidLine = input.pid === null ? "" : `\tpid = ${input.pid}\n`;
            const stateLine =
              input.stateLine === undefined
                ? ""
                : `\tstate = ${input.stateLine}\n`;
            return {
              stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n${stateLine}${pidLine}`,
              stderr: "",
              exitCode: 0,
            };
          }
          const postBootout = input.postBootout ?? "absent";
          if (postBootout === "still-loaded") {
            return {
              stdout: `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist\n\ttype = LaunchAgent\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          if (postBootout === "spawn-failure") {
            throw new Error("launchctl could not be spawned");
          }
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        if (args[0] === "bootout") {
          return {
            stdout: "",
            stderr: "",
            exitCode: input.bootoutExitCode ?? 0,
          };
        }
        return buildSuccessResult();
      };
      return { calls, controller: createMacosController(runner) };
    }

    it("rejects with HOST_BUSY and never boots out when the live CLI-label host denies the shutdown claim", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: 4242 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "busy" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: expect.stringContaining("denied the shutdown claim"),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("rejects with SERVICE_INSTALL_FAILED and never boots out when the live CLI-label host has not published a live endpoint yet (no-metadata)", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: 4242 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "no-metadata",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "has not published a live endpoint yet",
        ),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("rejects with SERVICE_INSTALL_FAILED a distinct message, and never boots out, when launchd's pid names a host that is gone (no-host)", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: 4242 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "no-host",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "names a host that is gone - exited, or a pid that now belongs to an unrelated process",
        ),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("resolves cli-host-stopped/stopped and logs the stand-down when the live CLI-label host stops cooperatively, after booting it out and verifying it is gone", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: 4242 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "stopped",
      });
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledWith(
        label.environment,
        "takeover",
        "shutdown",
      );
      expect(MOCKS.cliLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("stood down before the reload"),
        expect.objectContaining({ label: label.id, pid: 4242 }),
      );
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual([
        "bootout",
        "--wait",
        `gui/${process.getuid?.() ?? 0}/${label.id}`,
      ]);
      const prints = calls.filter(
        (c) => c.args[0] === "print" && c.args[1]?.endsWith(".agent") !== true,
      );
      expect(prints).toHaveLength(2);
    });

    it("resolves cli-host-stopped/skipped-unreachable and warns when the live CLI-label host cannot be stopped cooperatively, after booting it out and verifying it is gone", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: 4242 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "boom",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "skipped-unreachable",
      });
      expect(MOCKS.cliLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("could not be stopped cooperatively"),
        expect.objectContaining({ cause: "boom" }),
      );
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(true);
    });

    it("resolves cli-host-stopped/skipped-unreachable and warns when the live CLI-label host is hung, after booting it out and verifying it is gone", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: 4242 });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "skipped-unreachable",
      });
      expect(MOCKS.cliLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("could not be stopped cooperatively"),
        expect.objectContaining({
          cause: "pid 4242 outlived the shutdown grace",
        }),
      );
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual([
        "bootout",
        "--wait",
        `gui/${process.getuid?.() ?? 0}/${label.id}`,
      ]);
      const prints = calls.filter(
        (c) => c.args[0] === "print" && c.args[1]?.endsWith(".agent") !== true,
      );
      expect(prints).toHaveLength(2);
    });

    it("rejects with SERVICE_INSTALL_FAILED ('is still running after the wait') when a hung live CLI-label host's process survives the bootout wait", async () => {
      // The liveness refusal fires only when `bootout --wait` itself did
      // NOT exit cleanly (the runner-timeout case) - stage that explicitly.
      const { calls, controller } = stageStandDownRunner({
        pid: 4242,
        bootoutExitCode: -1,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });
      MOCKS.isProcessAlive.mockImplementation((pid: number) => pid === 4242);

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("is still running after the wait"),
        details: expect.objectContaining({
          pid: 4242,
          verification: "process-alive",
        }),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(true);
    });

    it("does not refuse the takeover when the CLI-label bootout exits cleanly even though `isProcessAlive` reports the reported pid alive (a recycled pid)", async () => {
      const { controller } = stageStandDownRunner({
        pid: 4242,
        bootoutExitCode: 0,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });
      MOCKS.isProcessAlive.mockImplementation((pid: number) => pid === 4242);

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "skipped-unreachable",
      });
    });

    // The "recycled pid" control above passes because the identity verdict
    // defaults to "indeterminate", which still falls back to the bootout
    // exit code. A "current" verdict is stronger evidence than any exit code
    // or cooperative answer: it is the SAME process the probe read, so it
    // refuses even after the host answered `stopped` and even with a clean
    // bootout exit.
    it("rejects with SERVICE_INSTALL_FAILED ('is still running after the wait') when the published identity verdict is 'current', regardless of a clean bootout exit or a stopped answer", async () => {
      const { controller } = stageStandDownRunner({
        pid: 4242,
        bootoutExitCode: 0,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });
      MOCKS.isProcessAlive.mockImplementation((pid: number) => pid === 4242);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("current");

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("is still running after the wait"),
        details: expect.objectContaining({
          pid: 4242,
          verification: "process-alive",
        }),
      });
    });

    // The opposite evidence: a "mismatch" verdict means the alive pid is NOT
    // the process launchd reported (it was recycled) - conclusive enough to
    // resolve even though the bootout wait itself did not end cleanly.
    it("resolves cli-host-stopped/stopped when the published identity verdict is 'mismatch', even though the bootout wait exits non-zero", async () => {
      const { controller } = stageStandDownRunner({
        pid: 4242,
        bootoutExitCode: -1,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });
      MOCKS.isProcessAlive.mockImplementation((pid: number) => pid === 4242);
      MOCKS.getPublishedProcessIdentityVerdict.mockResolvedValue("mismatch");

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "stopped",
      });
    });

    it("rejects with SERVICE_INSTALL_FAILED ('did not take effect') when the post-bootout probe still finds the CLI-label job loaded", async () => {
      const { controller } = stageStandDownRunner({
        pid: 4242,
        postBootout: "still-loaded",
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "did not take effect (the job is still loaded)",
        ),
      });
    });

    it("rejects with SERVICE_INSTALL_FAILED ('could not confirm') when the post-bootout probe fails to spawn", async () => {
      const { controller } = stageStandDownRunner({
        pid: 4242,
        postBootout: "spawn-failure",
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "boom",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("could not confirm"),
      });
    });

    it("resolves cli-host-stopped/no-host, logs, and unloads the job when the CLI label is loaded but has no live pid, never calling requestCooperativeShutdown", async () => {
      const { calls, controller } = stageStandDownRunner({ pid: null });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "no-host",
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(MOCKS.cliLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("loaded with no running process"),
        expect.objectContaining({ label: label.id }),
      );
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual([
        "bootout",
        "--wait",
        `gui/${process.getuid?.() ?? 0}/${label.id}`,
      ]);
      const prints = calls.filter(
        (c) => c.args[0] === "print" && c.args[1]?.endsWith(".agent") !== true,
      );
      expect(prints).toHaveLength(2);
    });

    it("rejects with SERVICE_INSTALL_FAILED ('did not take effect') when the CLI label has no live pid and the post-bootout probe still finds it loaded", async () => {
      const { controller } = stageStandDownRunner({
        pid: null,
        postBootout: "still-loaded",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          "did not take effect (the job is still loaded)",
        ),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
    });

    // `state = running` with NO pid still counts as `running` per
    // `probeLabelForTakeover` - the job is asked to stand down just like a
    // pid-bearing one, and only the post-bootout liveness check has nothing
    // to key on (see the `process-unverified` pin below).
    it("resolves cli-host-stopped/stopped and asks a running, pidless CLI-label job to stand down (state = running, no pid)", async () => {
      const { calls, controller } = stageStandDownRunner({
        pid: null,
        stateLine: "running",
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "stopped",
      });
      expect(MOCKS.requestCooperativeShutdown).toHaveBeenCalledWith(
        label.environment,
        "takeover",
        "shutdown",
      );
      expect(MOCKS.cliLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("stood down before the reload"),
        expect.objectContaining({ label: label.id, pid: null }),
      );
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual([
        "bootout",
        "--wait",
        `gui/${process.getuid?.() ?? 0}/${label.id}`,
      ]);
    });

    it("rejects with SERVICE_INSTALL_FAILED naming 'a running job' when a running, pidless CLI-label job has not published a live endpoint yet (no-metadata)", async () => {
      const { calls, controller } = stageStandDownRunner({
        pid: null,
        stateLine: "running",
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "no-metadata",
      });

      const takeover = controller.takeoverDesktopRegistration(label);
      await expect(takeover).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("a running job under"),
      });
      await expect(takeover).rejects.toMatchObject({
        message: expect.stringContaining(
          "has not published a live endpoint yet",
        ),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("rejects with SERVICE_INSTALL_FAILED ('the wait did not end with its exit') when a running, pidless CLI-label job's bootout does not confirm exit", async () => {
      const { controller } = stageStandDownRunner({
        pid: null,
        stateLine: "running",
        bootoutExitCode: -1,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({
        kind: "unreachable",
        cause: "x",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("the wait did not end with its exit"),
        details: expect.objectContaining({
          verification: "process-unverified",
          pid: null,
        }),
      });
    });

    // `processMayLiveOn` is never cleared by a cooperative `stopped` answer:
    // the claim goes through `pid.json`, which need not name THIS label's
    // process, so evidence about the process itself - not the claim's own
    // outcome - decides whether the bootout wait proved it gone. A pidless
    // running job has nothing to check the kernel with, so launchd's own
    // exit is the only tiebreak: non-zero (the runner-timeout shape) still
    // refuses even after a `stopped` answer.
    it("rejects with SERVICE_INSTALL_FAILED ('the wait did not end with its exit') for a running, pidless CLI-label job even when the host ANSWERED the claim with stopped, because the bootout wait exits non-zero", async () => {
      const { calls, controller } = stageStandDownRunner({
        pid: null,
        stateLine: "running",
        bootoutExitCode: -1,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("the wait did not end with its exit"),
        details: expect.objectContaining({
          verification: "process-unverified",
          pid: null,
        }),
      });
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(true);
    });

    it("resolves cli-host-stopped/stopped for a running, pidless CLI-label job that ANSWERED the claim with stopped, when the bootout wait exits cleanly (0)", async () => {
      const { controller } = stageStandDownRunner({
        pid: null,
        stateLine: "running",
        bootoutExitCode: 0,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "stopped",
      });
    });

    it("resolves cli-host-stopped/no-host via the idle unload path (no claim) when the CLI-label job's state is explicitly not running (state = waiting, no pid)", async () => {
      const { calls, controller } = stageStandDownRunner({
        pid: null,
        stateLine: "waiting",
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).resolves.toEqual({
        kind: "cli-host-stopped",
        cooperativeStop: "no-host",
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      const bootout = calls.find((c) => c.args[0] === "bootout");
      expect(bootout?.args).toEqual([
        "bootout",
        "--wait",
        `gui/${process.getuid?.() ?? 0}/${label.id}`,
      ]);
    });

    // The CLI label not loaded at all (exit 113 on both probes) is already
    // covered above by "reports not-applicable when Desktop owns nothing"
    // in the `takeoverDesktopRegistration` describe block - that runner
    // makes every `print` call return exit 113, which puts `cliOwnership`
    // at `not-loaded` (not `cli-or-other`), so `standDownLiveCliLabelHost`
    // short-circuits to `not-applicable` without calling
    // `requestCooperativeShutdown`. No separate test added here.
  });

  describe("takeoverDesktopRegistration - indeterminate label probes fail closed", () => {
    // `probeLabelForTakeover` is three-state: a positive not-found answer is
    // `absent`, a positive loaded answer is `loaded`, and everything else
    // (spawn failure, timeout, permission text, an unrecognized non-zero
    // exit) is `indeterminate` - and an indeterminate read of EITHER label
    // must abort the takeover rather than fall through to "not applicable"
    // and let `installService`'s later plain bootout run with no claim.
    it("rejects when the CLI-label print exits 0 with no recognizable job fields (indeterminate ownership), instead of reading it as an idle cli-or-other job and unloading it with no claim", async () => {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            return {
              stdout: "",
              stderr: "Could not find specified service\n",
              exitCode: 113,
            };
          }
          return {
            stdout: "some unknown field = value\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return buildSuccessResult();
      };
      const controller = createMacosController(runner);

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          `could not read launchd's state for '${label.id}'`,
        ),
        details: expect.objectContaining({
          probedLabel: label.id,
          cause: "unrecognized-format",
        }),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
    });

    it("rejects when the CLI-label print exits non-zero with unrelated output, naming the CLI label and never touching cooperative shutdown or launchd", async () => {
      // The agent is probed FIRST now; it must read cleanly (not-loaded)
      // here so the indeterminate CLI-label read - not the agent read - is
      // what this test pins.
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            return {
              stdout: "",
              stderr: "Could not find specified service\n",
              exitCode: 113,
            };
          }
          return {
            stdout: "",
            stderr: "launchctl: some unrecognized internal error\n",
            exitCode: 1,
          };
        }
        return buildSuccessResult();
      };
      const controller = createMacosController(runner);

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          `could not read launchd's state for '${label.id}'`,
        ),
        details: expect.objectContaining({ probedLabel: label.id }),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
      // The agent probe runs first and reads cleanly; only then does the
      // indeterminate CLI-label read abort the takeover.
      expect(calls.map((c) => c.args[0])).toEqual(["print", "print"]);
    });

    it("rejects when the .agent print fails to spawn, naming the agent label, before the CLI label is ever probed", async () => {
      // The agent is probed FIRST, so a failure there aborts the takeover
      // before the CLI label is read at all - unlike the sibling test
      // above, there is no second print to stage.
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            throw new Error("launchctl could not be spawned");
          }
          return {
            stdout: "",
            stderr: "Could not find specified service\n",
            exitCode: 113,
          };
        }
        return buildSuccessResult();
      };
      const controller = createMacosController(runner);

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          `could not read launchd's state for '${label.id}.agent'`,
        ),
        details: expect.objectContaining({ probedLabel: `${label.id}.agent` }),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.some((c) => c.args[0] === "bootout")).toBe(false);
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("rejects when the fresh CLI probe after the agent's retirement fails to spawn, naming both the CLI label and the already-deregistered agent", async () => {
      const agentPlistPath =
        "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.agent.plist";
      let agentPrints = 0;
      let cliPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            return agentPrints === 1
              ? {
                  stdout: `path = ${agentPlistPath}\n`,
                  stderr: "",
                  exitCode: 0,
                }
              : {
                  stdout: "",
                  stderr: "Could not find specified service\n",
                  exitCode: 113,
                };
          }
          cliPrints += 1;
          if (cliPrints === 1) {
            return {
              stdout: "",
              stderr: "Could not find specified service\n",
              exitCode: 113,
            };
          }
          throw new Error("launchctl could not be spawned");
        }
        return buildSuccessResult();
      };
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "stopped" });

      const takeover =
        createMacosController(runner).takeoverDesktopRegistration(label);
      await expect(takeover).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining(
          `could not read launchd's state for '${label.id}'`,
        ),
        details: expect.objectContaining({ agentLabel: `${label.id}.agent` }),
      });
      await expect(takeover).rejects.toMatchObject({
        message: expect.stringContaining("is already deregistered"),
      });
    });
  });

  it("stop/start/restart proceed normally when the agent probe reads not-loaded (CLI-managed machine)", async () => {
    // The guard must never block a genuinely CLI-managed machine - the
    // probe is advisory and a not-loaded agent label falls through to the
    // normal launchctl path. Exercises all three operations (not just
    // start): a regression where the guard incorrectly blocks a legitimate
    // stop/restart on a CLI-managed machine must be caught here too.
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "print") {
        return {
          stdout: "",
          stderr: "Could not find specified service\n",
          exitCode: 113,
        };
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    // `readHostPidMetadata` resolves null throughout - stop's own
    // wait-for-exit path is exercised separately below; here it's enough
    // that `before === null` lets stop return right after the kill call.
    MOCKS.readHostPidMetadata.mockResolvedValue(null);

    for (const [op, expectedSecondCall] of [
      [() => controller.stop(label, { force: false }), "kill"],
      [() => controller.start(label), "kickstart"],
      [() => controller.restart(label), "kickstart"],
    ] as const) {
      calls.length = 0;
      await expect(op()).resolves.toBeUndefined();
      expect(calls.map((c) => c.args[0])).toEqual([
        "print",
        expectedSecondCall,
      ]);
    }
  });

  it("still reports stopped for a CLI-owned LaunchAgents registration", async () => {
    createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
    await writeFile(createdPlistPath, "cli owned", "utf8");
    const cliPath = createdPlistPath;
    const runner: ProcessRunner = async (command, args, options) => {
      if (args[0] === "print") {
        if (options.tolerateNonZeroExit) {
          return {
            stdout: `path = ${cliPath}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);

    await expect(controller.status(label)).resolves.toEqual({
      state: "stopped",
      version: null,
      listenUrl: null,
      pid: null,
    });
  });

  // The repair counterpart to the SMAppService refusals: the classifier fix
  // stops a dual registration being CREATED, this removes one already on
  // disk from the v1.1.7 window. Both preconditions are load-bearing and
  // asymmetric - failing to retire leaves a duplicate host, but retiring on
  // the wrong machine takes away its ONLY host.
  describe("retireCompetingRegistration (dual-registration repair)", () => {
    const agentLabelId = smAppServiceAgentLabelId(label);

    const SMAPPSERVICE_PRINT = [
      "\tpath = (submitted by smd.321)",
      "\ttype = Submitted",
      "\tmanaged_by = com.apple.xpc.ServiceManagement",
    ].join("\n");
    const CLI_PRINT = [
      `\tpath = /Users/me/Library/LaunchAgents/${label.id}.plist`,
      "\ttype = LaunchAgent",
    ].join("\n");

    // Drives `launchctl print` per target so each test states exactly which
    // labels are loaded and by whom. Anything unlisted reads as not-loaded.
    function makeRunner(
      loaded: Readonly<Record<string, string>>,
      calls: RecordedCall[],
    ): ProcessRunner {
      return async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          const target = args[1] ?? "";
          const printOutput = Object.entries(loaded).find(([labelId]) =>
            target.endsWith(`/${labelId}`),
          )?.[1];
          return printOutput === undefined
            ? { stdout: "", stderr: "Could not find service", exitCode: 113 }
            : {
                stdout: `${target} = {\n${printOutput}\n}\n`,
                stderr: "",
                exitCode: 0,
              };
        }
        return buildSuccessResult();
      };
    }

    // Flag-agnostic: the target is the last positional, so inserting
    // `--wait` (or any future flag) doesn't silently shift what we assert on.
    function bootoutTargets(calls: readonly RecordedCall[]): readonly string[] {
      return calls
        .filter((call) => call.args[0] === "bootout")
        .map((call) => call.args[call.args.length - 1] ?? "");
    }

    it("retires a competing CLI registration when Desktop's agent owns the host", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner(
        { [agentLabelId]: SMAPPSERVICE_PRINT, [label.id]: CLI_PRINT },
        calls,
      );
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "retired",
        bootedOut: true,
        manifestRemoved: true,
        agentStartRequested: true,
      });

      // Only the CLI label is booted out - never the agent Desktop owns.
      const booted = bootoutTargets(calls);
      expect(booted).toHaveLength(1);
      expect(booted[0]?.endsWith(`/${label.id}`)).toBe(true);
      await expect(readFile(createdPlistPath, "utf8")).rejects.toThrow();
    });

    /*
     * The availability gate, in both directions.
     *
     * "Desktop's agent is loaded" is the only thing the ownership probe
     * proves, and it is not enough to justify deleting the other
     * registration. On a machine where the agent is loaded but cannot spawn
     * (stale LWCR after an app replace, EX_CONFIG), the CLI job may be the
     * ONLY host that runs - very possibly because the user created it with
     * `service install --takeover` for exactly this reason. Retiring it there
     * boots out the working host and kickstarts one already known to fail:
     * the hostless lockout, produced by the repair.
     *
     * Desktop's launch-time retirement already gates the identical
     * destructive direction; this is the CLI-side half of that rule.
     */
    const WEDGED_AGENT_PRINT = [
      "\tpath = (submitted by smd.321)",
      "\ttype = Submitted",
      "\tmanaged_by = com.apple.xpc.ServiceManagement",
      "\tstate = spawn failed",
      "\tlast exit code = 78",
    ].join("\n");

    it("keeps the competing CLI registration when Desktop's agent shows positive wedge markers", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner(
        { [agentLabelId]: WEDGED_AGENT_PRINT, [label.id]: CLI_PRINT },
        calls,
      );
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "kept-agent-possibly-wedged",
        probe: "wedged",
      });

      // Nothing destructive ran: the CLI job still exists and its manifest
      // is still on disk. Asserting the outcome alone would pass even if the
      // bootout had happened and only the return value changed.
      expect(bootoutTargets(calls)).toEqual([]);
      expect(calls.filter((call) => call.args[0] === "kickstart")).toEqual([]);
      await expect(readFile(createdPlistPath, "utf8")).resolves.toBe(
        "<plist/>",
      );
    });

    it("keeps the competing CLI registration when the agent's health cannot be read at all", async () => {
      const calls: RecordedCall[] = [];
      // The ownership probe answers (so the repair is in scope), then the
      // wedge probe cannot run. An unreadable health probe must fail toward
      // keeping the registration, exactly like positive wedge evidence.
      let printsSeen = 0;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          printsSeen += 1;
          if (printsSeen === 1) {
            return {
              stdout: `${args[1] ?? ""} = {\n${SMAPPSERVICE_PRINT}\n}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          throw new Error("launchctl could not be spawned");
        }
        return buildSuccessResult();
      };
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "kept-agent-possibly-wedged",
        probe: "unknown",
      });
      expect(bootoutTargets(calls)).toEqual([]);
      await expect(readFile(createdPlistPath, "utf8")).resolves.toBe(
        "<plist/>",
      );
    });

    // The availability step. The agent job being LOADED (which is all the
    // ownership probe proves) does not mean it has a live process: the loser
    // of the login race declines and exits 0, and
    // `KeepAlive{SuccessfulExit:false}` never respawns a clean exit. Without
    // this kickstart, evicting the CLI-label job can leave the machine with
    // no running host at all, and the CLI cannot recover - start/restart both
    // refuse via `assertNotDesktopAgentManaged` on exactly this machine.
    it("kickstarts Desktop's agent after evicting the competing host", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner(
        { [agentLabelId]: SMAPPSERVICE_PRINT, [label.id]: CLI_PRINT },
        calls,
      );

      await createMacosController(runner).retireCompetingRegistration(label);

      const kickstarts = calls.filter((call) => call.args[0] === "kickstart");
      expect(kickstarts).toHaveLength(1);
      expect(kickstarts[0]?.args[1]?.endsWith(`/${agentLabelId}`)).toBe(true);
      // Never `-k`: the plist sets ThrottleInterval 10, so force-killing a
      // healthy agent would make launchd block its respawn.
      expect(kickstarts[0]?.args).not.toContain("-k");
      // `--wait` on the eviction is what makes the kickstart meaningful: a
      // bare bootout returns before the process is gone, and the agent we
      // just started would then see the corpse as a live incumbent, decline,
      // and exit 0 - leaving the machine with no host at all.
      const booted = calls.find((call) => call.args[0] === "bootout");
      expect(booted?.args).toContain("--wait");
    });
    // The eviction log is the CONTRACT, not decoration: this function's
    // outcome is deliberately not threaded through the install lifecycle, so
    // this line is the only record anywhere that a running host was booted
    // out. It must survive a later step failing, which is why it is emitted
    // immediately and not folded into the success line.
    it("logs the eviction as soon as it happens, even when a later step fails", async () => {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          const target = args[1] ?? "";
          return {
            stdout: `${target} = {\n${target.endsWith(`/${agentLabelId}`) ? SMAPPSERVICE_PRINT : CLI_PRINT}\n}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        // Bootout succeeds; the kickstart that follows fails.
        if (args[0] === "kickstart") {
          throw buildLaunchctlError({
            stderr: "Operation not permitted",
            stdout: "",
            exitCode: 1,
            command,
            cmdArgs: args,
          });
        }
        return buildSuccessResult();
      };

      await createMacosController(runner).retireCompetingRegistration(label);

      const evictionLogged = MOCKS.cliLoggerInfo.mock.calls.some(
        ([message]) =>
          typeof message === "string" && message.includes("evicted"),
      );
      expect(evictionLogged).toBe(true);
    });

    // The manifest removal is the durable half of the repair and is local and
    // instantaneous; the kickstart is a subprocess that can burn its timeout.
    // Ordering them the other way risks losing the durable half to a slow
    // launchctl.
    it("removes the manifest before starting the agent", async () => {
      let manifestPresentAtKickstart: boolean | null = null;
      const manifestPath = join(tempPlistDir, `${label.id}.plist`);
      createdPlistPath = manifestPath;
      await writeFile(manifestPath, "<plist/>", "utf8");
      const runner: ProcessRunner = async (command, args) => {
        if (args[0] === "print") {
          const target = args[1] ?? "";
          return {
            stdout: `${target} = {\n${target.endsWith(`/${agentLabelId}`) ? SMAPPSERVICE_PRINT : CLI_PRINT}\n}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "kickstart") {
          manifestPresentAtKickstart = existsSync(manifestPath);
        }
        return buildSuccessResult();
      };

      await createMacosController(runner).retireCompetingRegistration(label);

      expect(manifestPresentAtKickstart).toBe(false);
    });

    // A hard bootout failure must not read as "this machine was already
    // clean". Loaded job + already-removed manifest is a NORMAL steady state
    // now that Desktop's launch repair deletes manifests without booting out,
    // so this exact combination is reachable in the field.
    it("reports retire-failed when a loaded job survives a failed bootout", async () => {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          const target = args[1] ?? "";
          return {
            stdout: `${target} = {\n${target.endsWith(`/${agentLabelId}`) ? SMAPPSERVICE_PRINT : CLI_PRINT}\n}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        throw buildLaunchctlError({
          stderr: "Operation not permitted",
          stdout: "",
          exitCode: 1,
          command,
          cmdArgs: args,
        });
      };

      // Only the loaded job remains to retire - assert that rather than
      // assume it, so a manifest leaked by an earlier test cannot silently
      // change which branch this exercises.
      expect(existsSync(join(tempPlistDir, `${label.id}.plist`))).toBe(false);

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "retire-failed",
        bootoutFailed: true,
        manifestRemovalFailed: false,
        bootedOut: false,
        bootoutIndeterminate: true,
        manifestRemoved: false,
      });

      // The competing host is STILL RUNNING (its bootout failed), so starting
      // the agent now would manufacture the exact dual-host state this repair
      // exists to remove. The `bootedOut` guard - not merely "the CLI label
      // was loaded" - is what prevents that.
      expect(calls.filter((call) => call.args[0] === "kickstart")).toEqual([]);
    });

    it("a bootout whose launchctl could not be spawned is a failed, NOT indeterminate, eviction", async () => {
      // `ProcessSpawnError` means the binary never started, so the request
      // never reached launchd and the registration is provably untouched -
      // the record decorator must not invalidate for it, unlike a bootout
      // that ran and failed (which may have been accepted before the waiter
      // died).
      const runner: ProcessRunner = async (command, args) => {
        if (args[0] === "print") {
          const target = args[1] ?? "";
          return {
            stdout: `${target} = {\n${target.endsWith(`/${agentLabelId}`) ? SMAPPSERVICE_PRINT : CLI_PRINT}\n}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        throw new ProcessSpawnError(
          `${command} ${args.join(" ")} could not be spawned (ENOENT): `,
          command,
          args,
          -1,
          "",
          "",
        );
      };
      expect(existsSync(join(tempPlistDir, `${label.id}.plist`))).toBe(false);

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "retire-failed",
        bootoutFailed: true,
        manifestRemovalFailed: false,
        bootedOut: false,
        bootoutIndeterminate: false,
        manifestRemoved: false,
      });
    });

    // The availability guard. Without an SMAppService-owned agent there is
    // no proof anything else would start a host at login, so the CLI
    // registration may be the machine's only one.
    it("does nothing when Desktop's agent does not own the host", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner({ [label.id]: CLI_PRINT }, calls);
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({ kind: "not-applicable" });

      expect(bootoutTargets(calls)).toEqual([]);
      await expect(readFile(createdPlistPath, "utf8")).resolves.toBe(
        "<plist/>",
      );
    });

    // Pre-label-split machine: the CLI label IS Desktop's SMAppService
    // registration. Booting it out or deleting a manifest here would
    // corrupt the BTM state Desktop manages - the exact thing
    // `installService`'s first refusal exists to prevent.
    it("never touches a CLI label that is itself SMAppService-owned", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner(
        {
          [agentLabelId]: SMAPPSERVICE_PRINT,
          [label.id]: SMAPPSERVICE_PRINT,
        },
        calls,
      );
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({ kind: "not-applicable" });

      expect(bootoutTargets(calls)).toEqual([]);
      await expect(readFile(createdPlistPath, "utf8")).resolves.toBe(
        "<plist/>",
      );
    });
    // Contractually non-throwing: this runs as a side effect of an install
    // whose bytes are already swapped in, so it must never fail it. The
    // manifest removal is the durable half and still applies.
    it("removes the manifest and resolves even when the bootout fails", async () => {
      const calls: RecordedCall[] = [];
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          const target = args[1] ?? "";
          const printOutput = target.endsWith(`/${agentLabelId}`)
            ? SMAPPSERVICE_PRINT
            : CLI_PRINT;
          return {
            stdout: `${target} = {\n${printOutput}\n}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        throw buildLaunchctlError({
          stderr: "Operation not permitted",
          stdout: "",
          exitCode: 1,
          command,
          cmdArgs: args,
        });
      };
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "retire-failed",
        bootoutFailed: true,
        manifestRemovalFailed: false,
        bootedOut: false,
        bootoutIndeterminate: true,
        manifestRemoved: true,
      });

      expect(MOCKS.cliLoggerWarn).toHaveBeenCalled();
      // The durable half still applies: reporting the failure must not cost
      // us the "does not come back at the next login" outcome.
      await expect(readFile(createdPlistPath, "utf8")).rejects.toThrow();
    });

    // Only the CLI-label probe fails. The agent probe must still succeed, or
    // the repair bails out at `not-applicable` before ownership matters.
    function makeRunnerWithFailingCliProbe(
      calls: RecordedCall[],
    ): ProcessRunner {
      return async (command, args) => {
        calls.push({ command, args });
        const target = args[1] ?? "";
        if (args[0] === "print") {
          if (target.endsWith(`/${agentLabelId}`)) {
            return {
              stdout: `${target} = {\n${SMAPPSERVICE_PRINT}\n}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          // Not a non-zero exit (that reads as not-loaded) - a genuine
          // spawn/timeout failure, the only way the probe rejects.
          throw new Error("launchctl print timed out");
        }
        return buildSuccessResult();
      };
    }

    it("never claims success when it could not read who owns the CLI label", async () => {
      const calls: RecordedCall[] = [];
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await expect(
        createMacosController(
          makeRunnerWithFailingCliProbe(calls),
        ).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "retire-failed",
        bootoutFailed: true,
        manifestRemovalFailed: false,
        bootedOut: false,
        bootoutIndeterminate: false,
        manifestRemoved: true,
      });

      // Never bootout an owner we could not identify: the CLI label may BE
      // Desktop's pre-split SMAppService registration, and evicting that
      // corrupts the BTM state Desktop manages.
      expect(bootoutTargets(calls)).toHaveLength(0);
      expect(calls.some((call) => call.args[0] === "kickstart")).toBe(false);
      // The durable half is safe either way, so it still happens.
      await expect(readFile(createdPlistPath, "utf8")).rejects.toThrow();
    });
    // Runs the body with the LaunchAgents directory unreadable, so `stat` on
    // the manifest inside it fails with EACCES rather than ENOENT. Skipped
    // under root, which bypasses permission checks entirely.
    const itUnlessRoot = it.skipIf(process.getuid?.() === 0);

    async function withUnreadableLaunchAgentsDir(
      body: () => Promise<void>,
    ): Promise<void> {
      await chmod(tempPlistDir, 0o000);
      try {
        await body();
      } finally {
        await chmod(tempPlistDir, 0o700);
      }
    }

    itUnlessRoot(
      "reports an unreadable manifest as a failed repair, never as a clean machine",
      async () => {
        const calls: RecordedCall[] = [];
        // Nothing loaded under the CLI label: the ONLY thing separating
        // "already clean" from "we could not look" is the probe outcome.
        const runner = makeRunner(
          { [agentLabelId]: SMAPPSERVICE_PRINT },
          calls,
        );

        await withUnreadableLaunchAgentsDir(async () => {
          await expect(
            createMacosController(runner).retireCompetingRegistration(label),
          ).resolves.toEqual({
            kind: "retire-failed",
            bootoutFailed: false,
            manifestRemovalFailed: true,
            bootedOut: false,
            bootoutIndeterminate: false,
            manifestRemoved: false,
          });
        });

        const warned = MOCKS.cliLoggerWarn.mock.calls.some((call) =>
          String(call[0]).includes("could not read"),
        );
        expect(warned).toBe(true);
      },
    );

    itUnlessRoot(
      "still evicts the competing host when the manifest cannot be read",
      async () => {
        const calls: RecordedCall[] = [];
        const runner = makeRunner(
          { [agentLabelId]: SMAPPSERVICE_PRINT, [label.id]: CLI_PRINT },
          calls,
        );

        await withUnreadableLaunchAgentsDir(async () => {
          await expect(
            createMacosController(runner).retireCompetingRegistration(label),
          ).resolves.toEqual({
            kind: "retire-failed",
            bootoutFailed: false,
            manifestRemovalFailed: true,
            bootedOut: true,
            bootoutIndeterminate: false,
            manifestRemoved: false,
          });
        });

        // An unreadable manifest costs us the durable half only. The live
        // dual-host state is still resolved, agent restarted.
        expect(bootoutTargets(calls)).toHaveLength(1);
        expect(
          calls.some(
            (call) =>
              call.args[0] === "kickstart" &&
              (call.args[call.args.length - 1] ?? "").endsWith(
                `/${agentLabelId}`,
              ),
          ),
        ).toBe(true);
      },
    );
  });

  describe("readRegisteredCliInvocation (host update's no-repoint contract)", () => {
    it("round-trips the command and leading args out of a plist buildPlist wrote, including XML-escaped characters", async () => {
      // `process.execPath` doubles as a command that provably exists on
      // disk (the reader refuses commands that are gone).
      const leadingArg = `--entry=/tmp/it's a <weird> & "path"`;
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(
        createdPlistPath,
        buildLaunchAgentPlist({
          label,
          cli: { command: process.execPath, args: [leadingArg] },
        }),
        "utf8",
      );

      await expect(readRegisteredCliInvocation(label)).resolves.toEqual({
        command: process.execPath,
        args: [leadingArg],
      });
    });

    it("returns null when there is no manifest, when the shape is not <command...host start>, or when the command no longer exists", async () => {
      // No manifest on disk at all.
      await expect(readRegisteredCliInvocation(label)).resolves.toBeNull();

      // Unrecognized ProgramArguments shape (not ending in `host start`).
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(
        createdPlistPath,
        `<plist><dict><key>ProgramArguments</key><array><string>${process.execPath}</string><string>serve</string></array></dict></plist>`,
        "utf8",
      );
      await expect(readRegisteredCliInvocation(label)).resolves.toBeNull();

      // Well-formed shape but the registered command is gone from disk -
      // preserving it would re-register a dead program; fall back to
      // normal resolution instead.
      await writeFile(
        createdPlistPath,
        buildLaunchAgentPlist({
          label,
          cli: { command: join(tempPlistDir, "missing-binary"), args: [] },
        }),
        "utf8",
      );
      await expect(readRegisteredCliInvocation(label)).resolves.toBeNull();
    });

    it("refuses a launcher-form manifest whose path is not this label's own serviceLauncherScriptPath", async () => {
      // Same basename, wrong path - e.g. an attacker-writable plist
      // engineered to look like the launcher-file form. Matching on the
      // `traycer-host-start` basename alone would treat this as a genuine
      // registration and PRESERVE its command across the next `host
      // update`, persisting an arbitrary CLI path into the freshly
      // rewritten plist. Only the exact path this label's own
      // `serviceLauncherScriptPath` resolves to may attest.
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(
        createdPlistPath,
        `<plist><dict><key>ProgramArguments</key><array><string>/tmp/attacker-controlled/traycer-host-start</string><string>${process.execPath}</string></array></dict></plist>`,
        "utf8",
      );

      await expect(readRegisteredCliInvocation(label)).resolves.toBeNull();
    });
  });
});
