import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import {
  resolveHostStartTarget,
  runHostStart,
  type HostStartTarget,
  type RunHostStartDeps,
} from "../host-start";
import type { HostInstallRecord } from "../../manifest/host-install";
import { noopLogger } from "../../logger";
import { hostHomeDir } from "../../store/paths";
import { withDevDesktopSlotAsync as withDevDesktopSlot } from "@traycer-clients/shared/test-fixtures/dev-desktop-slot";

// `traycer host start --environment <ch>` is the single supervisor entry
// point. There is one launch path: read the environment's
// HostInstallRecord, refuse to spawn with stable machine-readable
// codes when the record is missing / the executable is gone, and
// otherwise spawn `record.executablePath` directly. The dev orchestrator
// (`make dev-desktop`) stages a tiny wrapper script as the executable
// so the same code path covers SEA-installed prod hosts and node-
// bundled dev hosts - see `scripts/dev-desktop.js::stageHostDevRuntime`.

function sampleRecord(executablePath: string): HostInstallRecord {
  return {
    installId: null,
    version: "1.0.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-05-15T00:00:00.000Z",
    source: { kind: "registry", value: "1.0.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-05-15T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

describe("resolveHostStartTarget", () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "traycer-host-start-target-"));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("returns the install record's executablePath as the spawn target", async () => {
    const execPath = join(work, "traycer-host");
    writeFileSync(execPath, "#!/bin/sh\nexit 0\n");
    const target = await resolveHostStartTarget(
      { environment: "production", cwd: null },
      {
        readInstallRecord: async () => sampleRecord(execPath),
        pathExists: (p) => Promise.resolve(p === execPath),
      },
    );
    expect(target.executable).toBe(execPath);
    // Passes the resolved slot dir so a host baked for a different slot still
    // publishes pid.json where this environment expects it.
    expect(target.args).toEqual(["--host-data-dir", hostHomeDir("production")]);
    expect(target.cwd).toBe(work);
    expect(target.record.version).toBe("1.0.0");
  });

  it("throws HOST_NOT_INSTALLED with the environment when no record exists", async () => {
    let thrown: unknown;
    try {
      await resolveHostStartTarget(
        { environment: "dev", cwd: null },
        {
          readInstallRecord: async () => null,
          pathExists: () => Promise.resolve(false),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(CLI_ERROR_CODES.HOST_NOT_INSTALLED);
    expect(err.details).toMatchObject({ environment: "dev" });
    // exitCode must be stable so the service manager can branch on it.
    expect(err.exitCode).toBe(69);
  });

  it("throws HOST_NOT_INSTALLED when the record's executablePath does not exist on disk", async () => {
    let thrown: unknown;
    try {
      await resolveHostStartTarget(
        { environment: "production", cwd: null },
        {
          readInstallRecord: async () => sampleRecord(join(work, "nope")),
          pathExists: () => Promise.resolve(false),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(CLI_ERROR_CODES.HOST_NOT_INSTALLED);
    expect(err.details).toMatchObject({
      environment: "production",
      version: "1.0.0",
    });
  });

  it("throws HOST_INSTALL_RECORD_INVALID when executablePath is empty", async () => {
    let thrown: unknown;
    try {
      await resolveHostStartTarget(
        { environment: "production", cwd: null },
        {
          readInstallRecord: async () => sampleRecord(""),
          pathExists: () => Promise.resolve(true),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).code).toBe(
      CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    );
  });
});

// --------------------------------- runHostStart full-flow tests

interface StubChild extends EventEmitter {
  pid: number | undefined;
  kill: (signal: NodeJS.Signals) => boolean;
}

function makeStubChild(): StubChild {
  const emitter = new EventEmitter() as StubChild;
  emitter.pid = 4242;
  emitter.kill = () => true;
  return emitter;
}

interface Recorded {
  readonly markers: Array<{
    readonly environment: string;
    readonly phase: string;
    readonly fields: Record<string, unknown>;
  }>;
  readonly errors: string[];
  exited: number | null;
  readonly exitWaiters: Array<() => void>;
  // Log rotations attempted, in order. Stubbed (not left to the real helper) so
  // a test run can never rotate the developer's actual ~/.traycer host log.
  readonly rotations: string[];
  // Ordered trace of the start lifecycle: rotate -> marker -> open fd -> spawn.
  // The ORDER is the invariant (see the ordering test), not just the calls.
  readonly sequence: string[];
  readonly spawnCalls: Array<{
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    env: Record<string, string | undefined>;
    stdio: unknown;
    windowsHide: boolean | undefined;
  }>;
}

interface RunStubs {
  readonly child: StubChild;
  readonly recorded: Recorded;
  readonly deps: Partial<RunHostStartDeps>;
}

function makeRunStubs(
  installRecord: HostInstallRecord | null,
  existsOverride: ((path: string) => boolean) | null,
): RunStubs {
  const child = makeStubChild();
  const recorded: Recorded = {
    markers: [],
    errors: [],
    exited: null,
    exitWaiters: [],
    spawnCalls: [],
    rotations: [],
    sequence: [],
  };
  // The stub implements only the surface `runHostStart` touches; route it
  // to `ChildProcess` through an explicit `unknown` intermediate rather than a
  // chained `as unknown as` assertion.
  const childAsUnknown: unknown = child;
  const childAsProcess: ChildProcess = childAsUnknown as ChildProcess;
  const deps: Partial<RunHostStartDeps> = {
    // `runHostStart` falls back to the REAL `createCliLogger` (writing to
    // the actual production `~/.traycer/cli/cli.log`) via `deps.logger ??
    // createCliLogger(...)` whenever this is left unset - `??` treats
    // `undefined` as nullish just like a missing key, so it must be
    // supplied explicitly here, not left to the `Partial` default.
    logger: noopLogger,
    readInstallRecord: async () => installRecord,
    pathExists: async (p: string) =>
      (existsOverride ?? ((q: string) => q === installRecord?.executablePath))(
        p,
      ),
    spawn: (command, args, options) => {
      recorded.sequence.push("spawn");
      recorded.spawnCalls.push({
        command,
        args,
        cwd: typeof options.cwd === "string" ? options.cwd : undefined,
        env: (options.env ?? {}) as Record<string, string | undefined>,
        stdio: options.stdio,
        windowsHide: options.windowsHide,
      });
      return childAsProcess;
    },
    openLogFd: async () => {
      recorded.sequence.push("open-fd");
      return 42;
    },
    rotateLog: async (environment) => {
      recorded.rotations.push(environment);
      recorded.sequence.push("rotate");
      return "skipped";
    },
    readEnvOverrides: async () => ({
      EXTRA_FROM_OVERRIDE: "1",
      TRAYCER_TEST_UNSET: null,
    }),
    writeMarker: async (environment, phase, fields) => {
      recorded.sequence.push(`marker:${phase}`);
      recorded.markers.push({
        environment,
        phase,
        fields: { ...fields } as Record<string, unknown>,
      });
    },
    // The real supervisor calls process.exit which never returns. In
    // tests we record the requested code and resolve any pending waiter
    // so event-handler-driven exit paths surface to the test runner
    // without an uncaught throw.
    exit: (code) => {
      recorded.exited = code;
      while (recorded.exitWaiters.length > 0) {
        const waiter = recorded.exitWaiters.shift();
        if (waiter !== undefined) waiter();
      }
    },
    onError: (msg) => {
      recorded.errors.push(msg);
    },
  };
  return { child, recorded, deps };
}

async function runUntilExit(
  invoke: () => Promise<void>,
  recorded: Recorded,
): Promise<void> {
  await invoke();
  if (recorded.exited === null) {
    // Wait for an async event-handler-driven exit (child 'exit'). The
    // stub `exit` resolves any pending waiter when called.
    await new Promise<void>((resolve) => {
      recorded.exitWaiters.push(resolve);
    });
  }
  expect(recorded.exited).not.toBeNull();
}

describe("runHostStart - installed-record launch path", () => {
  it("spawns record.executablePath directly with no shell wrapping and the environment env exported", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const previousUnsetValue = process.env.TRAYCER_TEST_UNSET;
    process.env.TRAYCER_TEST_UNSET = "inherited";

    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);

    // The supervisor only returns when the child exits - emit `exit 0`
    // after a microtask so the spawn call has been recorded.
    setTimeout(() => child.emit("exit", 0, null));
    try {
      await runUntilExit(invoke, recorded);
    } finally {
      if (previousUnsetValue === undefined) {
        delete process.env.TRAYCER_TEST_UNSET;
      } else {
        process.env.TRAYCER_TEST_UNSET = previousUnsetValue;
      }
    }

    expect(recorded.spawnCalls).toHaveLength(1);
    const call = recorded.spawnCalls[0];
    expect(call?.command).toBe(exec);
    // The supervisor passes the slot dir as `--host-data-dir` (NOT an
    // `--environment` arg or env): path-only, so the host writes pid.json in
    // this environment's slot while its cloud target stays baked.
    expect(call?.args).toEqual(["--host-data-dir", hostHomeDir("production")]);
    expect(call?.env.TRAYCER_CHANNEL).toBeUndefined();
    expect(call?.env.EXTRA_FROM_OVERRIDE).toBe("1");
    expect(call?.env.TRAYCER_TEST_UNSET).toBeUndefined();
    expect(call?.env.TERM_PROGRAM).toBe("traycer");
    expect(call?.windowsHide).toBe(process.platform === "win32");
    // Production launch must NOT route through a shell - the spawn
    // command must be the executable itself.
    expect(call?.command.endsWith("/sh")).toBe(false);
    expect(call?.command).not.toContain("zsh");

    // Bootstrap markers: starting → exited (exit code 0).
    const phases = recorded.markers.map((m) => m.phase);
    expect(phases[0]).toBe("starting");
    expect(phases[phases.length - 1]).toBe("exited");
    // Marker is written under the requested environment.
    expect(recorded.markers[0]?.environment).toBe("production");
    expect(recorded.exited).toBe(0);
  });

  it("writes bootstrap markers under the dev environment and passes no environment arg", async () => {
    const exec = "/opt/traycer/host/dev/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () => runHostStart({ environment: "dev", cwd: null }, deps);
    setTimeout(() => child.emit("exit", 0, null));
    await runUntilExit(invoke, recorded);
    expect(recorded.markers.every((m) => m.environment === "dev")).toBe(true);
    expect(recorded.spawnCalls[0]?.args).toEqual([
      "--host-data-dir",
      hostHomeDir("dev"),
    ]);
    expect(recorded.spawnCalls[0]?.env.TRAYCER_CHANNEL).toBeUndefined();
  });

  it("rotates the log for this environment before anything appends to the run", async () => {
    const exec = "/opt/traycer/host/dev/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () => runHostStart({ environment: "dev", cwd: null }, deps);
    setTimeout(() => child.emit("exit", 0, null));
    await runUntilExit(invoke, recorded);

    expect(recorded.rotations).toEqual(["dev"]);
    // Ordering is load-bearing, not incidental, so assert the actual SEQUENCE
    // rather than just that each step ran. The `starting` marker must land in
    // the POST-rotation file, and the stdio fd opened after it lives for the
    // child's whole lifetime - an fd follows the inode across a rename, so
    // rotating any later would divert the host's own stdout into the
    // rotated-away file and split one session across two inodes.
    // Prefix, not the whole trace: the child's own exit appends `marker:exited`
    // afterwards, which is not part of the start sequence under test.
    expect(recorded.sequence.slice(0, 4)).toEqual([
      "rotate",
      "marker:starting",
      "open-fd",
      "spawn",
    ]);
  });

  it("passes the dev-desktop run host root to the host when a slot is set", async () => {
    await withDevDesktopSlot("Worktree Slot", async () => {
      const exec = "/opt/traycer/host/dev/install/traycer-host";
      const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
      const invoke = () =>
        runHostStart({ environment: "dev", cwd: null }, deps);
      setTimeout(() => child.emit("exit", 0, null));
      await runUntilExit(invoke, recorded);
      expect(recorded.spawnCalls[0]?.args).toEqual([
        "--host-data-dir",
        hostHomeDir("dev"),
      ]);
      expect(hostHomeDir("dev")).toMatch(
        /[\\/]\.traycer[\\/]host[\\/]dev-runs[\\/]worktree-slot$/,
      );
    });
  });

  it("dev wrapper-script executablePath spawns through the same code path", async () => {
    // The dev orchestrator stages a small POSIX wrapper at
    // `~/.traycer/host/dev/runtime/traycer-host` that internally
    // exec's `node <bundle>`. The supervisor sees only the wrapper
    // path - it does NOT branch on bundle / node-bin args anymore.
    const wrapper = "/Users/dev/.traycer/host/dev/runtime/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(wrapper), null);
    const invoke = () => runHostStart({ environment: "dev", cwd: null }, deps);
    setTimeout(() => child.emit("exit", 0, null));
    await runUntilExit(invoke, recorded);
    expect(recorded.spawnCalls).toHaveLength(1);
    expect(recorded.spawnCalls[0]?.command).toBe(wrapper);
    expect(recorded.spawnCalls[0]?.args).toEqual([
      "--host-data-dir",
      hostHomeDir("dev"),
    ]);
  });
});

describe("runHostStart - error surfaces", () => {
  it("missing install record: writes failed-to-spawn marker and exits with HOST_NOT_INSTALLED", async () => {
    const { recorded, deps } = makeRunStubs(null, null);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    await runUntilExit(invoke, recorded);
    expect(recorded.spawnCalls).toHaveLength(0);
    expect(recorded.exited).toBe(69);
    const errLine = recorded.errors.join("\n");
    expect(errLine).toContain(CLI_ERROR_CODES.HOST_NOT_INSTALLED);
    // Marker carries the structured code so `host status` can surface
    // the failure on a fresh machine where the supervisor never spun up.
    const failedMarker = recorded.markers.find(
      (m) => m.phase === "failed-to-spawn",
    );
    expect(failedMarker).toBeDefined();
    expect(failedMarker?.fields.error).toContain(
      CLI_ERROR_CODES.HOST_NOT_INSTALLED,
    );
  });

  it("install record present but executable missing: exits with HOST_NOT_INSTALLED carrying the bad path", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), () => false);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(69);
    expect(recorded.errors.join("\n")).toContain(exec);
  });

  it("install record with empty executablePath: exits with HOST_INSTALL_RECORD_INVALID", async () => {
    const { recorded, deps } = makeRunStubs(sampleRecord(""), null);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(1);
    expect(recorded.errors.join("\n")).toContain(
      CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
    );
  });
});

describe("runHostStart - signal/exit propagation", () => {
  it("translates a SIGTERM-killed child into exit code 128+15", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    setTimeout(() => child.emit("exit", null, "SIGTERM"));
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(143);
    const killed = recorded.markers.find((m) => m.phase === "killed");
    expect(killed?.fields.signal).toBe("SIGTERM");
  });

  it("propagates a non-zero exit code as a `crashed` marker", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { child, recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, deps);
    setTimeout(() => child.emit("exit", 7, null));
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(7);
    const crashed = recorded.markers.find((m) => m.phase === "crashed");
    expect(crashed?.fields.exitCode).toBe(7);
  });

  it("spawn() throw is translated into HOST_SPAWN_FAILED + exit 66", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const { recorded, deps } = makeRunStubs(sampleRecord(exec), null);
    const failingSpawn: Partial<RunHostStartDeps> = {
      ...deps,
      spawn: () => {
        throw new Error("ENOENT exec missing");
      },
    };
    const invoke = () =>
      runHostStart({ environment: "production", cwd: null }, failingSpawn);
    await runUntilExit(invoke, recorded);
    expect(recorded.exited).toBe(66);
    expect(recorded.errors.join("\n")).toContain(
      CLI_ERROR_CODES.HOST_SPAWN_FAILED,
    );
  });
});

describe("HostStartTarget", () => {
  it("returns the --host-data-dir slot arg and the install record on the only supported path", async () => {
    const exec = "/opt/traycer/host/install/traycer-host";
    const target: HostStartTarget = await resolveHostStartTarget(
      { environment: "production", cwd: null },
      {
        readInstallRecord: async () => sampleRecord(exec),
        pathExists: () => Promise.resolve(true),
      },
    );
    expect(target.args).toEqual(["--host-data-dir", hostHomeDir("production")]);
    expect(target.record.version).toBe("1.0.0");
  });
});

// --------------------------------- service manifest sanity tests

describe("service manifests invoke `host start` (slot from config.environment) without --bundle/--environment", () => {
  it("macOS plist ProgramArguments end with `host start` and no --environment", async () => {
    const { buildLaunchAgentPlist } =
      await import("../../service/platforms/macos");
    const xml = buildLaunchAgentPlist({
      label: {
        id: "ai.traycer.host.prod",
        displayName: "Traycer Host",
        environment: "production",
      } as never,
      cli: {
        command: "/Users/test/.traycer/cli/bin/traycer",
        args: [],
      },
    });
    expect(xml).toContain("<string>host</string>");
    expect(xml).toContain("<string>start</string>");
    // No --environment - the CLI/host resolve the slot from config.environment.
    expect(xml).not.toContain("--environment");
    // The --bundle / --node-bin flags no longer exist on `host start`,
    // but pin them not appearing in service manifests anyway so a future
    // regression that reintroduces them is caught at the manifest layer.
    expect(xml).not.toContain("--bundle");
    expect(xml).not.toContain("--node-bin");
  });

  it("systemd unit ExecStart contains `host start` without --environment/--bundle", async () => {
    const { buildSystemdUnit } = await import("../../service/platforms/linux");
    const unit = buildSystemdUnit({
      label: {
        id: "ai.traycer.host.dev",
        displayName: "Traycer Host (dev)",
        environment: "dev",
      } as never,
      cli: {
        command: "/home/test/.traycer/cli/bin/traycer",
        args: [],
      },
    });
    expect(unit).toContain("host");
    expect(unit).toContain("start");
    expect(unit).not.toContain("--environment");
    expect(unit).not.toContain("--bundle");
    expect(unit).not.toContain("--node-bin");
  });

  it("Windows scheduled task XML invokes the hidden launcher, which runs `host start` without --environment/--bundle", async () => {
    const { buildScheduledTaskXml, buildWindowsHiddenHostLauncher } =
      await import("../../service/platforms/windows");
    const prevUsername = process.env.USERNAME;
    process.env.USERNAME = "testuser";
    const restoreUsername = () => {
      if (prevUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = prevUsername;
    };
    try {
      const cli = {
        command: "C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe",
        args: [],
      };
      const xml = buildScheduledTaskXml({
        label: {
          id: "ai.traycer.host.prod",
          displayName: "Traycer Host",
          environment: "production",
          devSlot: null,
        },
        cli,
      });
      const launcher = buildWindowsHiddenHostLauncher(cli);
      expect(xml).toContain("<Hidden>true</Hidden>");
      expect(xml).toContain("wscript.exe");
      expect(xml).toContain("host-start-hidden.vbs");
      expect(xml).not.toContain(
        "<Command>C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe</Command>",
      );
      expect(launcher).toContain('Set shell = CreateObject("WScript.Shell")');
      expect(launcher).toContain("shell.Run");
      expect(launcher).toContain(", 0, True)");
      expect(launcher).toContain(
        "C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe",
      );
      expect(launcher).toContain("host");
      expect(launcher).toContain("start");
      expect(`${xml}\n${launcher}`).not.toContain("--environment");
      expect(`${xml}\n${launcher}`).not.toContain("--bundle");
      expect(`${xml}\n${launcher}`).not.toContain("--node-bin");
    } finally {
      restoreUsername();
    }
  });
});
