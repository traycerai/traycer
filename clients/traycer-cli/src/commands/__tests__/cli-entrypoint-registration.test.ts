import { describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { ProgressInfo } from "../../runner/output";
import type { CommandContext, CommandFn } from "../../runner/runner";

// Captures what `host download`'s wiring actually forwards down the real
// chain (index.ts's positional/`latest` normalization -> host-download.ts's
// `buildHostDownloadCommand` -> the installer) - a pure structural check on
// `buildProgram()`'s command tree (the rest of this file) can't catch a
// regression in that forwarding logic itself. `downloadAndStageHost` is the
// deepest real dependency in that chain, so mocking only it (not
// `host-download.ts`) keeps the normalization and `ctx.progress` wiring
// genuinely exercised.
const mocks = vi.hoisted(() => ({
  downloadCalls: [] as Array<{
    readonly environment: string;
    readonly versionRequest: string | null;
    readonly automatic: boolean;
  }>,
  applyCalls: [] as Array<{
    readonly environment: string;
    readonly force: boolean;
    readonly noService: boolean;
  }>,
  stampRuntimeCalls: [] as Array<{
    readonly environment: string;
    readonly expectedInstallGeneration: string;
    readonly observedPid: number;
    readonly observedStartedAt: string;
    readonly observedRuntimeVersion: string;
  }>,
  freePortKillCalls: [] as Array<{
    readonly pid: number;
    readonly port: number;
    readonly commandName: string;
  }>,
  progressEvents: [] as ProgressInfo[],
}));

vi.mock("../../installer/download-stage", () => ({
  downloadAndStageHost: async (opts: {
    readonly environment: string;
    readonly versionRequest: string | null;
    readonly automatic: boolean;
    readonly onProgress: (info: ProgressInfo) => void;
  }) => {
    mocks.downloadCalls.push({
      environment: opts.environment,
      versionRequest: opts.versionRequest,
      automatic: opts.automatic,
    });
    opts.onProgress({
      stage: "resolve",
      message: "test-progress",
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    return {
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      targetVersion: "1.0.0",
      installedVersion: "1.0.0",
      stagedVersion: null,
    };
  },
}));

// `host apply`'s registration also goes through `withCliLock` - mocking it
// alongside the installer core (rather than only `commands/host-apply.ts`)
// keeps the --force/--no-service forwarding and `ctx.progress` wiring
// genuinely exercised through the real lock-wrapping call site in
// `commands/host-apply.ts`, the same depth as the `host download` mock
// above.
vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> =>
      fn(),
  };
});

vi.mock("../../installer/apply", () => ({
  applyHost: async (opts: {
    readonly environment: string;
    readonly force: boolean;
    readonly noService: boolean;
    readonly onProgress: (info: ProgressInfo) => void;
  }) => {
    mocks.applyCalls.push({
      environment: opts.environment,
      force: opts.force,
      noService: opts.noService,
    });
    opts.onProgress({
      stage: "swap",
      message: "test-progress",
      percent: null,
      bytes: null,
      totalBytes: null,
    });
    return { outcome: "no-op", installedVersion: "1.0.0" };
  },
}));

vi.mock("../../host/free-port-kill", () => ({
  killConflictingPortOwner: async (opts: {
    readonly pid: number;
    readonly port: number;
    readonly commandName: string;
  }) => {
    mocks.freePortKillCalls.push({
      pid: opts.pid,
      port: opts.port,
      commandName: opts.commandName,
    });
    return { killed: true, killError: null };
  },
}));

vi.mock("../../host/stamp-runtime", () => ({
  stampRuntime: async (opts: {
    readonly environment: string;
    readonly expectedInstallGeneration: string;
    readonly observedPid: number;
    readonly observedStartedAt: string;
    readonly observedRuntimeVersion: string;
  }) => {
    mocks.stampRuntimeCalls.push({
      environment: opts.environment,
      expectedInstallGeneration: opts.expectedInstallGeneration,
      observedPid: opts.observedPid,
      observedStartedAt: opts.observedStartedAt,
      observedRuntimeVersion: opts.observedRuntimeVersion,
    });
    return {
      outcome: "stamped",
      runtimeVersion: "1.0.0",
      installGeneration: "id:test",
    };
  },
}));

// Replaces only `runCommand` (which owns `process.exit` - see
// `runner/runner.ts`) with a version that invokes the real `CommandFn` with
// a synthetic context and never exits, so `program.parseAsync(...)` can run
// the real command wiring to completion inside the test process.
vi.mock("../../runner/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/runner")>();
  return {
    ...actual,
    runCommand: async (fn: CommandFn) => {
      const ctx: CommandContext = {
        runtime: {
          json: false,
          quiet: false,
          noProgress: false,
          noBootstrap: false,
          nonInteractive: true,
          environment: "production",
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        },
        output: {
          progress: () => undefined,
          human: () => undefined,
          humanRequired: () => undefined,
          emitResult: () => undefined,
          emitError: () => undefined,
        },
        progress: (info) => mocks.progressEvents.push(info),
      };
      await fn(ctx);
    },
  };
});

import { buildProgram } from "../../index";

// Native-packaging follow-up bug: previously `traycer-cli/src/index.ts`
// only wired up `login`, `logout`, `whoami`, `host start`,
// `host status`, and the `config` tree - every other command module
// that Desktop's host-management IPC bridge spawns
// (`host doctor`, `host restart`, `host install`,
// `host update`, `host uninstall`, `host available`,
// `host logs`, `host free-port-and-restart`,
// `host service install`, `host service uninstall`, `cli upgrade`) was
// implemented but never registered, so `traycer host doctor --json`
// hit "unknown command" and Desktop's pending-CLI-upgrade flow had
// nothing to call.
//
// This file is a structural smoke test - it walks the commander tree
// `buildProgram()` produces and asserts every command the Desktop
// bridge depends on is reachable and accepts the shared runner flags
// (`--json`, `--environment`, `--no-progress`).

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

function expectCommand(program: Command, path: readonly string[]): Command {
  let cursor: Command = program;
  for (const segment of path) {
    const next = findSubcommand(cursor, segment);
    expect(
      next,
      `expected command '${path.join(" ")}' to be registered`,
    ).not.toBeNull();
    if (next === null) {
      throw new Error(`unreachable: command '${path.join(" ")}' not found`);
    }
    cursor = next;
  }
  return cursor;
}

function expectRunnerFlags(cmd: Command, label: string): void {
  const flags = cmd.options.map((o) => o.long);
  for (const expected of ["--json", "--no-progress"]) {
    expect(
      flags,
      `'${label}' is missing the shared runner flag '${expected}'`,
    ).toContain(expected);
  }
}

describe("traycer CLI entrypoint registration", () => {
  it("registers every command module the Desktop host-management IPC bridge spawns", () => {
    const program = buildProgram();
    // The set below matches the spawn call-sites in
    // `desktop/src/electron-main/ipc/host-management-ipc.ts` plus the
    // `cli upgrade` command that creates the `pendingUpgrade` state
    // Doctor surfaces.
    const required: ReadonlyArray<readonly string[]> = [
      ["host", "doctor"],
      ["host", "restart"],
      ["host", "install"],
      ["host", "ensure"],
      ["host", "apply"],
      ["host", "update"],
      ["host", "download"],
      ["host", "uninstall"],
      ["host", "available"],
      ["host", "logs"],
      ["host", "free-port-and-restart"],
      ["host", "service", "install"],
      ["host", "service", "uninstall"],
      ["cli", "upgrade"],
    ];
    for (const path of required) {
      expectCommand(program, path);
    }
  });

  it("threads --json / --no-progress through every runner-aware command", () => {
    // Long-running operations are invoked via streamTraycerCliJson and
    // depend on --json to switch the shared runner into NDJSON mode.
    // Short-lived ones invoked via runTraycerCliJson also need --json
    // so the unwrap helper can parse a terminal `result` envelope.
    const program = buildProgram();
    const runnerCommands: ReadonlyArray<readonly string[]> = [
      ["host", "doctor"],
      ["host", "restart"],
      ["host", "stop"],
      ["host", "install"],
      ["host", "ensure"],
      ["host", "apply"],
      ["host", "update"],
      ["host", "download"],
      ["host", "uninstall"],
      ["host", "available"],
      ["host", "logs"],
      ["host", "free-port-and-restart"],
      ["host", "service", "install"],
      ["host", "service", "status"],
      ["host", "service", "uninstall"],
      ["cli", "upgrade"],
      ["cli", "mark-source"],
      ["cli", "re-anchor"],
      // Migrated legacy-JSON commands (Native Packaging follow-up):
      // whoami + config read/list now route through the shared runner
      // and inherit `--json` / `--environment` / `--no-progress` via
      // `withRunner`. Adding them here guards against a future
      // refactor that silently re-introduces a `.action(...)` shim
      // and drops the runner flags.
      ["login"],
      ["whoami"],
      ["logout"],
      ["config", "shell", "get"],
      ["config", "shell", "list"],
      ["config", "shell", "set"],
      ["config", "shell", "reset"],
      ["config", "env", "list"],
      ["config", "env", "get"],
      ["config", "env", "set"],
      ["config", "env", "delete"],
    ];
    for (const path of runnerCommands) {
      const cmd = expectCommand(program, path);
      expectRunnerFlags(cmd, path.join(" "));
    }
  });

  it("login exposes --token so the Desktop can seed credentials post sign-in", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["login"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--token");
  });

  it("host install exposes --release, --from, and the bootstrap-flow options", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "install"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--release");
    expect(flags).toContain("--from");
    expect(flags).toContain("--allow-self-invocation");
    // commander stores --no-linger as the `--no-linger` long form.
    expect(flags).toContain("--no-linger");
    // Mirrors `host ensure`'s flag (Host Update Layer Redesign Tech
    // Plan) - the packaged-macOS pin path, where Desktop owns
    // registration via SMAppService.
    expect(flags).toContain("--no-service-register");
  });

  it("host install exposes a hidden --if-idle option, wired to the shared runner", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "install"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--if-idle");
    // `--if-idle` is the CLI-owned pin gate, not a user-facing switch -
    // hidden from help via `.hideHelp()`, but still reachable
    // (expectCommand above already proves it).
    expect(cmd.helpInformation()).not.toContain("--if-idle");
  });

  it("host ensure exposes --release, --from, and the bootstrap-flow options", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "ensure"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--release");
    expect(flags).toContain("--from");
    expect(flags).toContain("--allow-self-invocation");
    expect(flags).toContain("--no-linger");
    // Desktop installs bytes only and registers the macOS login item via
    // SMAppService itself.
    expect(flags).toContain("--no-service-register");
  });

  it("service lifecycle commands live under host service", () => {
    const program = buildProgram();
    expectCommand(program, ["host", "service", "install"]);
    expectCommand(program, ["host", "service", "status"]);
    expectCommand(program, ["host", "service", "uninstall"]);
    expect(findSubcommand(program, "service")).toBeNull();
  });

  it("host download exposes the [version] positional and a hidden --automatic option, wired to the shared runner", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "download"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--automatic");
    const help = cmd.helpInformation();
    // `--automatic` is the controller's internal contract (desktop
    // main's `stageLatest`), not a user-facing switch - hidden from
    // help via `.hideHelp()`, but still a real, reachable option (not a
    // hidden COMMAND, which `expectCommand` above already proves is
    // reachable regardless of help visibility).
    expect(help).not.toContain("--automatic");
    // The `[version]` positional stays visible - this is a user-facing
    // command with one internal-only flag, not a hidden command.
    expect(help).toContain("[version]");
    expectRunnerFlags(cmd, "host download");
  });

  it("host download parses and forwards a concrete positional, the literal 'latest' normalization, --automatic, and ctx.progress", async () => {
    mocks.downloadCalls.length = 0;
    mocks.progressEvents.length = 0;

    const explicit = buildProgram();
    explicit.exitOverride();
    await explicit.parseAsync(["host", "download", "1.5.0"], { from: "user" });

    const normalizedLatest = buildProgram();
    normalizedLatest.exitOverride();
    await normalizedLatest.parseAsync(["host", "download", "latest"], {
      from: "user",
    });

    const automatic = buildProgram();
    automatic.exitOverride();
    await automatic.parseAsync(["host", "download", "2.0.0", "--automatic"], {
      from: "user",
    });

    expect(mocks.downloadCalls).toEqual([
      { environment: "production", versionRequest: "1.5.0", automatic: false },
      // The literal "latest" positional collapses to `null` - the
      // CLI-wide contract for "resolve the manifest's latest pointer" -
      // rather than being forwarded to the installer as the literal
      // string "latest".
      { environment: "production", versionRequest: null, automatic: false },
      { environment: "production", versionRequest: "2.0.0", automatic: true },
    ]);
    // `ctx.progress` forwarding: the installer's `onProgress` call must
    // reach the runner's synthetic `ctx.progress` sink through
    // `host-download.ts`'s `(info) => ctx.progress(info)` bridge - one
    // event per invocation above.
    expect(mocks.progressEvents).toHaveLength(3);
    expect(mocks.progressEvents[0]).toMatchObject({ stage: "resolve" });
  });

  it("host apply exposes --force and a hidden --no-service option, wired to the shared runner", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "apply"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--force");
    expect(flags).toContain("--no-service");
    const help = cmd.helpInformation();
    // `--no-service` is the desktop-owned packaged-macOS contract, not a
    // user-facing switch - hidden from help via `.hideHelp()`, but still a
    // real, reachable option (expectCommand above already proves the
    // command itself is reachable regardless of help visibility).
    expect(help).not.toContain("--no-service");
    expectRunnerFlags(cmd, "host apply");
  });

  it("host apply forwards --force and --no-service, and bridges ctx.progress", async () => {
    mocks.applyCalls.length = 0;
    mocks.progressEvents.length = 0;

    const plain = buildProgram();
    plain.exitOverride();
    await plain.parseAsync(["host", "apply"], { from: "user" });

    const forced = buildProgram();
    forced.exitOverride();
    await forced.parseAsync(["host", "apply", "--force"], { from: "user" });

    const noService = buildProgram();
    noService.exitOverride();
    await noService.parseAsync(["host", "apply", "--no-service"], {
      from: "user",
    });

    expect(mocks.applyCalls).toEqual([
      { environment: "production", force: false, noService: false },
      { environment: "production", force: true, noService: false },
      { environment: "production", force: false, noService: true },
    ]);
    // `ctx.progress` forwarding through `host-apply.ts`'s
    // `(info) => ctx.progress(info)` bridge - one event per invocation.
    expect(mocks.progressEvents).toHaveLength(3);
    expect(mocks.progressEvents[0]).toMatchObject({ stage: "swap" });
  });

  it("host stamp-runtime is a hidden command exposing its four required flags", () => {
    const program = buildProgram();
    const host = expectCommand(program, ["host"]);
    const cmd = expectCommand(program, ["host", "stamp-runtime"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--expected-install-generation");
    expect(flags).toContain("--observed-pid");
    expect(flags).toContain("--observed-started-at");
    expect(flags).toContain("--observed-runtime-version");
    // Hidden from `host --help`'s command list entirely (not just a
    // hidden option on a visible command, per `.command(name, {hidden:
    // true})`) - `expectCommand` above already proves it's reachable.
    expect(host.helpInformation()).not.toContain("stamp-runtime");
  });

  it("host stamp-runtime parses --observed-pid and forwards all four values", async () => {
    mocks.stampRuntimeCalls.length = 0;

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(
      [
        "host",
        "stamp-runtime",
        "--expected-install-generation",
        "id:abc123",
        "--observed-pid",
        "4242",
        "--observed-started-at",
        "2026-01-01T00:05:00.000Z",
        "--observed-runtime-version",
        "2.0.0",
      ],
      { from: "user" },
    );

    expect(mocks.stampRuntimeCalls).toEqual([
      {
        environment: "production",
        expectedInstallGeneration: "id:abc123",
        observedPid: 4242,
        observedStartedAt: "2026-01-01T00:05:00.000Z",
        observedRuntimeVersion: "2.0.0",
      },
    ]);
  });

  it("host stamp-runtime rejects a non-integer --observed-pid with E_INVALID_ARGUMENT", async () => {
    mocks.stampRuntimeCalls.length = 0;

    const program = buildProgram();
    program.exitOverride();
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        [
          "host",
          "stamp-runtime",
          "--expected-install-generation",
          "id:abc123",
          "--observed-pid",
          "not-a-pid",
          "--observed-started-at",
          "2026-01-01T00:05:00.000Z",
          "--observed-runtime-version",
          "2.0.0",
        ],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
    expect(mocks.stampRuntimeCalls).toHaveLength(0);
  });

  // Finding 9 (ticket-2 review round 1): `Number.parseInt` tolerates a
  // leading-digit prefix and silently truncates/accepts values a real pid
  // never is - each of these previously passed `Number.isFinite` and
  // would have been forwarded as a plausible-looking pid.
  it.each([
    ["42junk", "a trailing non-digit suffix parseInt silently truncates"],
    ["42.9", "a decimal parseInt silently truncates to 42"],
    ["0", "pid 0 is never a real process"],
    ["-5", "a negative number is never a real pid"],
  ])(
    "host stamp-runtime rejects --observed-pid %j (%s) with E_INVALID_ARGUMENT",
    async (invalidPid) => {
      mocks.stampRuntimeCalls.length = 0;

      const program = buildProgram();
      program.exitOverride();
      let thrown: unknown = null;
      try {
        await program.parseAsync(
          [
            "host",
            "stamp-runtime",
            "--expected-install-generation",
            "id:abc123",
            "--observed-pid",
            invalidPid,
            "--observed-started-at",
            "2026-01-01T00:05:00.000Z",
            "--observed-runtime-version",
            "2.0.0",
          ],
          { from: "user" },
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
      expect(mocks.stampRuntimeCalls).toHaveLength(0);
    },
  );

  it("commander itself rejects host stamp-runtime when a required flag is missing", async () => {
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "stamp-runtime", "--observed-pid", "4242"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });

  it("host restart exposes a hidden --if-idle option, wired to the shared runner", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "restart"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--if-idle");
    // `--if-idle` is the CLI-owned activation mode (desktop controller's
    // idle-gated restart cycle), not a user-facing switch - hidden from
    // help via `.hideHelp()`, but still reachable (expectCommand above
    // already proves it).
    expect(cmd.helpInformation()).not.toContain("--if-idle");
    expectRunnerFlags(cmd, "host restart");
  });

  it("host available exposes --include-pre-releases for RC registry inspection", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "available"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--include-pre-releases");
  });

  it("cli upgrade is reachable so host doctor's CLI_UPGRADE_PENDING issue card has a fix command", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["cli", "upgrade"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--dry-run");
    expect(flags).toContain("--target");
  });

  it("hides internal agent hook commands from agent help", () => {
    const program = buildProgram();
    const agent = expectCommand(program, ["agent"]);
    const help = agent.helpInformation();
    expect(help).not.toContain("title-from-hook");
    expect(help).not.toContain("activity-from-hook");
    expect(help).not.toContain("turn-ended-from-hook");
    expect(help).not.toContain("session-observed-from-hook");
    expectCommand(program, ["agent", "title-from-hook"]);
    expectCommand(program, ["agent", "activity-from-hook"]);
    expectCommand(program, ["agent", "turn-ended-from-hook"]);
    expectCommand(program, ["agent", "session-observed-from-hook"]);
  });

  it("agent create exposes --name for a child agent display name", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["agent", "create"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--name");
  });

  it("limits readonly agent CLI help to inspection commands", () => {
    const originalSurface = process.env.TRAYCER_AGENT_CLI_SURFACE;
    process.env.TRAYCER_AGENT_CLI_SURFACE = "readonly";
    try {
      const program = buildProgram();
      const agent = expectCommand(program, ["agent"]);
      const help = agent.helpInformation();
      expect(help).toContain("list [options]");
      expect(help).toContain("transcript [options]");
      expect(help).not.toContain("create [options]");
      expect(help).not.toContain("selection-guide [options]");
      expect(help).not.toContain("list-harnesses [options]");
      expect(help).not.toContain("list-harness-models [options]");
      expect(help).not.toContain("send [options]");
      expect(help).not.toContain("inbox [options]");
      expect(program.helpInformation()).not.toContain("monitor [options]");
    } finally {
      if (originalSurface === undefined) {
        delete process.env.TRAYCER_AGENT_CLI_SURFACE;
      } else {
        process.env.TRAYCER_AGENT_CLI_SURFACE = originalSurface;
      }
    }
  });

  it("registers agent harness catalog commands with current harness help", () => {
    const program = buildProgram();
    const agent = expectCommand(program, ["agent"]);
    const create = expectCommand(program, ["agent", "create"]);
    const listHarnesses = expectCommand(program, ["agent", "list-harnesses"]);
    const listModels = expectCommand(program, ["agent", "list-harness-models"]);

    expect(create.helpInformation()).toContain("openrouter");
    expect(findSubcommand(agent, "list-harnesses")).toBe(listHarnesses);
    expect(listModels.helpInformation()).toContain("openrouter");
    expect(listModels.helpInformation()).toContain("<harness>");
  });

  it("host free-port-and-restart exposes --pid and --port so Doctor's free-port fix can be invoked", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "free-port-and-restart"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--pid");
    expect(flags).toContain("--port");
  });

  it("host free-port is a hidden command exposing required --pid and --port", () => {
    const program = buildProgram();
    const host = expectCommand(program, ["host"]);
    const cmd = expectCommand(program, ["host", "free-port"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--pid");
    expect(flags).toContain("--port");
    // Hidden from `host --help`'s command list entirely (not just a
    // hidden option on a visible command, per `.command(name, {hidden:
    // true})`) - `expectCommand` above already proves it's reachable.
    expect(host.helpInformation()).not.toContain("free-port ");
  });

  it("host free-port parses --pid/--port and forwards both as integers, kill-only (no restart)", async () => {
    mocks.freePortKillCalls.length = 0;

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(
      ["host", "free-port", "--pid", "4242", "--port", "51820"],
      { from: "user" },
    );

    expect(mocks.freePortKillCalls).toEqual([
      { pid: 4242, port: 51820, commandName: "host free-port" },
    ]);
  });

  it("host free-port rejects a non-integer --pid/--port with E_INVALID_ARGUMENT", async () => {
    mocks.freePortKillCalls.length = 0;

    const program = buildProgram();
    program.exitOverride();
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "free-port", "--pid", "not-a-pid", "--port", "51820"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
    expect(mocks.freePortKillCalls).toHaveLength(0);
  });

  it("commander itself rejects host free-port when --port is missing", async () => {
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    let thrown: unknown = null;
    try {
      await program.parseAsync(["host", "free-port", "--pid", "4242"], {
        from: "user",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });

  // Same defect class as F9 (`host stamp-runtime --observed-pid`, above):
  // `Number.parseInt` tolerates a leading-digit prefix and silently
  // truncates/accepts values a real pid never is.
  it.each([
    ["42junk", "a trailing non-digit suffix parseInt silently truncates"],
    ["42.9", "a decimal parseInt silently truncates to 42"],
    ["0", "pid 0 is never a real process"],
    ["-5", "a negative number is never a real pid"],
  ])(
    "host free-port rejects --pid %j (%s) with E_INVALID_ARGUMENT",
    async (invalidPid) => {
      mocks.freePortKillCalls.length = 0;

      const program = buildProgram();
      program.exitOverride();
      let thrown: unknown = null;
      try {
        await program.parseAsync(
          ["host", "free-port", "--pid", invalidPid, "--port", "51820"],
          { from: "user" },
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
      expect(mocks.freePortKillCalls).toHaveLength(0);
    },
  );

  // Same defect class, plus the port-range bound: an out-of-range port
  // silently coerced into a plausible-looking integer is exactly the
  // "target the wrong process" failure this class of bug produces.
  it.each([
    ["42junk", "a trailing non-digit suffix parseInt silently truncates"],
    ["70000", "a port above 65535 is never a real TCP/UDP port"],
    ["0", "port 0 is never a real listening port"],
    ["-5", "a negative number is never a real port"],
  ])(
    "host free-port rejects --port %j (%s) with E_INVALID_ARGUMENT",
    async (invalidPort) => {
      mocks.freePortKillCalls.length = 0;

      const program = buildProgram();
      program.exitOverride();
      let thrown: unknown = null;
      try {
        await program.parseAsync(
          ["host", "free-port", "--pid", "4242", "--port", invalidPort],
          { from: "user" },
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
      expect(mocks.freePortKillCalls).toHaveLength(0);
    },
  );

  it("host free-port-and-restart rejects an explicitly invalid --pid with E_INVALID_ARGUMENT, never silently downgrading to restart-only", async () => {
    const program = buildProgram();
    program.exitOverride();
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "free-port-and-restart", "--pid", "42junk", "--port", "51820"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });

  it("host free-port-and-restart rejects an out-of-range --port with E_INVALID_ARGUMENT", async () => {
    const program = buildProgram();
    program.exitOverride();
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "free-port-and-restart", "--pid", "4242", "--port", "70000"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });

  it.each([
    ["42junk", "a trailing non-digit suffix parseInt silently truncates"],
    ["42.9", "a decimal parseInt silently truncates to 42"],
    ["0", "zero trailing lines is not a valid tail count"],
    ["-5", "a negative line count is never valid"],
  ])(
    "host logs rejects --tail %j (%s) with E_INVALID_ARGUMENT",
    async (invalidTail) => {
      const program = buildProgram();
      program.exitOverride();
      let thrown: unknown = null;
      try {
        await program.parseAsync(["host", "logs", "--tail", invalidTail], {
          from: "user",
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
    },
  );

  it("cli finalize-upgrade is a hidden, internal-only command reachable from the CLI namespace", () => {
    // Structural check only - unlike the other hidden commands in this
    // file, `cli finalize-upgrade` genuinely touches the manifest/lock
    // on invocation (via `commands/cli-upgrade.ts`'s real
    // `finalizePendingCliUpgrade`, unmocked here), so it isn't invoked
    // via parseAsync in this file. Its behavior is covered by
    // commands/__tests__/cli-finalize-upgrade.test.ts (mocked) and
    // cli-finalize-upgrade-lock.test.ts (genuine two-process lock
    // contention).
    const program = buildProgram();
    const cli = expectCommand(program, ["cli"]);
    expectCommand(program, ["cli", "finalize-upgrade"]);
    expect(cli.helpInformation()).not.toContain("finalize-upgrade");
  });

  // Service manifests render argv as `traycer host start` - the slot is
  // `config.environment` (baked per build), so there is no --environment. These
  // tests pin that `host start` declares only --cwd and rejects the retired
  // dev-override flags.
  it("host start declares --cwd; --environment / --bundle / --node-bin are intentionally absent", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "start"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--cwd");
    // No --environment: the host slot is config.environment, baked per build.
    // The dev-compat overrides (--bundle/--node-bin) were also retired; pin
    // their absence so a regression doesn't reintroduce a runtime dev/prod
    // branch.
    expect(flags).not.toContain("--environment");
    expect(flags).not.toContain("--bundle");
    expect(flags).not.toContain("--node-bin");
  });

  it("commander rejects `host start --bundle <path>` because the dev-override flag was retired", async () => {
    const program = buildProgram();
    program.exitOverride();
    // Silence commander's default stderr writer so test output stays clean
    // while still letting the parse throw on the unknown option.
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    const start = expectCommand(program, ["host", "start"]);
    let actionFired = false;
    start.action(() => {
      actionFired = true;
    });
    let thrown: unknown = null;
    try {
      await program.parseAsync(["host", "start", "--bundle", "/tmp/main.mjs"], {
        from: "user",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(actionFired).toBe(false);
  });

  it("commander rejects `host start --environment <ch>` because the environment flag was retired", async () => {
    const program = buildProgram();
    program.exitOverride();
    const start = expectCommand(program, ["host", "start"]);
    start.action(() => {
      // Should never fire - parse must throw on the now-unknown option.
    });
    let thrown: unknown = null;
    try {
      await program.parseAsync(["host", "start", "--environment", "dev"], {
        from: "user",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
  });
});
