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

import { createMacosController, type ProcessRunner } from "../macos";
import { ProcessRunError, type RunResult } from "../../process-runner";
import { serviceLabelFor } from "../../label";
import { CLI_ERROR_CODES } from "../../../runner/errors";

const MOCKS = vi.hoisted(() => ({
  readHostPidMetadata: vi.fn(),
  isProcessAlive: vi.fn(),
}));

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

  beforeEach(() => {
    createdPlistPath = null;
    MOCKS.readHostPidMetadata.mockReset();
    MOCKS.readHostPidMetadata.mockResolvedValue(null);
    MOCKS.isProcessAlive.mockReset();
    MOCKS.isProcessAlive.mockReturnValue(false);
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
    // Print probe + bootout attempted; bootstrap/kickstart never run.
    expect(calls.map((c) => c.args[0])).toEqual(["print", "bootout"]);
  });

  it("still tolerates 'service already loaded' on bootstrap (defence-in-depth for races against bootout)", async () => {
    const calls: RecordedCall[] = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "bootstrap") {
        // Another process re-bootstrapped between our bootout and our
        // bootstrap - fall through to kickstart against whatever's now
        // loaded.
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
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
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
});
