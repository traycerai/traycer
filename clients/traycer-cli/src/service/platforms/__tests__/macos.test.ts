import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";

import {
  buildLaunchAgentPlist,
  createMacosController,
  isSmAppServiceLaunchAgentPath,
  parseLaunchctlPrintPath,
  readRegisteredCliInvocation,
  type ProcessRunner,
} from "../macos";
import { ProcessRunError, type RunResult } from "../../process-runner";
import { serviceLabelFor } from "../../label";
import { CLI_ERROR_CODES } from "../../../runner/errors";

const MOCKS = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  isProcessAlive: vi.fn(),
  cliLoggerWarn: vi.fn(),
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
      info: vi.fn(),
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

  beforeEach(() => {
    createdPlistPath = null;
    MOCKS.readHostPidMetadata.mockReset();
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    MOCKS.isProcessAlive.mockReset();
    MOCKS.isProcessAlive.mockReturnValue(false);
    MOCKS.cliLoggerWarn.mockReset();
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

    const stopping = controller.stop(label);
    await vi.advanceTimersByTimeAsync(300);

    await expect(stopping).resolves.toBeUndefined();
    expect(MOCKS.isProcessAlive).toHaveBeenCalledTimes(3);
  });

  it("rejects when a stopped host remains alive through the shutdown timeout", async () => {
    vi.useFakeTimers();
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);
    const runner: ProcessRunner = async () => buildSuccessResult();
    const controller = createMacosController(runner);

    const stopping = controller.stop(label);
    const result = expect(stopping).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: expect.stringContaining("stop did not take effect"),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();

    await result;
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
      parseLaunchctlPrintPath(
        `gui/501/ai.traycer.host = {\n\tpath = /Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist\n\tstate = running\n}\n`,
      ),
    ).toBe(
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.plist",
    );
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

    await expect(
      controller.install({
        label,
        cli: { command: "/usr/local/bin/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: expect.stringContaining(`${label.id}.agent`),
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

  it("stop/start/restart fail fast with a Desktop routing when the AGENT label is SMAppService-loaded, instead of signalling a job that doesn't exist", async () => {
    // On a migrated machine the host runs under `<label>.agent`; the CLI
    // label has no job. Without the guard, `stop` signals nothing, waits
    // out the full shutdown grace, and reports a misleading "stop did not
    // take effect"; `start`/`restart` surface raw kickstart errors.
    const smAgentPath =
      "/Applications/Traycer.app/Contents/Library/LaunchAgents/ai.traycer.host.agent.plist";
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "print" && args[1]?.endsWith(".agent") === true) {
        return { stdout: `path = ${smAgentPath}\n`, stderr: "", exitCode: 0 };
      }
      return buildSuccessResult();
    };
    const controller = createMacosController(runner);
    MOCKS.readHostPidMetadata.mockResolvedValue(HOST_PID_METADATA);
    MOCKS.isProcessAlive.mockReturnValue(true);

    for (const operation of [
      () => controller.stop(label),
      () => controller.start(label),
      () => controller.restart(label),
    ]) {
      calls.length = 0;
      await expect(operation()).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: expect.stringContaining(`${label.id}.agent`),
      });
      // Only the advisory probe ran - no kill/kickstart was ever issued
      // against either label.
      expect(calls.map((c) => c.args[0])).toEqual(["print"]);
    }
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
      [() => controller.stop(label), "kill"],
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
  });
});
