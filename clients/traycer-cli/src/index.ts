#!/usr/bin/env -S bun
import "./sentry";
import * as Sentry from "@sentry/node";
import {
  Command,
  CommanderError,
  type Command as CommanderCommand,
} from "commander";
import { AGENT_FACING_HARNESS_ID_LIST } from "@traycer/protocol/host/agent/shared";
import { config } from "./config";
import { buildCliMarkSourceCommand } from "./commands/cli-mark-source";
import { buildCliReAnchorCommand } from "./commands/cli-re-anchor";
import { buildCliUpgradeCommand } from "./commands/cli-upgrade";
import { buildAgentCreateCommand } from "./commands/agent-create";
import { buildAgentActivityFromHookCommand } from "./commands/agent-activity-from-hook";
import { buildAgentListHarnessesCommand } from "./commands/agent-list-harnesses";
import { buildAgentListHarnessModelsCommand } from "./commands/agent-list-harness-models";
import { buildAgentListCommand } from "./commands/agent-list";
import { buildAgentSelectionGuideCommand } from "./commands/agent-selection-guide";
import { buildAgentSendCommand } from "./commands/agent-send";
import { buildAgentTitleFromHookCommand } from "./commands/agent-title-from-hook";
import { buildAgentTurnEndedFromHookCommand } from "./commands/agent-turn-ended-from-hook";
import { buildAgentTranscriptCommand } from "./commands/agent-transcript";
import { buildAgentInboxCommand } from "./commands/agent-inbox";
import { buildWorkspaceListCommand } from "./commands/workspace-list";
import { buildWorktreeCreateCommand } from "./commands/worktree-create";
import {
  buildCommentsListCommand,
  buildCommentsSetStatusCommand,
} from "./commands/comments";
import { runMonitor } from "./commands/monitor";
import { buildConfigEnvDeleteCommand } from "./commands/config-env-delete";
import { buildConfigEnvGetCommand } from "./commands/config-env-get";
import { buildConfigEnvListCommand } from "./commands/config-env-list";
import { buildConfigEnvSetCommand } from "./commands/config-env-set";
import { buildConfigEnvUnsetCommand } from "./commands/config-env-unset";
import { configShellGetCommand } from "./commands/config-shell-get";
import { configShellListCommand } from "./commands/config-shell-list";
import { configShellResetCommand } from "./commands/config-shell-reset";
import { buildConfigShellSetCommand } from "./commands/config-shell-set";
import { buildHostAvailableCommand } from "./commands/host-available";
import { hostDoctorCommand } from "./commands/host-doctor";
import { buildHostEnsureCommand } from "./commands/host-ensure";
import { buildHostFreePortAndRestartCommand } from "./commands/host-free-port-and-restart";
import { buildHostInstallCommand } from "./commands/host-install";
import { buildHostLogsCommand } from "./commands/host-logs";
import { hostRestartCommand } from "./commands/host-restart";
import { runHostStart } from "./commands/host-start";
import { hostStatusCommand } from "./commands/host-status";
import { hostStopCommand } from "./commands/host-stop";
import { buildHostUninstallCommand } from "./commands/host-uninstall";
import { buildHostUpdateCommand } from "./commands/host-update";
import { buildLoginCommand } from "./commands/login";
import { logoutCommand } from "./commands/logout";
import { buildServiceInstallCommand } from "./commands/service-install";
import { serviceStatusCommand } from "./commands/service-status";
import { serviceUninstallCommand } from "./commands/service-uninstall";
import { whoamiCommand } from "./commands/whoami";
import { CLI_ERROR_CODES, cliError } from "./runner/errors";
import { createCliLogger, errorFromUnknown, type ILogger } from "./logger";
import { addRunnerFlags, extractRunnerFlags } from "./runner/commander-flags";
import { runCommand, type CommandFn } from "./runner/runner";
import { readonlyEnv } from "./runner/runtime";

// Helper: register a runner-aware action handler. The runner owns
// process.exit, so anything composed via `withRunner` participates in
// the shared NDJSON envelope (--json) and global flag handling
// (--quiet, --no-progress, --no-bootstrap).
//
// Commander hands action handlers `(...positionalArgs, options, command)`
// - one entry per declared `.argument(...)` (with `undefined` for an
// optional positional that wasn't supplied), then the local opts bag,
// then the Command. We strip the trailing two and forward the rest as
// the typed positional slice. Optional positionals stay as their
// original `undefined`/string token so call sites can guard with
// `typeof args[i] === "string"` instead of distinguishing
// "missing" from "empty".
export function extractActionPositionals(
  actionArgs: ReadonlyArray<unknown>,
): ReadonlyArray<string | undefined> {
  if (actionArgs.length < 2) return [];
  const positional = actionArgs.slice(0, -2);
  return positional.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry)) {
      return entry.map((value) =>
        typeof value === "string" ? value : undefined,
      );
    }
    return [undefined];
  });
}

function expectRequiredPositional(
  value: string | undefined,
  name: string,
): string {
  if (typeof value === "string") return value;
  throw cliError({
    code: CLI_ERROR_CODES.INVALID_ARGUMENT,
    message: `traycer: ${name} is required.`,
    details: null,
    exitCode: 1,
  });
}

function withRunner(
  cmd: CommanderCommand,
  build: (
    opts: Record<string, unknown>,
    args: ReadonlyArray<string | undefined>,
  ) => CommandFn,
): CommanderCommand {
  return addRunnerFlags(cmd).action(async (...actionArgs: unknown[]) => {
    const command = actionArgs[actionArgs.length - 1] as CommanderCommand;
    const positionals = extractActionPositionals(actionArgs);
    const optsBag = command.optsWithGlobals() as Record<string, unknown>;
    const fn = build(optsBag, positionals);
    await runCommand(fn, extractRunnerFlags(optsBag));
  });
}

/**
 * Pure check used by the script-entry guard to decide whether the
 * current `process.argv[1]` looks like a Traycer CLI entrypoint we
 * should auto-invoke. Lives at module scope (and is exported) so unit
 * tests can pin the matrix without spawning a subprocess.
 *
 * Matches:
 *  - the tsx dev path → `<repo>/clients/traycer-cli/src/index.ts`
 *  - the compiled SEA binary on POSIX → `<resourcesPath>/cli/traycer`
 *  - the compiled SEA binary on Windows → `<resourcesPath>\cli\traycer.exe`
 *
 * Returns `false` for `undefined`, empty strings, and unrelated paths
 * (so `import { buildProgram }` from a test never auto-parses argv).
 */
export function isTraycerCliEntrypoint(argv1: string | undefined): boolean {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  return /(?:^|[\\/])(?:index\.ts|traycer(?:\.exe)?)$/i.test(argv1);
}

// Local/dev fallback when the build pipeline did not inject a version
// (i.e. running under tsx / vitest or an unreleased local SEA build).
// CI release workflows set `TRAYCER_CLI_VERSION` from the `cli-v<version>`
// tag, and `build-cli-sea.cjs` bakes that value into the bundle via an
// esbuild define - when that path runs, `process.env.TRAYCER_CLI_VERSION`
// is a literal string in the emitted JS so this fallback is unreachable
// from a published binary.
export const LOCAL_CLI_VERSION = "0.0.0-local";

export type AgentCliSurface = "full" | "readonly";

export function resolveAgentCliSurface(
  env: Readonly<Record<string, string | undefined>>,
): AgentCliSurface {
  return env.TRAYCER_AGENT_CLI_SURFACE === "readonly" ? "readonly" : "full";
}

/**
 * Resolve the version Commander should advertise. SEA builds get the
 * release-injected value through an esbuild `define` on
 * `process.env.TRAYCER_CLI_VERSION`; everything else (tsx dev, vitest,
 * an unreleased local SEA built without the env var) falls back to
 * `0.0.0-local`. Exported so tests can pin the resolution matrix
 * without subprocess-spawning the binary.
 */
export function resolveCliVersion(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const injected = env.TRAYCER_CLI_VERSION;
  if (typeof injected === "string" && injected.length > 0) return injected;
  return LOCAL_CLI_VERSION;
}

// Construct the full commander program. Exported as a builder so tests
// can assert command registration (subject of the
// "Register native-packaging CLI commands in Traycer CLI entrypoint"
// follow-up bug) without spawning a subprocess. The script-mode call at
// the bottom of this file is the only place that invokes parseAsync.
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("traycer")
    .description("Traycer CLI - auth, host supervisor, and config surface")
    .version(resolveCliVersion(readonlyEnv()));

  // Global runner flags so `traycer --json <subcommand>` works even when
  // the subcommand declares its own copy. Commander merges globals via
  // `optsWithGlobals()` which is what the runner-aware action handlers
  // rely on.
  addRunnerFlags(program);
  registerCommands(program);
  // Route commander's own parse failures (missing required option, unknown
  // option/command) through the runner's error contract so `--json`
  // consumers get a structured `result/error` envelope instead of a bare
  // stderr line. `exitOverride` makes commander throw a `CommanderError`
  // (caught at the script entry) rather than calling `process.exit`
  // itself; the `writeErr` override suppresses commander's free-form
  // stderr in `--json` mode (the entry emits the NDJSON event instead), and
  // the `writeOut` override buffers help/version text under `--json` so the
  // entry can wrap it in a single `result/ok` envelope instead of leaking
  // raw prose onto an NDJSON stream.
  applyRunnerErrorRouting(program);
  return program;
}

// Commander stdout (help/version) captured under `--json` so the entry catch
// can emit it as a structured envelope. Empty in human mode (text streams
// straight through). Module-scoped because the `writeOut` override and the
// entry catch live in different scopes; this process runs one command then
// exits.
let commanderStdoutBuffer = "";

function applyRunnerErrorRouting(root: Command): void {
  const route = (cmd: Command): void => {
    cmd.exitOverride();
    cmd.configureOutput({
      writeErr: (str) => {
        if (!argvRequestsJson(root)) process.stderr.write(str);
      },
      writeOut: (str) => {
        if (argvRequestsJson(root)) commanderStdoutBuffer += str;
        else process.stdout.write(str);
      },
    });
    for (const sub of cmd.commands) route(sub);
  };
  route(root);
}

// True when the user passed the global `--json` flag. We can't reuse the
// runner's parsed flag here because this runs on a *parse failure* (or inside
// commander's own output hooks, before the action). We replicate the one rule
// that matters: a token that is the *value* of a value-taking option (e.g.
// `--message --json`) is not the flag. Collecting the value-taking flags from
// the real command tree keeps this faithful to the actual schema instead of a
// naive `argv.includes("--json")`, which mistook such a value for the flag.
let valueOptionFlagsCache: Set<string> | null = null;
function argvRequestsJson(root: Command): boolean {
  if (valueOptionFlagsCache === null) {
    valueOptionFlagsCache = collectValueOptionFlags(root);
  }
  const valueFlags = valueOptionFlagsCache;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") break;
    if (token === "--json" || token.startsWith("--json=")) return true;
    // Skip the value of a `--opt <value>` so a following `--json` consumed as
    // that value is not mistaken for the flag. The `--opt=value` form is a
    // single token, so it needs no skip.
    if (valueFlags.has(token)) i += 1;
  }
  return false;
}

function collectValueOptionFlags(root: Command): Set<string> {
  const flags = new Set<string>();
  const visit = (cmd: Command): void => {
    for (const opt of cmd.options) {
      // Boolean flags (`required` and `optional` both false) take no value.
      if (!opt.required && !opt.optional) continue;
      if (opt.long) flags.add(opt.long);
      if (opt.short) flags.add(opt.short);
    }
    for (const sub of cmd.commands) visit(sub);
  };
  visit(root);
  return flags;
}

// Thin orchestrator: each child registrar owns one logical command
// group and returns void after wiring its commands onto `program`. Keep
// this split when adding new commands - the body of `registerCommands`
// stays a single page of declarative registrations.
function registerCommands(program: Command): void {
  registerAuthCommands(program);
  registerHostCommands(program);
  registerCliCommands(program);
  registerConfigCommands(program);
  registerCommentsCommands(program);
  registerWorkspaceCommands(program);
  registerWorktreeCommands(program);
  registerAgentCommands(program);
  registerMonitorCommand(program);
}

function registerAuthCommands(program: Command): void {
  withRunner(
    program
      .command("login")
      .description("Sign in to Traycer via your browser")
      .option(
        "--token <token>",
        "Internal: seed credentials from a JSON `{ token, refreshToken }` payload piped on stdin (pass '-'). Used by the desktop app after sign-in; not for interactive use.",
      ),
    (opts) =>
      buildLoginCommand({
        token: typeof opts.token === "string" ? opts.token : null,
      }),
  );

  withRunner(
    program.command("logout").description("Forget the stored auth token"),
    () => logoutCommand,
  );

  withRunner(
    program.command("whoami").description("Print the signed-in user"),
    () => whoamiCommand,
  );
}

function registerHostCommands(program: Command): void {
  const host = program.command("host").description("Manage the local host");

  // `host start` is the long-running supervisor invoked by service
  // manifests (launchd / systemd-user / Windows Scheduled Task) as
  // `traycer host start`. The deploy slot is baked into the build via
  // `config.environment` - there is no flag to pass. It does NOT go through
  // `withRunner`/`runCommand` - it owns its own spawn lifecycle and must
  // not switch to the shared NDJSON runner. We still call `addRunnerFlags(...)`
  // so commander accepts the shared globals (`--json`, `--quiet`, …) when
  // they appear AFTER `host start`.
  addRunnerFlags(
    host
      .command("start")
      .description(
        "Bootstrap and supervise the host (used by launchd / systemd)",
      )
      .option(
        "--cwd <path>",
        "Working directory for the host (defaults to the install directory)",
      ),
  ).action(async (opts) => {
    const logger = createCliLogger(config.environment);
    logger.info("Host supervisor command invoked", {
      environment: config.environment,
      hasCwdOverride: typeof opts.cwd === "string",
    });
    await runHostStart(
      {
        environment: config.environment,
        cwd: typeof opts.cwd === "string" ? opts.cwd : null,
      },
      {},
    );
  });

  withRunner(
    host
      .command("status")
      .description("Show host status (pid, websocket URL, recent activity)"),
    () => hostStatusCommand,
  );

  withRunner(
    host
      .command("doctor")
      .description(
        "Run installation + runtime diagnostics for the host and CLI",
      ),
    () => hostDoctorCommand,
  );

  withRunner(
    host.command("restart").description("Restart the host service"),
    () => hostRestartCommand,
  );

  withRunner(
    host.command("stop").description("Stop the host service"),
    () => hostStopCommand,
  );

  registerServiceCommands(host);

  withRunner(
    host
      .command("install")
      .description(
        "Install a host version from the registry (defaults to latest), or a local archive with --from",
      )
      // `--release <version>` rather than `--version <version>` because
      // the latter collides with commander's top-level program
      // `--version` (set via `program.version(...)`) - commander
      // resolves the option name globally first, so a subcommand
      // `--version` ends up printing the CLI version and exiting.
      // `--release` conveys the same intent (which registry release
      // to install) without the collision.
      .option(
        "--release <version>",
        "Registry version to install (defaults to 'latest'). Mutually exclusive with --from.",
      )
      .option(
        "--from <path>",
        "Install from a local archive. Mutually exclusive with --release.",
      )
      .option(
        "--no-linger",
        "Linux only (ignored on macOS/Windows): skip 'loginctl enable-linger'",
      )
      .option(
        "--allow-self-invocation",
        "Dev only: register the current (non-packaged) CLI as the service command.",
      ),
    (opts) => {
      const explicitVersion =
        typeof opts.release === "string" && opts.release.length > 0
          ? opts.release
          : null;
      const fromPath = typeof opts.from === "string" ? opts.from : null;
      // The --release/--from mutual-exclusion check must run INSIDE the
      // returned CommandFn so the runner catches it (CliError → NDJSON
      // error envelope). Throwing in this build callback escapes
      // runCommand's try/catch and dumps a raw stack trace with no
      // envelope under --json.
      return async (ctx) => {
        if (explicitVersion !== null && fromPath !== null) {
          throw cliError({
            code: CLI_ERROR_CODES.INVALID_ARGUMENT,
            message:
              "host install: --release and --from are mutually exclusive; pass one or the other",
            details: { release: explicitVersion, from: fromPath },
            exitCode: 1,
          });
        }
        return buildHostInstallCommand({
          // Registry path defaults to "latest" when neither flag is set.
          // For --from installs the value is unused (the archive supplies
          // the version), but the underlying command contract still wants
          // a concrete token - pass "latest" as the safe placeholder.
          versionRequest: explicitVersion ?? "latest",
          fromPath,
          // commander's `--no-linger` materialises as `linger: false`.
          enableLinger: opts.linger !== false,
          allowSelfInvocation: opts.allowSelfInvocation === true,
        })(ctx);
      };
    },
  );

  withRunner(
    host
      .command("ensure")
      .description(
        "Make sure the host is installed, registered as a service, and running - installing or starting it if needed. Safe to run repeatedly.",
      )
      // Same `--release`/`--from` shape as `install` (see the comment on
      // `install` for why `--release` is used instead of `--version`).
      // Unlike `install`, `ensure` defaults to the host archive packaged
      // beside the CLI when present, falling back to the registry.
      .option(
        "--release <version>",
        "Registry version to ensure (defaults to 'latest'/packaged). Mutually exclusive with --from.",
      )
      .option(
        "--from <path>",
        "Ensure from a local archive. Mutually exclusive with --release.",
      )
      .option(
        "--no-linger",
        "Linux only (ignored on macOS/Windows): skip 'loginctl enable-linger'",
      )
      .option(
        "--allow-self-invocation",
        "Dev only: register the current (non-packaged) CLI as the service command.",
      )
      .option(
        "--no-service-register",
        "Install the host without registering it as an OS service (the caller registers the service).",
      )
      .option(
        "--force",
        "Restart the host even if it has work in progress (skips the busy check).",
      ),
    (opts) => {
      const explicitVersion =
        typeof opts.release === "string" && opts.release.length > 0
          ? opts.release
          : null;
      const fromPath = typeof opts.from === "string" ? opts.from : null;
      // See `host install` above - the mutual-exclusion check runs inside
      // the CommandFn so the runner emits a proper NDJSON error envelope.
      return async (ctx) => {
        if (explicitVersion !== null && fromPath !== null) {
          throw cliError({
            code: CLI_ERROR_CODES.INVALID_ARGUMENT,
            message:
              "host ensure: --release and --from are mutually exclusive; pass one or the other",
            details: { release: explicitVersion, from: fromPath },
            exitCode: 1,
          });
        }
        return buildHostEnsureCommand({
          versionRequest: explicitVersion,
          fromPath,
          enableLinger: opts.linger !== false,
          allowSelfInvocation: opts.allowSelfInvocation === true,
          // commander's `--no-service-register` materialises as
          // `serviceRegister: false`.
          noServiceRegister: opts.serviceRegister === false,
          force: opts.force === true,
        })(ctx);
      };
    },
  );

  withRunner(
    host
      .command("update")
      .description("Update the installed host to the latest registry version")
      .option(
        "--force",
        "Update the host even if it has work in progress (skips the busy check).",
      ),
    (opts) =>
      buildHostUpdateCommand({
        force: opts.force === true,
      }),
  );

  withRunner(
    host
      .command("uninstall")
      .description("Remove the installed host and optionally the OS service")
      .option("--all", "Also deregister the OS service"),
    (opts) =>
      buildHostUninstallCommand({
        all: opts.all === true,
      }),
  );

  withRunner(
    host
      .command("available")
      .description(
        "List host versions available in the registry for this environment",
      )
      .option(
        "--include-pre-releases",
        "Include release-candidate and other prerelease host versions",
      ),
    (opts) =>
      buildHostAvailableCommand({
        includePreReleases: opts.includePreReleases === true,
      }),
  );

  withRunner(
    host
      .command("logs")
      .description("Tail the host log file")
      .option("--tail <lines>", "Number of trailing lines to print", "200")
      .option(
        "--follow",
        "Stream new log lines as they are written (ignored with --json)",
      ),
    (opts) => {
      const tailRaw =
        typeof opts.tail === "string" ? Number.parseInt(opts.tail, 10) : 200;
      const tailLines = Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : 200;
      return buildHostLogsCommand({
        follow: opts.follow === true,
        tailLines,
      });
    },
  );

  withRunner(
    host
      .command("free-port-and-restart", { hidden: true })
      .description(
        "Terminate a foreign PID holding the host port and restart the service (internal - invoked by Doctor)",
      )
      .option("--pid <pid>", "PID of the conflicting process to terminate")
      .option("--port <port>", "Port the foreign process is bound to"),
    (opts) => {
      const pidRaw =
        typeof opts.pid === "string" ? Number.parseInt(opts.pid, 10) : null;
      const portRaw =
        typeof opts.port === "string" ? Number.parseInt(opts.port, 10) : null;
      return buildHostFreePortAndRestartCommand({
        pid: pidRaw !== null && Number.isFinite(pidRaw) ? pidRaw : null,
        port: portRaw !== null && Number.isFinite(portRaw) ? portRaw : null,
      });
    },
  );
}

function registerServiceCommands(host: Command): void {
  const service = host
    .command("service")
    .description(
      "Register / deregister the OS service that supervises the host",
    );

  withRunner(
    service
      .command("install")
      .description("Register the OS service for the current environment")
      .option(
        "--no-linger",
        "Linux only (ignored on macOS/Windows): skip 'loginctl enable-linger'",
      )
      .option(
        "--allow-self-invocation",
        "Dev only: register the current (non-packaged) CLI as the service command.",
      ),
    (opts) =>
      buildServiceInstallCommand({
        enableLinger: opts.linger !== false,
        allowSelfInvocation: opts.allowSelfInvocation === true,
      }),
  );

  withRunner(
    service
      .command("status")
      .description("Show the OS service registration + running state"),
    () => serviceStatusCommand,
  );

  withRunner(
    service
      .command("uninstall")
      .description("Deregister the OS service for the current environment"),
    () => serviceUninstallCommand,
  );
}

function registerCliCommands(program: Command): void {
  const cli = program
    .command("cli")
    .description("Manage the installed CLI binary (upgrade, re-anchor)");

  withRunner(
    cli
      .command("upgrade")
      .description(
        "Self-upgrade the CLI binary; stages a pending swap when the live binary is locked",
      )
      .option(
        "--dry-run",
        "Resolve the target version without staging or replacing",
      )
      .option(
        "--target <version>",
        "Override the target version (defaults to latest)",
      ),
    (opts) =>
      buildCliUpgradeCommand({
        dryRun: opts.dryRun === true,
        targetVersion: typeof opts.target === "string" ? opts.target : null,
      }),
  );

  withRunner(
    cli
      .command("mark-source", { hidden: true })
      .description(
        "Internal: record a package-manager install (called from Homebrew/npm/winget/Scoop/deb/rpm install hooks; rejects --source manual)",
      )
      .requiredOption(
        "--source <source>",
        "One of: desktop, homebrew, npm, winget, scoop, apt, rpm (use 'cli re-anchor' for manual installs)",
      )
      .requiredOption(
        "--binary-path <path>",
        "Absolute path to the installed CLI binary",
      )
      // NOT `--version`: that collides with the program-level `program.version()`
      // global flag (commander resolves it first, printing the CLI version and
      // exiting 0 before this command's action runs). See the same rename on
      // `host install` (`--release`). Package-manager hooks must pass
      // `--installed-version` (see scripts/native-packaging/publish-cli-package-managers.cjs).
      .requiredOption(
        "--installed-version <version>",
        "Version reported by the installer",
      ),
    (opts) =>
      buildCliMarkSourceCommand({
        source: typeof opts.source === "string" ? opts.source : "",
        binaryPath: typeof opts.binaryPath === "string" ? opts.binaryPath : "",
        version:
          typeof opts.installedVersion === "string"
            ? opts.installedVersion
            : "",
      }),
  );

  withRunner(
    cli
      .command("re-anchor")
      .description(
        "Point Traycer's upgrade tracking at a CLI binary you installed or moved by hand, so future 'cli upgrade' runs update the right file. Use after manually relocating or replacing the binary.",
      )
      .requiredOption(
        "--binary-path <path>",
        "Absolute path to the manually installed CLI binary",
      )
      // `--installed-version`, not `--version`: avoids the program-level
      // `--version` collision (see `cli mark-source`).
      .requiredOption(
        "--installed-version <version>",
        "Version reported by the binary",
      ),
    (opts) =>
      buildCliReAnchorCommand({
        binaryPath: typeof opts.binaryPath === "string" ? opts.binaryPath : "",
        version:
          typeof opts.installedVersion === "string"
            ? opts.installedVersion
            : "",
      }),
  );
}

function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("Read or write Traycer's machine-local config");

  const shell = config
    .command("shell")
    .description("Shell used for host bootstrap and terminal tabs");
  withRunner(
    shell
      .command("get")
      .description(
        "Print the effective shell config (synthesised defaults if unset)",
      ),
    () => configShellGetCommand,
  );
  withRunner(
    shell
      .command("list")
      .description(
        "List shells detected on this machine (powers the Settings shell picker)",
      ),
    () => configShellListCommand,
  );
  // `config shell set` takes a variadic `[shellArgs...]` positional that
  // commander passes as a single array as the first action argument.
  // `withRunner`'s positional extractor coerces non-string entries to
  // `undefined`, so we wire this command directly through
  // `addRunnerFlags` + `runCommand`. The runner still owns process.exit
  // and the NDJSON envelope.
  addRunnerFlags(
    shell
      .command("set")
      .description(
        "Set the shell path and/or args. Pass each arg as a separate token after `--`, e.g. `traycer config shell set --path /bin/zsh -- -i -l`. Use --clear-args to store an explicit empty list.",
      )
      .option("--path <path>", "Absolute path to the shell binary")
      .option("--clear-args", "Store an explicit empty args list")
      .argument(
        "[shellArgs...]",
        "Shell flags (recommended: pass after `--` so leading dashes aren't parsed as options)",
      ),
  ).action(async (...actionArgs: unknown[]) => {
    const command = actionArgs[actionArgs.length - 1] as CommanderCommand;
    const optsBag = command.optsWithGlobals() as Record<string, unknown>;
    const variadic = actionArgs[0];
    const positionalArgs: string[] = Array.isArray(variadic)
      ? variadic.filter((s): s is string => typeof s === "string")
      : [];
    const hasPositionalArgs = positionalArgs.length > 0;
    const clearArgs = optsBag.clearArgs === true;
    const fn: CommandFn = async (ctx) => {
      if (hasPositionalArgs && clearArgs) {
        throw cliError({
          code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE,
          message:
            "config shell set: --clear-args is incompatible with positional args",
          details: { clearArgs, shellArgs: positionalArgs },
          exitCode: 1,
        });
      }
      const args: readonly string[] | null = clearArgs
        ? []
        : hasPositionalArgs
          ? positionalArgs
          : null;
      return buildConfigShellSetCommand({
        path: typeof optsBag.path === "string" ? optsBag.path : null,
        args,
      })(ctx);
    };
    await runCommand(fn, extractRunnerFlags(optsBag));
  });

  withRunner(
    shell
      .command("reset")
      .description(
        "Clear the stored shell overrides; defaults are synthesised on next read",
      ),
    () => configShellResetCommand,
  );

  const env = config
    .command("env")
    .description("Env vars layered on top of host + terminal env");
  withRunner(
    env.command("list").description("List env overrides"),
    () => async (ctx) => buildConfigEnvListCommand()(ctx),
  );
  withRunner(
    env
      .command("get")
      .description("Get a single env override")
      .requiredOption("--key <key>", "Env var name"),
    (opts) => async (ctx) =>
      buildConfigEnvGetCommand({
        key: typeof opts.key === "string" ? opts.key : "",
      })(ctx),
  );
  withRunner(
    env
      .command("set")
      .description(
        "Set or update an env override (key must match /^[A-Za-z_][A-Za-z0-9_]*$/)",
      )
      .requiredOption("--key <key>", "Env var name")
      .requiredOption("--value <value>", "Env var value"),
    (opts) => async (ctx) =>
      buildConfigEnvSetCommand({
        key: typeof opts.key === "string" ? opts.key : "",
        value: typeof opts.value === "string" ? opts.value : "",
      })(ctx),
  );
  withRunner(
    env
      .command("unset")
      .description("Explicitly unset an inherited env var")
      .requiredOption("--key <key>", "Env var name"),
    (opts) => async (ctx) =>
      buildConfigEnvUnsetCommand({
        key: typeof opts.key === "string" ? opts.key : "",
      })(ctx),
  );
  withRunner(
    env
      .command("delete")
      .description("Delete an env override (errors if the key is not set)")
      .requiredOption("--key <key>", "Env var name"),
    (opts) => async (ctx) =>
      buildConfigEnvDeleteCommand({
        key: typeof opts.key === "string" ? opts.key : "",
      })(ctx),
  );
}

// Inter-agent communication surface. Every Traycer-launched session
// carries `TRAYCER_AGENT_ID` / `TRAYCER_EPIC_ID` in its environment, so an
// agent typically runs these with no flags; the host bearer comes from
// the stored credentials (`traycer login`).
function collectRepeatedOption(
  value: string,
  previous: readonly string[],
): string[] {
  return [...previous, value];
}

function registerWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Inspect workspace folders");

  withRunner(
    workspace
      .command("list")
      .description("List workspace folders and Git worktrees for an epic")
      .option("--epic-id <id>", "Epic to list (defaults to $TRAYCER_EPIC_ID)"),
    (opts) =>
      buildWorkspaceListCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
      }),
  );
}

function registerCommentsCommands(program: Command): void {
  const comments = program
    .command("comments")
    .description("Inspect and update artifact comment threads");

  withRunner(
    comments
      .command("list")
      .description("List artifact comment threads")
      .argument("[artifactPaths...]", "Absolute artifact paths")
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)")
      .option("--status <status>", "Thread status: all, open, or resolved"),
    (opts, args) =>
      buildCommentsListCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        status: typeof opts.status === "string" ? opts.status : null,
        artifactPaths: args.filter(
          (value): value is string => typeof value === "string",
        ),
      }),
  );

  withRunner(
    comments
      .command("set-status")
      .description("Set artifact comment threads to open or resolved")
      .requiredOption("--artifact <path>", "Absolute artifact path")
      .requiredOption("--status <status>", "Thread status: open or resolved")
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)")
      .argument("<threadIds...>", "Thread ids to update"),
    (opts, args) =>
      buildCommentsSetStatusCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        artifactPath: typeof opts.artifact === "string" ? opts.artifact : "",
        status: typeof opts.status === "string" ? opts.status : "",
        threadIds: args.filter(
          (value): value is string => typeof value === "string",
        ),
      }),
  );
}

function registerWorktreeCommands(program: Command): void {
  const worktree = program
    .command("worktree")
    .description("Create and inspect Git worktree paths");

  withRunner(
    worktree
      .command("create")
      .description("Create a Git worktree path without creating an agent")
      .requiredOption("--workspace <path>", "Source workspace path")
      .option(
        "--branch <branch>",
        "Create a new branch with this name (forks from --source-branch)",
      )
      .option(
        "--existing <branch>",
        "Check out an existing branch into a fresh worktree (no new branch)",
      )
      .option(
        "--source-branch <branch>",
        "Branch the new --branch forks from (defaults to the workspace's current branch)",
      )
      .option(
        "--carry-uncommitted",
        "Carry tracked and untracked changes from the source workspace when valid",
      ),
    (opts) =>
      buildWorktreeCreateCommand({
        workspacePath: typeof opts.workspace === "string" ? opts.workspace : "",
        newBranch: typeof opts.branch === "string" ? opts.branch : null,
        existingBranch:
          typeof opts.existing === "string" ? opts.existing : null,
        sourceBranch:
          typeof opts.sourceBranch === "string" ? opts.sourceBranch : null,
        carryUncommittedChanges: opts.carryUncommitted === true,
      }),
  );
}

function registerAgentCommands(program: Command): void {
  const cliSurface = resolveAgentCliSurface(readonlyEnv());
  const readonlyHidden = { hidden: cliSurface === "readonly" };
  const harnessHelp = `Harness id: ${AGENT_FACING_HARNESS_ID_LIST}`;
  const agent = program
    .command("agent")
    .description("Agent inspection and communication for the calling agent");

  withRunner(
    agent
      .command("list")
      .description("List every agent in the epic")
      .option("--epic-id <id>", "Epic to list (defaults to $TRAYCER_EPIC_ID)")
      .option(
        "--sender-agent-id <id>",
        "Listing agent (defaults to $TRAYCER_AGENT_ID)",
      )
      .option(
        "-a, --all",
        "List all agents in the epic, not just agents belonging to this user",
      ),
    (opts) =>
      buildAgentListCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        senderAgentId:
          typeof opts.senderAgentId === "string" ? opts.senderAgentId : null,
        all: opts.all === true,
      }),
  );

  withRunner(
    agent
      .command("create", readonlyHidden)
      .description(
        "Create a child agent. When some params are omitted, they are inherited from the sender or default values used.",
      )
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)")
      .option(
        "--sender-agent-id <id>",
        "Creating (parent) agent (defaults to $TRAYCER_AGENT_ID)",
      )
      .option("--surface <surface>", "Child surface: 'gui' or 'tui'")
      .option("--name <name>", "Display name for the child agent")
      .option("--harness <id>", harnessHelp)
      .option("--model <id>", "Model id for the child agent")
      .option("--agent-mode <mode>", "Agent mode: regular or epic")
      .option(
        "--reasoning-effort <effort>",
        "Reasoning effort for supported models",
      )
      .option(
        "--fast",
        "Request fast mode for supported models. Only available for gui surface.",
      )
      .option(
        "--cwd <path>",
        "Primary working directory for the child agent. Use this with a path returned by 'traycer worktree create'.",
      )
      .option(
        "--workspace-path <path>",
        "Additional existing path the child agent may access. Repeatable.",
        collectRepeatedOption,
        [],
      )
      .option(
        "--workspace-entry <workspace=path>",
        "Exact workspace binding. Repeatable. Use /path alone for existing/local, or /source=/run for a worktree.",
        collectRepeatedOption,
        [],
      ),
    (opts) =>
      buildAgentCreateCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        senderAgentId:
          typeof opts.senderAgentId === "string" ? opts.senderAgentId : null,
        name: typeof opts.name === "string" ? opts.name : null,
        surface: typeof opts.surface === "string" ? opts.surface : null,
        harness: typeof opts.harness === "string" ? opts.harness : null,
        model: typeof opts.model === "string" ? opts.model : null,
        agentMode: typeof opts.agentMode === "string" ? opts.agentMode : null,
        reasoningEffort:
          typeof opts.reasoningEffort === "string"
            ? opts.reasoningEffort
            : null,
        fast: opts.fast === true,
        cwd: typeof opts.cwd === "string" ? opts.cwd : null,
        workspacePaths: Array.isArray(opts.workspacePath)
          ? opts.workspacePath.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
        workspaceEntries: Array.isArray(opts.workspaceEntry)
          ? opts.workspaceEntry.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
      }),
  );

  withRunner(
    agent
      .command("selection-guide", readonlyHidden)
      .description(
        "Get the instructions for the agent selection guide. Instructs which child agents to create for different kinds of tasks.",
      )
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)")
      .option(
        "--sender-agent-id <id>",
        "Calling agent (defaults to $TRAYCER_AGENT_ID)",
      ),
    (opts) =>
      buildAgentSelectionGuideCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        senderAgentId:
          typeof opts.senderAgentId === "string" ? opts.senderAgentId : null,
      }),
  );

  withRunner(
    agent
      .command("list-harnesses", readonlyHidden)
      .description("List enabled harnesses."),
    () => buildAgentListHarnessesCommand(),
  );

  withRunner(
    agent
      .command("list-harness-models", readonlyHidden)
      .description("List available models (and params) for one harness.")
      .argument("<harness>", harnessHelp)
      .option(
        "--epic-id <id>",
        "Optional epic context (defaults to $TRAYCER_EPIC_ID)",
      )
      .option(
        "--sender-agent-id <id>",
        "Optional calling-agent context (defaults to $TRAYCER_AGENT_ID)",
      ),
    (opts, args) =>
      buildAgentListHarnessModelsCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        senderAgentId:
          typeof opts.senderAgentId === "string" ? opts.senderAgentId : null,
        harnessId: expectRequiredPositional(args[0], "harness"),
      }),
  );

  withRunner(
    agent
      .command("send", readonlyHidden)
      .description("Send a prompt to another agent")
      .requiredOption("--to <agentId>", "Receiver agent id")
      .requiredOption("--message <text>", "Prompt to deliver")
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)")
      .option(
        "--sender-agent-id <id>",
        "Sending agent (defaults to $TRAYCER_AGENT_ID)",
      )
      .option(
        "--expect-reply",
        "Open or reuse a reply thread; the host returns a responseId",
      )
      .option(
        "--response-id <id>",
        "Close an open thread - this send is the final reply",
      ),
    (opts) =>
      buildAgentSendCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        senderAgentId:
          typeof opts.senderAgentId === "string" ? opts.senderAgentId : null,
        to: typeof opts.to === "string" ? opts.to : "",
        message: typeof opts.message === "string" ? opts.message : "",
        expectReply: opts.expectReply === true,
        responseId:
          typeof opts.responseId === "string" ? opts.responseId : null,
      }),
  );

  withRunner(
    agent
      .command("transcript")
      .description("Print another agent's conversation transcript")
      .requiredOption("--agent-id <id>", "Agent whose transcript to read")
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)"),
    (opts) =>
      buildAgentTranscriptCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        agentId: typeof opts.agentId === "string" ? opts.agentId : "",
      }),
  );

  withRunner(
    agent
      .command("inbox", readonlyHidden)
      .description(
        "Print your recently-delivered inbox messages in full (recovery for a truncated monitor notification).",
      )
      .option(
        "--agent-id <id>",
        "Agent whose inbox to read (defaults to $TRAYCER_AGENT_ID)",
      )
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)"),
    (opts) =>
      buildAgentInboxCommand({
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        agentId: typeof opts.agentId === "string" ? opts.agentId : null,
      }),
  );

  withRunner(
    agent
      .command("title-from-hook", { hidden: true })
      .description(
        "Submit a TUI agent's first user prompt (read as hook JSON on stdin) to the host title flow.",
      )
      .requiredOption(
        "--provider <provider>",
        "Provider hook firing this call: 'claude', 'codex', or 'opencode'",
      )
      .option(
        "--epic-id <id>",
        "Epic the agent lives in (defaults to $TRAYCER_EPIC_ID)",
      )
      .option(
        "--agent-id <id>",
        "TUI agent id whose title to generate (defaults to $TRAYCER_AGENT_ID)",
      )
      .option(
        "--harness-session-id <id>",
        "Provider session id for hooks that run outside per-agent env",
      ),
    (opts) =>
      buildAgentTitleFromHookCommand({
        provider: typeof opts.provider === "string" ? opts.provider : "",
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        agentId: typeof opts.agentId === "string" ? opts.agentId : null,
        harnessSessionId:
          typeof opts.harnessSessionId === "string"
            ? opts.harnessSessionId
            : null,
      }),
  );

  withRunner(
    agent
      .command("activity-from-hook", { hidden: true })
      .description(
        "Submit a TUI agent turn lifecycle event from a provider hook.",
      )
      // Codex's `notify` (the only turn-end edge it exposes) invokes this as the
      // `stop` program and appends its `agent-turn-complete` JSON as a trailing
      // argv. The stop edge is keyed entirely on the bound agent env, so that
      // payload is ignored - tolerate it instead of erroring on the extra arg.
      .allowExcessArguments(true)
      .requiredOption(
        "--provider <provider>",
        "Provider hook firing this call: 'claude', 'codex', or 'opencode'",
      )
      .requiredOption("--event <event>", "Lifecycle event: 'start' or 'stop'")
      .option(
        "--epic-id <id>",
        "Epic the agent lives in (defaults to $TRAYCER_EPIC_ID)",
      )
      .option(
        "--agent-id <id>",
        "TUI agent id whose activity changed (defaults to $TRAYCER_AGENT_ID)",
      )
      .option(
        "--harness-session-id <id>",
        "Provider session id for hooks that run outside per-agent env",
      ),
    (opts) =>
      buildAgentActivityFromHookCommand({
        provider: typeof opts.provider === "string" ? opts.provider : "",
        event: typeof opts.event === "string" ? opts.event : "",
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        agentId: typeof opts.agentId === "string" ? opts.agentId : null,
        harnessSessionId:
          typeof opts.harnessSessionId === "string"
            ? opts.harnessSessionId
            : null,
      }),
  );

  withRunner(
    agent
      .command("turn-ended-from-hook", { hidden: true })
      .description(
        "Signal the host that a TUI agent's turn ended (provider Stop hook) so inter-agent inactivity notices fire accurately.",
      )
      .requiredOption(
        "--provider <provider>",
        "Provider hook firing this call: 'claude', 'codex', or 'opencode'",
      )
      .option(
        "--epic-id <id>",
        "Epic the agent lives in (defaults to $TRAYCER_EPIC_ID)",
      )
      .option(
        "--agent-id <id>",
        "TUI agent id whose turn ended (defaults to $TRAYCER_AGENT_ID)",
      ),
    (opts) =>
      buildAgentTurnEndedFromHookCommand({
        provider: typeof opts.provider === "string" ? opts.provider : "",
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
        agentId: typeof opts.agentId === "string" ? opts.agentId : null,
      }),
  );
}

// `monitor` is the long-running inbox subscriber the Claude Code plugin
// spawns. Like `host start` it owns its own lifecycle and does NOT go
// through the shared NDJSON runner - `addRunnerFlags` is applied only so
// the shared globals still parse if present.
function registerMonitorCommand(program: Command): void {
  addRunnerFlags(
    program
      .command("monitor", {
        hidden: resolveAgentCliSurface(readonlyEnv()) === "readonly",
      })
      .description("Stream this agent's inter-agent inbox messages to stdout.")
      .option(
        "--agent-id <id>",
        "Agent to monitor (defaults to $TRAYCER_AGENT_ID)",
      )
      .option("--epic-id <id>", "Epic (defaults to $TRAYCER_EPIC_ID)"),
  ).action(async (opts: Record<string, unknown>) => {
    const logger = createCliLogger(config.environment);
    logger.info("Monitor command invoked", {
      environment: config.environment,
      hasAgentIdArg: typeof opts.agentId === "string",
      hasEpicIdArg: typeof opts.epicId === "string",
      hasAgentIdEnv: typeof process.env.TRAYCER_AGENT_ID === "string",
      hasEpicIdEnv: typeof process.env.TRAYCER_EPIC_ID === "string",
    });
    try {
      await runMonitor({
        agentId: typeof opts.agentId === "string" ? opts.agentId : null,
        epicId: typeof opts.epicId === "string" ? opts.epicId : null,
      });
    } catch (err) {
      logger.error(
        "Monitor command failed",
        { exitCode: 1 },
        errorFromUnknown(err),
      );
      process.stderr.write(
        `[traycer monitor] fatal: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(1);
    }
  });
}

// Script entry. Skipped when this module is imported (e.g. by the
// command-registration smoke test) so `buildProgram()` consumers don't
// trigger `parseAsync` against `process.argv`. The check matches
// argv[1] against this file's basename which is robust across both the
// tsx dev path and a bundled `bun --compile` binary where argv[1] is
// the CLI invocation itself - including the Windows `traycer.exe`
// suffix produced by `bun build --compile --target=bun-windows-x64`.
const entryArgv = typeof process !== "undefined" ? process.argv[1] : undefined;
if (isTraycerCliEntrypoint(entryArgv)) {
  const entryLogger = createCliLogger(config.environment);
  installProcessFailureHandlers(entryLogger);
  const program = buildProgram();
  entryLogger.debug("CLI entrypoint parsing argv", {
    environment: config.environment,
    argvLength: process.argv.length,
  });
  program.parseAsync(process.argv).catch((err) => {
    if (err instanceof CommanderError) {
      const jsonMode = argvRequestsJson(program);
      // Help (`--help`) and version (`--version`) flow through exitOverride
      // with exitCode 0. In human mode commander already streamed the text
      // to stdout; in --json mode that text was buffered (see the `write`
      // override) so we wrap it in a single `result/ok` envelope rather than
      // leaking raw prose onto an NDJSON stream.
      if (err.exitCode === 0) {
        entryLogger.debug("Commander handled informational exit", {
          json: jsonMode,
          commanderCode: err.code,
          exitCode: err.exitCode,
        });
        if (jsonMode) {
          const event = {
            type: "result",
            status: "ok",
            data: { output: commanderStdoutBuffer.trimEnd() },
            timestamp: new Date().toISOString(),
          };
          process.stdout.write(`${JSON.stringify(event)}\n`);
        }
        process.exit(0);
      }
      // Parse failure. In --json mode emit the runner's NDJSON error
      // envelope so downstream consumers see a coded `result/error`;
      // in human mode commander already wrote the message to stderr
      // (via the configureOutput passthrough above).
      entryLogger.warn("Commander parse failed", {
        json: jsonMode,
        commanderCode: err.code,
        exitCode: err.exitCode || 1,
      });
      if (jsonMode) {
        const event = {
          type: "result",
          status: "error",
          error: {
            code: CLI_ERROR_CODES.INVALID_ARGUMENT,
            // Commander prefixes its messages with "error: "; strip it so
            // the envelope's `message` is clean (the `error` wrapper and
            // `code` already convey severity).
            message: err.message.replace(/^error:\s*/i, ""),
            details: { commanderCode: err.code },
          },
          timestamp: new Date().toISOString(),
        };
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      process.exit(err.exitCode || 1);
    }
    const error = errorFromUnknown(err);
    entryLogger.error(
      "CLI entrypoint failed outside Commander",
      { exitCode: 1 },
      error,
    );
    Sentry.captureException(err);
    if (argvRequestsJson(program)) {
      const event = {
        type: "result",
        status: "error",
        error: {
          code: CLI_ERROR_CODES.UNEXPECTED,
          message: "Unexpected CLI failure. See the CLI log for details.",
          details: null,
        },
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      process.stderr.write(
        `error: unexpected CLI failure [code=${CLI_ERROR_CODES.UNEXPECTED}]\n`,
      );
    }
    process.exit(1);
  });
}

let fatalExitInProgress = false;

function installProcessFailureHandlers(logger: ILogger): void {
  process.on("unhandledRejection", (reason) => {
    exitAfterUnhandledFailure(
      logger,
      "Unhandled CLI promise rejection",
      reason,
    );
  });
  process.on("uncaughtException", (err) => {
    exitAfterUnhandledFailure(logger, "Uncaught CLI exception", err);
  });
}

function exitAfterUnhandledFailure(
  logger: ILogger,
  message: string,
  cause: unknown,
): void {
  if (fatalExitInProgress) {
    return;
  }
  fatalExitInProgress = true;
  const error = errorFromUnknown(cause);
  logger.error(message, { exitCode: 1 }, error);
  Sentry.captureException(cause);
  process.stderr.write(
    `error: unexpected CLI failure [code=${CLI_ERROR_CODES.UNEXPECTED}]\n`,
  );
  void Sentry.flush(2000)
    .catch((flushErr) => {
      logger.warn("Sentry flush failed after process-level failure", {
        errorName: errorFromUnknown(flushErr).name,
        errorMessage: errorFromUnknown(flushErr).message,
      });
    })
    .finally(() => {
      process.exit(1);
    });
}
