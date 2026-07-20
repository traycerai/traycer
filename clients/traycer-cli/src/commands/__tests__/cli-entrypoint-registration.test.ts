import { describe, expect, it } from "vitest";
import type { Command } from "commander";
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
      ["host", "update"],
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
      ["host", "update"],
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

  it("host update exposes --version and --force", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "update"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--version");
    expect(flags).toContain("--force");
  });

  // Regression pin for the Commander quirk this ticket had to work around:
  // by default, a root-level `program.version(...)` greedily claims ANY
  // `--version` token anywhere in argv (even one meant for a deeply-nested
  // subcommand's own `--version <value>` option), because Commander scans
  // the full argv for options it recognizes rather than stopping at the
  // first subcommand boundary. The host daemon spawns `host update` as
  // exactly `traycer host update --version <v> [--force]` (fixed contract,
  // not ours to change) - without `program.enablePositionalOptions()` in
  // `buildProgram()`, that invocation would silently print the CLI's own
  // version and exit 0 instead of running the update.
  it("`host update --version <v> --force` reaches host update's own action instead of printing the root CLI version", async () => {
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    const update = expectCommand(program, ["host", "update"]);
    let capturedOpts: Record<string, unknown> | null = null;
    update.action((opts: Record<string, unknown>) => {
      capturedOpts = opts;
    });
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "update", "--version", "1.4.2", "--force"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();
    expect(capturedOpts).toMatchObject({ version: "1.4.2", force: true });
  });

  it("top-level `traycer --version` still prints the CLI's own version (unaffected by enablePositionalOptions)", async () => {
    const program = buildProgram();
    program.exitOverride();
    let printed = "";
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: (str: string) => {
        printed += str;
      },
    });
    let thrown: unknown = null;
    try {
      await program.parseAsync(["--version"], { from: "user" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(printed.trim().length).toBeGreaterThan(0);
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
