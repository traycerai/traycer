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
import { ProcessRunError, type RunResult } from "../../process-runner";
import type { ServiceController } from "../../index";
import {
  serviceLabelFor,
  serviceLauncherScriptPath,
  smAppServiceAgentLabelId,
} from "../../label";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { ServiceMutationAuthorityError } from "../../mutation-authority";

const execFileAsync = promisify(execFile);

const MOCKS = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  isProcessAlive: vi.fn(),
  cliLoggerWarn: vi.fn(),
  cliLoggerInfo: vi.fn(),
  requestCooperativeShutdown: vi.fn(),
  forceStopHostProcess: vi.fn(),
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
}));

vi.mock("../../../store/cli-lock", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../store/cli-lock")>();
  return { ...actual, isProcessAlive: MOCKS.isProcessAlive };
});

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

  // The launcher-FILE form of the same contract: the macOS plist executes
  // `~/.traycer/service/<label>/traycer-host-start <cli> <args...>` (so BTM
  // names the login item after the file, not after /bin/sh), and BOTH CLI
  // generations must still start. Executes the real emitted file, exactly
  // like the inline-form row above.
  it("launcher file: starts both an N-1 CLI without --service-label and a current CLI with it, preserving leading invocation args", async () => {
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
  });

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
    MOCKS.isProcessAlive.mockReset();
    MOCKS.isProcessAlive.mockReturnValue(false);
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

  it("continues bootstrap retry when race-recovery bootout reports no such process", async () => {
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
            stderr: "Boot-out failed: 3: No such process\n",
            stdout: "",
            exitCode: 3,
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

    it("carries operation 'restart' through stopForRestart's force path, and a terminal outcome's message names 'host restart --force'", async () => {
      const { controller } = stageForceStop();
      MOCKS.forceStopHostProcess.mockResolvedValue({
        kind: "hung",
        pid: 4242,
      });

      await expect(
        controller.stopForRestart(label, { force: true }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining("host restart --force"),
      });
      expect(MOCKS.forceStopHostProcess).toHaveBeenCalledWith(
        label.environment,
        "restart",
      );
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

    it("stopForRestart with --force never throws over live work - it kills the pid instead", async () => {
      const { controller } = stageDesktopManagedRunner();
      // Busy is a cooperative-flow outcome; force never dials that RPC at
      // all, so staging `forceStopHostProcess` proves the busy gate was
      // skipped rather than merely unreached by accident.
      MOCKS.forceStopHostProcess.mockResolvedValue({ kind: "no-host" });

      await expect(
        controller.stopForRestart(label, { force: true }),
      ).resolves.toEqual({ forcedRecycle: true });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
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

    function stageTakeoverRunner(input: {
      cliLabelOwned: boolean;
      agentLoadedAfterBootout: boolean;
    }): {
      calls: RecordedCall[];
      controller: ServiceController;
    } {
      const calls: RecordedCall[] = [];
      let agentPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          if (args[1]?.endsWith(".agent") === true) {
            agentPrints += 1;
            const loaded =
              agentPrints === 1 ? true : input.agentLoadedAfterBootout;
            return loaded
              ? { stdout: `path = ${smAgentPath}\n`, stderr: "", exitCode: 0 }
              : {
                  stdout: "",
                  stderr: "Could not find specified service\n",
                  exitCode: 113,
                };
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

    it("aborts the takeover when the post-bootout probe fails for a reason that is not service-not-found", async () => {
      const calls: RecordedCall[] = [];
      let agentPrints = 0;
      const runner: ProcessRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "print") {
          const target = args[1] ?? "";
          if (target.endsWith(`/${label.id}.agent`)) {
            agentPrints += 1;
            if (agentPrints === 1) {
              return {
                stdout: `path = ${smAgentPath}\n`,
                stderr: "",
                exitCode: 0,
              };
            }
            // Non-zero, but NOT "could not find" - a permission failure is
            // no evidence the label is gone.
            return {
              stdout: "",
              stderr: "Operation not permitted\n",
              exitCode: 1,
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
      });

      await expect(
        controller.takeoverDesktopRegistration(label),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: expect.stringContaining("traycer host service uninstall"),
      });
      expect(MOCKS.requestCooperativeShutdown).not.toHaveBeenCalled();
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    });

    it("reports not-applicable when Desktop owns nothing", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: true,
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

    it("fails closed when the bootout does not take effect", async () => {
      const { calls, controller } = stageTakeoverRunner({
        cliLabelOwned: false,
        agentLoadedAfterBootout: true,
      });
      MOCKS.requestCooperativeShutdown.mockResolvedValue({ kind: "no-host" });

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
    it.each([
      ["unreachable", { kind: "unreachable", cause: "dial failed" }],
      ["hung", { kind: "hung", pid: 4242 }],
      ["no-metadata", { kind: "no-metadata" }],
    ] as const)(
      "waits for the evicted host to exit before install can race it (%s)",
      async (_name, outcome) => {
        const { calls, controller } = stageTakeoverRunner({
          cliLabelOwned: false,
          agentLoadedAfterBootout: false,
        });
        MOCKS.requestCooperativeShutdown.mockResolvedValue(outcome);

        await expect(
          controller.takeoverDesktopRegistration(label),
        ).resolves.toMatchObject({ kind: "took-over" });

        const bootout = calls.find((c) => c.args[0] === "bootout");
        expect(bootout?.args).toEqual(["bootout", "--wait", agentTarget]);
      },
    );
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

    // Nothing was evicted, so there is nothing to compensate for - and
    // kickstarting anyway would start a host on a machine whose agent
    // launchd had deliberately left down. Covers the CLI-label-not-loaded
    // branch; the loaded-but-bootout-failed branch is pinned below.
    it("does not kickstart the agent when nothing was evicted", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner({ [agentLabelId]: SMAPPSERVICE_PRINT }, calls);
      createdPlistPath = join(tempPlistDir, `${label.id}.plist`);
      await writeFile(createdPlistPath, "<plist/>", "utf8");

      await createMacosController(runner).retireCompetingRegistration(label);

      expect(calls.filter((call) => call.args[0] === "kickstart")).toEqual([]);
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
      });

      // The competing host is STILL RUNNING (its bootout failed), so starting
      // the agent now would manufacture the exact dual-host state this repair
      // exists to remove. The `bootedOut` guard - not merely "the CLI label
      // was loaded" - is what prevents that.
      expect(calls.filter((call) => call.args[0] === "kickstart")).toEqual([]);
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

    it("reports nothing-to-retire on a healthy post-split machine", async () => {
      const calls: RecordedCall[] = [];
      const runner = makeRunner({ [agentLabelId]: SMAPPSERVICE_PRINT }, calls);

      await expect(
        createMacosController(runner).retireCompetingRegistration(label),
      ).resolves.toEqual({ kind: "nothing-to-retire" });

      expect(bootoutTargets(calls)).toEqual([]);
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
      });

      // Never bootout an owner we could not identify: the CLI label may BE
      // Desktop's pre-split SMAppService registration, and evicting that
      // corrupts the BTM state Desktop manages.
      expect(bootoutTargets(calls)).toHaveLength(0);
      expect(calls.some((call) => call.args[0] === "kickstart")).toBe(false);
      // The durable half is safe either way, so it still happens.
      await expect(readFile(createdPlistPath, "utf8")).rejects.toThrow();
    });

    it("does not report an unprobeable machine as already clean", async () => {
      const calls: RecordedCall[] = [];
      // No manifest on disk: folding a failed probe into not-loaded would
      // make this the `nothing-to-retire` ("already clean") path.
      await expect(
        createMacosController(
          makeRunnerWithFailingCliProbe(calls),
        ).retireCompetingRegistration(label),
      ).resolves.toEqual({
        kind: "retire-failed",
        bootoutFailed: true,
        manifestRemovalFailed: false,
      });
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
