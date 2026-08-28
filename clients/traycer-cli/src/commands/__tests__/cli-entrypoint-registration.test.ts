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
  serviceControllerCalls: [] as string[],
  progressEvents: [] as ProgressInfo[],
}));

// `host free-port-and-restart`'s handler calls `createServiceController().restart(...)`
// once its two guards clear. Mocked so a real (both-flags) parse in this
// file's "genuinely exercise the index.ts guard" tests below never reaches
// an actual OS service manager - the restart/lock/attestation plumbing past
// the guards is exercised for real in `host-free-port-and-restart.test.ts`.
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      uninstall: async () => undefined,
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      stop: async () => {
        mocks.serviceControllerCalls.push("stop");
      },
      start: async () => {
        mocks.serviceControllerCalls.push("start");
      },
      restart: async () => {
        mocks.serviceControllerCalls.push("restart");
      },
    }),
  };
});

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
      workUnits: null,
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

// Keep `host update`'s commander parse assertion on the real command wiring
// while making its no-op backfill deterministic and side-effect free.
//
// Spread the real module rather than replacing it: a bare factory drops every
// OTHER export, and `writeHostInstallRecordAt`, `writeHostInstallRecord` and
// `deleteHostInstallRecord` are imported by command paths this suite also
// registers. Those would resolve to `undefined` and fail as "not a function",
// which reads as a broken command rather than a truncated mock.
vi.mock("../../manifest/host-install", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../manifest/host-install")>()),
  readHostInstallRecord: async () => ({
    installId: "install-test",
    version: "1.0.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "1.0.0" },
    archiveSha256: null,
    signatureVerifiedAt: null,
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
  }),
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
      workUnits: null,
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
    return {
      killed: true,
      killError: null,
      release: "released",
      releaseDetail: "pid 4242 exited after SIGTERM",
      holderPid: null,
    };
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

vi.mock("../../commands/host-status", () => ({
  hostStatusCommand: async () => ({ data: null, human: null, exitCode: 0 }),
}));

vi.mock("../../commands/config-env-list", () => ({
  buildConfigEnvListCommand: () => async () => ({
    data: [],
    human: null,
    exitCode: 0,
  }),
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

import { buildProgram, buildProgramWithAgentRoles } from "../../index";
import { CLI_ERROR_CODES } from "../../runner/errors";

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

function collectOptionFlags(command: Command): Array<string | undefined> {
  return [
    ...command.options.map((option) => option.long),
    ...command.commands.flatMap(collectOptionFlags),
  ];
}

// `helpInformation()` renders only the built-in sections - `addHelpText`
// content (the prose these tests pin) is invisible to it, so anything that
// checks addHelpText output has to go through the real `outputHelp()` write
// path instead (mirrors "host update --help documents --version..." above).
function renderedHelp(cmd: Command): string {
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  try {
    cmd.outputHelp();
    return write.mock.calls.map(([chunk]) => String(chunk)).join("");
  } finally {
    write.mockRestore();
  }
}

describe("traycer CLI entrypoint registration", () => {
  it("keeps epic and sender context env-only across the entire command tree", () => {
    const flags = collectOptionFlags(buildProgramWithAgentRoles(true));
    expect(flags).not.toContain("--epic-id");
    expect(flags).not.toContain("--sender-agent-id");
  });

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

  it("login's --token is hidden from --help: reachable, but no longer advertised as a public flag", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["login"]);
    // `expectCommand`/the flags check above already prove it is still wired;
    // `.hideHelp()` only changes what `--help` prints.
    expect(cmd.helpInformation()).not.toContain("--token");
  });

  it("whoami exposes --local for the observational read", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["whoami"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--local");
  });

  it("whoami's --help discloses that the default validates and may refresh the stored credentials", () => {
    // `addHelpText` content is invisible to `helpInformation()` (see the
    // "host update --help" test above for why) - assert on what `--help`
    // actually prints via `outputHelp()`.
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const program = buildProgram();
      const cmd = expectCommand(program, ["whoami"]);
      cmd.outputHelp();
      const printedHelp = write.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(printedHelp).toContain("SPENDING");
      expect(printedHelp).toContain("credentialUpdate");
      // Describes the pair of "-unconfirmed" values rather than enumerating a
      // stale one; regression guard below pins that the old, since-corrected
      // 'token-rotation-unsaved' spelling is gone.
      expect(printedHelp).toContain("-unconfirmed");
      expect(printedHelp).not.toContain("token-rotation-unsaved");
    } finally {
      write.mockRestore();
    }
  });

  it("whoami's --help states exit-code meaning per mode, not a single flat claim that 0 means signed in", () => {
    // Regression guard for the "flat exit-codes line contradicts the --local
    // paragraph above it" fix: exit 0 means something weaker under --local
    // (a credential is merely stored, not validated) than under the default
    // mode, and the help text has to say so rather than claim one meaning
    // for both.
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const program = buildProgram();
      const cmd = expectCommand(program, ["whoami"]);
      cmd.outputHelp();
      const printedHelp = write.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(printedHelp).not.toContain("0 signed in");
      expect(printedHelp).toContain("NOT proof");
    } finally {
      write.mockRestore();
    }
  });

  it("logout's --help discloses that it deletes the local published-chat cache", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const program = buildProgram();
      const cmd = expectCommand(program, ["logout"]);
      cmd.outputHelp();
      const printedHelp = write.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(printedHelp).toContain("published-chat cache");
    } finally {
      write.mockRestore();
    }
  });

  it("logout's --help discloses both exit-1 outcomes separately, including the still-signed-in one a script must not confuse with a completed sign-out", () => {
    // Regression guard for two things: (1) the old exit-code flip ("Partial
    // cleanup is still a successful sign-out ... exits 0" must not still be
    // claimed), and (2) the follow-up correction - exit 1 does NOT always
    // mean "signed out, cache failed"; a `signOut` outcome other than
    // `deleted` throws before the cache is even touched, and the user is
    // still signed in. A script branching on exit code alone needs the help
    // to say both cases exist.
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const program = buildProgram();
      const cmd = expectCommand(program, ["logout"]);
      cmd.outputHelp();
      const printedHelp = write.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(printedHelp).not.toContain("exits 0");
      // The sign-out arm must not be described as a certainty in EITHER
      // direction: `commitMutation` deletes the file before it finalizes, so a
      // failed commit can leave the user signed out after all.
      expect(printedHelp).not.toContain("STILL SIGNED IN");
      expect(printedHelp).toContain("could not be CONFIRMED");
      expect(printedHelp).toContain("may or may not still be signed in");
      expect(printedHelp).toContain("cache directory could");
    } finally {
      write.mockRestore();
    }
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

  it("host update parses --version/--force and forwards both explicit and latest requests", async () => {
    mocks.downloadCalls.length = 0;

    const explicit = buildProgram();
    explicit.exitOverride();
    await explicit.parseAsync(
      ["host", "update", "--version", "2.1.0", "--force"],
      { from: "user" },
    );

    const latest = buildProgram();
    latest.exitOverride();
    await latest.parseAsync(["host", "update"], { from: "user" });

    expect(mocks.downloadCalls).toEqual([
      { environment: "production", versionRequest: "2.1.0", automatic: false },
      { environment: "production", versionRequest: null, automatic: false },
    ]);
  });

  it("rewrites host update --version under a Node-style argv, not just a user-style one", async () => {
    // The offset used to be guessed by comparing argv[0]/argv[1] against
    // process.argv. Any caller supplying its OWN node-style prefix therefore
    // computed offset 0, the command path read as [exec, script, "host", ...],
    // the host-update check failed, and --version fell through to root - which
    // prints the CLI version instead of selecting a host version. The offset
    // now comes from Commander's `from` contract.
    mocks.downloadCalls.length = 0;

    const nodeStyle = buildProgram();
    nodeStyle.exitOverride();
    await nodeStyle.parseAsync(
      [
        "/custom/node",
        "/custom/traycer.js",
        "host",
        "update",
        "--version",
        "3.1.4",
      ],
      { from: "node" },
    );

    // Default options are node-style too, so an omitted `from` must behave the
    // same way rather than falling back to the old comparison.
    const defaultStyle = buildProgram();
    defaultStyle.exitOverride();
    await defaultStyle.parseAsync([
      "/other/node",
      "/other/traycer.js",
      "host",
      "update",
      "--version",
      "3.1.5",
    ]);

    expect(mocks.downloadCalls).toEqual([
      { environment: "production", versionRequest: "3.1.4", automatic: false },
      { environment: "production", versionRequest: "3.1.5", automatic: false },
    ]);
  });

  // Split one contract per `it`, deliberately. As a single case these eight
  // shared a `try`/`finally` and a stdout spy, so the first failure hid the
  // rest and the title named a count that had already drifted from the body.
  it("root --version prints the program version and exits zero", async () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const rootVersion = buildProgram();
      rootVersion.exitOverride();
      await expect(
        rootVersion.parseAsync(["--version"], { from: "user" }),
      ).rejects.toMatchObject({ code: "commander.version", exitCode: 0 });
      expect(write).toHaveBeenCalledWith(
        `${rootVersion.version()}\n`,
        expect.any(Function),
      );
    } finally {
      write.mockRestore();
    }
  });

  it("accepts a global option interleaved before its subcommand", async () => {
    const hostInterleaved = buildProgram();
    hostInterleaved.exitOverride();
    await expect(
      hostInterleaved.parseAsync(["host", "--json", "status"], {
        from: "user",
      }),
    ).resolves.toBeDefined();

    const configInterleaved = buildProgram();
    configInterleaved.exitOverride();
    await expect(
      configInterleaved.parseAsync(["config", "--quiet", "env", "list"], {
        from: "user",
      }),
    ).resolves.toBeDefined();
  });

  it("accepts a global option after the leaf command", async () => {
    const leafFinal = buildProgram();
    leafFinal.exitOverride();
    await expect(
      leafFinal.parseAsync(["host", "status", "--json"], { from: "user" }),
    ).resolves.toBeDefined();
  });

  it("host update forwards an explicit --version and a bare invocation as latest", async () => {
    mocks.downloadCalls.length = 0;
    const explicit = buildProgram();
    explicit.exitOverride();
    await explicit.parseAsync(["host", "update", "--version", "2.2.0"], {
      from: "user",
    });
    const bare = buildProgram();
    bare.exitOverride();
    await bare.parseAsync(["host", "update"], { from: "user" });
    expect(mocks.downloadCalls).toEqual([
      {
        environment: "production",
        versionRequest: "2.2.0",
        automatic: false,
      },
      { environment: "production", versionRequest: null, automatic: false },
    ]);
  });

  it("host update --release selects a version without the rewrite", async () => {
    // The registered spelling has to work on its own merits: nothing about
    // `--release` goes through `rewriteHostUpdateVersion`, so this pins the
    // option itself rather than the compatibility path above.
    mocks.downloadCalls.length = 0;
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["host", "update", "--release", "2.4.1"], {
      from: "user",
    });
    expect(mocks.downloadCalls).toEqual([
      { environment: "production", versionRequest: "2.4.1", automatic: false },
    ]);
  });

  it("host update --version=<v> and --release=<v> land on the same option", async () => {
    mocks.downloadCalls.length = 0;
    const inline = buildProgram();
    inline.exitOverride();
    await inline.parseAsync(["host", "update", "--version=3.0.0"], {
      from: "user",
    });
    const release = buildProgram();
    release.exitOverride();
    await release.parseAsync(["host", "update", "--release=3.0.0"], {
      from: "user",
    });
    expect(mocks.downloadCalls).toEqual([
      { environment: "production", versionRequest: "3.0.0", automatic: false },
      { environment: "production", versionRequest: "3.0.0", automatic: false },
    ]);
  });

  // An EXPLICIT empty target is a mistake, not a request for latest.
  // `--version=`, `--release=` and an unset shell variable
  // (`--release "$PIN"`) all arrive as "", and silently resolving that to
  // latest would update a machine the caller meant to pin. The pre-`--release`
  // code passed "" through to SemVer validation, which rejected it.
  it.each([
    ["--version=", ["host", "update", "--version="]],
    ["--release=", ["host", "update", "--release="]],
    ["--version ''", ["host", "update", "--version", ""]],
    ["--release ''", ["host", "update", "--release", ""]],
  ])(
    "host update rejects an explicitly empty target (%s)",
    async (_n, argv) => {
      mocks.downloadCalls.length = 0;
      const program = buildProgram();
      program.exitOverride();
      await expect(
        program.parseAsync(argv, { from: "user" }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      });
      // Crucially: it must not have fallen through to a latest-version update.
      expect(mocks.downloadCalls).toEqual([]);
    },
  );

  it("host update --version with no value errors against the real option name", async () => {
    // The whole reason the target became a registered option: a missing value
    // used to produce "option '--host-update-version <version>' argument
    // missing", naming a spelling that appears nowhere in the CLI.
    const program = buildProgram();
    program.exitOverride();
    await expect(
      program.parseAsync(["host", "update", "--version"], { from: "user" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("--release <version>"),
    });
  });

  it("config shell set passes everything after -- through untouched", async () => {
    const shellPassthrough = buildProgram();
    shellPassthrough.exitOverride();
    const shellSet = expectCommand(shellPassthrough, [
      "config",
      "shell",
      "set",
    ]);
    let observedShellArgs: readonly string[] = [];
    shellSet.action((shellArgs: readonly string[]) => {
      observedShellArgs = shellArgs;
    });
    await shellPassthrough.parseAsync(
      ["config", "shell", "set", "--", "host", "update", "--version", "2.6.0"],
      { from: "user" },
    );
    expect(observedShellArgs).toEqual(["host", "update", "--version", "2.6.0"]);
  });

  it("host update rejects a -- passthrough as excess arguments", async () => {
    const updatePassthrough = buildProgram();
    updatePassthrough.exitOverride();
    await expect(
      updatePassthrough.parseAsync(
        ["host", "update", "--", "--version", "2.6.0"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({
      code: "commander.excessArguments",
      message: expect.stringContaining("--version"),
    });
  });

  it("host update never advertises the internal --host-update-version spelling", () => {
    const program = buildProgram();
    const updateCommand = expectCommand(program, ["host", "update"]);
    expect(updateCommand.helpInformation()).not.toContain(
      "--host-update-version",
    );
  });

  it("host update registers --release as a real option", () => {
    // The version target is a REGISTERED option, not free-form help text over
    // a hidden parse flag. That is what makes it visible to schema
    // introspection and what makes its errors name a spelling the user can
    // actually type - both were the defect (`--host-update-version` leaked
    // into a missing-argument message and appeared nowhere in the command
    // tree).
    const program = buildProgram();
    const updateCommand = expectCommand(program, ["host", "update"]);
    expect(updateCommand.options.map((o) => o.long)).toContain("--release");
    const help = updateCommand.helpInformation();
    expect(help).toContain("--release <version>");
    // The internal parse flag is gone entirely - `--version` now rewrites onto
    // the registered option, so there is no hidden spelling left to leak.
    expect(help).not.toContain("--host-update-version");
    expect(updateCommand.options.map((o) => o.long)).not.toContain(
      "--host-update-version",
    );
  });

  it("host update --help documents --version as the compatibility alias", () => {
    // The published spelling the host's own spawners use has to stay
    // discoverable. It cannot be a registered option (root `--version` owns
    // that token - that collision is why the rewrite exists), so help TEXT
    // carries it and points at `--release`.
    //
    // Asserted against what `--help` actually prints, not `helpInformation()`:
    // the latter renders only the built-in sections, so `addHelpText` content
    // is invisible to it and this pin would pass while the user still saw
    // nothing.
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const program = buildProgram();
      const updateCommand = expectCommand(program, ["host", "update"]);
      updateCommand.outputHelp();
      const printedHelp = write.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(printedHelp).toContain("--version <version>");
      expect(printedHelp).toContain("Compatibility alias for --release");
    } finally {
      write.mockRestore();
    }
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

  it("host restart and host stop both expose a user-facing --force option", () => {
    // Unlike `--if-idle`, `--force` is the user's own escape hatch out of a
    // busy denial - it must be visible in `--help`, not hidden.
    const program = buildProgram();
    for (const path of [
      ["host", "restart"],
      ["host", "stop"],
    ] as const) {
      const cmd = expectCommand(program, path);
      const flags = cmd.options.map((o) => o.long);
      expect(flags, `'${path.join(" ")}' is missing '--force'`).toContain(
        "--force",
      );
      expect(cmd.helpInformation()).toContain("--force");
    }
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

  it("agent stop requires --agent-id and exposes --cascade", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["agent", "stop"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--agent-id");
    expect(flags).toContain("--cascade");
    const required = cmd.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain("--agent-id");
  });

  it("agent archive requires --agent-id and exposes --unarchive", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["agent", "archive"]);
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain("--agent-id");
    expect(flags).toContain("--unarchive");
    const required = cmd.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain("--agent-id");
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
      expect(help).not.toContain("stop [options]");
      expect(help).not.toContain("archive [options]");
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

  // `host free-port-and-restart` went public because `host doctor` prints
  // this exact command line as the fix for a port conflict - a half-typed
  // `--port` alone used to skip the kill entirely, restart the host, and
  // still exit 0 as if the conflict had been resolved. These four route
  // through the REAL registered command (`program.parseAsync`, not the
  // handler in isolation) so the guard added in `index.ts` is genuinely
  // exercised - `host-free-port-and-restart.test.ts` covers the deeper
  // lock/kill/restart wiring once the guards clear.
  it("host free-port-and-restart rejects --port without --pid, naming --pid in the message", async () => {
    const program = buildProgram();
    program.exitOverride();
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "free-port-and-restart", "--port", "51820"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: "E_INVALID_ARGUMENT",
      message: expect.stringContaining("--pid"),
    });
  });

  it("host free-port-and-restart still rejects --pid without --port (pre-existing handler guard, not regressed)", async () => {
    const program = buildProgram();
    program.exitOverride();
    let thrown: unknown = null;
    try {
      await program.parseAsync(
        ["host", "free-port-and-restart", "--pid", "4242"],
        { from: "user" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });

  it("host free-port-and-restart parses and forwards both --pid and --port as integers when both are given", async () => {
    mocks.freePortKillCalls.length = 0;
    mocks.serviceControllerCalls.length = 0;

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(
      ["host", "free-port-and-restart", "--pid", "4242", "--port", "51820"],
      { from: "user" },
    );

    expect(mocks.freePortKillCalls).toEqual([
      { pid: 4242, port: 51820, commandName: "host free-port-and-restart" },
    ]);
    expect(mocks.serviceControllerCalls).toEqual(["restart"]);
  });

  it("host free-port-and-restart parses fine with neither --pid nor --port (Desktop's bare machine call)", async () => {
    mocks.freePortKillCalls.length = 0;
    mocks.serviceControllerCalls.length = 0;

    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["host", "free-port-and-restart"], {
      from: "user",
    });

    expect(mocks.freePortKillCalls).toEqual([]);
    expect(mocks.serviceControllerCalls).toEqual(["restart"]);
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

  // CLI audit CLI-003/CLI-004/CLI-008/CLI-009/CLI-010/CLI-012: the CLI-level
  // pins for the foreground `host start` console, the new `host service
  // start` command, and the disclosure copy on the install/apply/update/
  // uninstall help text.

  it("host service start is registered, visible in 'host service --help', and wired to the shared runner", () => {
    const program = buildProgram();
    const cmd = expectCommand(program, ["host", "service", "start"]);
    expectRunnerFlags(cmd, "host service start");
    const service = expectCommand(program, ["host", "service"]);
    expect(service.helpInformation()).toContain("start [options]");
  });

  it("host start's --help names the foreground/blocking behaviour and points at 'traycer host service start', and the command itself is not hidden", () => {
    const program = buildProgram();
    const host = expectCommand(program, ["host"]);
    const start = expectCommand(program, ["host", "start"]);
    // Supported commands stay visible - only genuinely internal commands
    // (`host stamp-runtime`, `host free-port`) are hidden from `host --help`.
    expect(host.helpInformation()).toContain("start [options]");

    const help = renderedHelp(start);
    expect(help).toMatch(/foreground/i);
    expect(help).toMatch(/blocks/i);
    // Commander wraps long help lines, so "traycer host service start" can
    // land split across a wrap boundary - match tolerating whitespace
    // (including a newline + indent) between the words rather than the
    // literal substring.
    expect(help).toMatch(/traycer\s+host\s+service\s+start/);
  });

  it("host uninstall --help states both end states: the default leaves the OS service registered, and what --all does", () => {
    const program = buildProgram();
    const uninstall = expectCommand(program, ["host", "uninstall"]);
    const help = renderedHelp(uninstall);
    expect(help).toMatch(/service stays registered/i);
    expect(help).toMatch(/--all/);
    expect(help).toMatch(/deregister/i);
  });

  it("host install --help and host service install --help disclose that they start the host and can prompt for sign-in", () => {
    const program = buildProgram();
    for (const path of [
      ["host", "install"],
      ["host", "service", "install"],
    ] as const) {
      const cmd = expectCommand(program, path);
      const help = renderedHelp(cmd);
      expect(help, `'${path.join(" ")}' --help`).toMatch(/start/i);
      expect(help, `'${path.join(" ")}' --help`).toMatch(/sign-in/i);
    }
  });

  it("host apply --help and host update --help state their differing success contracts", () => {
    const program = buildProgram();
    const apply = expectCommand(program, ["host", "apply"]);
    const applyHelp = renderedHelp(apply);
    // apply: bytes committed, may not be running.
    expect(applyHelp).toMatch(/committed/i);
    expect(applyHelp).toMatch(/does NOT mean the host is\s+running/i);

    const update = expectCommand(program, ["host", "update"]);
    const updateHelp = renderedHelp(update);
    // update: exits non-zero when the host is not healthy.
    expect(updateHelp).toContain("E_HOST_UPDATE_HEALTH_CHECK_FAILED");
    expect(updateHelp).toMatch(/health-check/i);
  });
});
