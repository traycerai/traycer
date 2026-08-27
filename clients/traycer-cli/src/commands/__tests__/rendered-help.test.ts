import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { buildProgramWithAgentRoles } from "../../index";

// Regression suite for the CLI command audit's "Help audit checklist"
// (epics/.../artifacts/cli-command-audit/index.md): rendered root/parent/leaf
// `--help` output must match the inventory - every supported flag/command
// visible, every internal one hidden and undocumented in user-facing text,
// and parent help enumerating exactly its intended public children.
//
// Built once per test via `buildProgramWithAgentRoles(true)` (the full agent
// surface, agent roles enabled) so `agent role` and every non-readonly-gated
// command are present.

interface TreeEntry {
  readonly path: readonly string[];
  readonly cmd: Command;
}

function walk(cmd: Command, path: readonly string[], acc: TreeEntry[]): void {
  acc.push({ path, cmd });
  for (const child of cmd.commands) {
    walk(child, [...path, child.name()], acc);
  }
}

function allCommands(root: Command): TreeEntry[] {
  const acc: TreeEntry[] = [];
  walk(root, [], acc);
  return acc;
}

function pathLabel(path: readonly string[]): string {
  return path.length === 0 ? "traycer" : `traycer ${path.join(" ")}`;
}

function findByPath(root: Command, path: readonly string[]): Command {
  let cursor = root;
  for (const segment of path) {
    const next = cursor.commands.find((child) => child.name() === segment);
    if (next === undefined) {
      throw new Error(`command not found: ${pathLabel(path)}`);
    }
    cursor = next;
  }
  return cursor;
}

// Public Help API - `createHelp().visibleCommands(cmd)` is what commander's
// own help renderer calls to decide what to list, so it's the supported way
// to ask "is this subcommand hidden" rather than reading `Command`'s private
// `_hidden` field. `Option#hidden` (used below) is a public field already -
// no equivalent workaround needed for options.
function hiddenChildren(cmd: Command): Command[] {
  const visible = cmd.createHelp().visibleCommands(cmd);
  return cmd.commands.filter((child) => !visible.includes(child));
}

function visibleChildren(cmd: Command): Command[] {
  const visible = cmd.createHelp().visibleCommands(cmd);
  return cmd.commands.filter((child) => visible.includes(child));
}

function isHiddenCommand(root: Command, path: readonly string[]): boolean {
  if (path.length === 0) return false;
  const parent = findByPath(root, path.slice(0, -1));
  return hiddenChildren(parent).includes(findByPath(root, path));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Boundary-safe "is this command name listed" check. A bare `.includes()`
// would let `free-port` (hidden) false-match inside `free-port-and-restart`
// (visible) - exactly the trap the audit's spot check calls out.
function helpListsCommandName(help: string, name: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(name)}(\\s|\\[|$)`, "m").test(help);
}

// Real-render helper: `helpInformation()` renders only commander's built-in
// sections and omits `addHelpText` blocks entirely (e.g. `host update`'s
// public `--version <version>` spelling, which exists ONLY as addHelpText
// because the registered option would collide with root `--version`). Used
// for the root, every named parent, and `host update` below, per the task's
// rendering caveat; `helpInformation()` is used for the bulk per-leaf sweep,
// where no addHelpText content is in play.
function renderHelp(cmd: Command): string {
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

function freshProgram(): Command {
  return buildProgramWithAgentRoles(true);
}

const NAMED_PARENT_PATHS: ReadonlyArray<readonly string[]> = [
  ["host"],
  ["host", "service"],
  ["cli"],
  ["config"],
  ["config", "shell"],
  ["config", "env"],
  ["comments"],
  ["terminal"],
  ["workspace"],
  ["worktree"],
  ["agent"],
  ["agent", "role"],
];

describe("rendered root/parent/leaf --help (CLI command audit regression suite)", () => {
  it("cross-checks the hidden-command helper against a known-hidden and a known-visible command", () => {
    const program = freshProgram();
    const host = findByPath(program, ["host"]);
    expect(hiddenChildren(host).map((c) => c.name())).toContain("purge-stage");
    expect(visibleChildren(host).map((c) => c.name())).toContain("status");
    expect(hiddenChildren(host).map((c) => c.name())).not.toContain("status");
    expect(visibleChildren(host).map((c) => c.name())).not.toContain(
      "purge-stage",
    );
  });

  it("prints every non-hidden option's flags, and every registered argument's name, in that command's own rendered help", () => {
    const program = freshProgram();
    for (const { path, cmd } of allCommands(program)) {
      const help = cmd.helpInformation();
      for (const option of cmd.options) {
        if (option.hidden) continue;
        if (option.long) {
          expect(
            help.includes(option.long),
            `${pathLabel(path)}: rendered help is missing '${option.long}'`,
          ).toBe(true);
        }
        if (option.short) {
          expect(
            help.includes(option.short),
            `${pathLabel(path)}: rendered help is missing '${option.short}'`,
          ).toBe(true);
        }
      }
      // Commander's `Arguments:` section lists the BARE name (no `<>`/`[]`/
      // `...`), e.g. `artifactPaths`, not `[artifactPaths...]` - confirmed by
      // inspecting `helpInformation()` output directly rather than guessing.
      for (const argument of cmd.registeredArguments) {
        expect(
          help.includes(argument.name()),
          `${pathLabel(path)}: rendered help is missing registered argument '${argument.name()}'`,
        ).toBe(true);
      }
    }
  });

  it("lists every visible subcommand and none of the hidden ones, per named parent", () => {
    const program = freshProgram();
    for (const path of NAMED_PARENT_PATHS) {
      const parent = findByPath(program, path);
      const help = parent.helpInformation();
      for (const child of visibleChildren(parent)) {
        expect(
          helpListsCommandName(help, child.name()),
          `${pathLabel(path)}: rendered help is missing visible subcommand '${child.name()}'`,
        ).toBe(true);
      }
      for (const child of hiddenChildren(parent)) {
        expect(
          helpListsCommandName(help, child.name()),
          `${pathLabel(path)}: rendered help leaks hidden subcommand '${child.name()}'`,
        ).toBe(false);
      }
    }
  });

  it("real --help render for the root and every named parent agrees with the subcommand listing", () => {
    const program = freshProgram();
    for (const path of [[], ...NAMED_PARENT_PATHS] as ReadonlyArray<
      readonly string[]
    >) {
      const cmd = findByPath(program, path);
      const real = renderHelp(cmd);
      for (const child of visibleChildren(cmd)) {
        expect(
          helpListsCommandName(real, child.name()),
          `${pathLabel(path)}: real --help render is missing visible subcommand '${child.name()}'`,
        ).toBe(true);
      }
      for (const child of hiddenChildren(cmd)) {
        expect(
          helpListsCommandName(real, child.name()),
          `${pathLabel(path)}: real --help render leaks hidden subcommand '${child.name()}'`,
        ).toBe(false);
      }
    }
  });

  it("host update --help (real render) shows the public '--version <version>' spelling and never the internal '--host-update-version' spelling", () => {
    const program = freshProgram();
    const hostUpdate = findByPath(program, ["host", "update"]);
    const help = renderHelp(hostUpdate);
    expect(help).toContain("--version <version>");
    expect(help).toContain("Update to this exact registry version");
    expect(help).not.toContain("--host-update-version");
  });

  // Encodes the standing user policy: every supported user-facing/invocable
  // command and flag must appear in rendered help. Hidden visibility must
  // not paper over confusing public behavior - genuinely machine-only
  // callbacks and service-manager entrypoints may stay hidden ONLY when
  // they are explicitly unsupported for direct users and are
  // tested/documented as machine contracts (which is exactly what every
  // entry below is). THIS TEST MUST BE UPDATED whenever the hidden surface
  // legitimately changes - that update is the enforcement mechanism, not a
  // maintenance cost to route around.
  it("hides exactly the allowlisted commands - nothing more, nothing less", () => {
    const program = freshProgram();
    const hiddenCommandPaths = allCommands(program)
      .filter(({ path }) => isHiddenCommand(program, path))
      .map(({ path }) => path.join(" "))
      .sort();

    expect(hiddenCommandPaths).toEqual(
      [
        "host purge-stage",
        "host stamp-runtime",
        "host free-port",
        "cli mark-source",
        "cli finalize-upgrade",
        "agent title-from-hook",
        "agent activity-from-hook",
        "agent turn-ended-from-hook",
        "agent session-observed-from-hook",
      ].sort(),
    );
  });

  it("hides exactly the allowlisted options on visible commands (--no-bootstrap aside)", () => {
    const program = freshProgram();
    const hiddenOptionEntries = allCommands(program)
      .flatMap(({ path, cmd }) =>
        cmd.options
          .filter((option) => option.hidden && option.long !== "--no-bootstrap")
          .map((option) => `${pathLabel(path)} ${option.long}`),
      )
      .sort();

    expect(hiddenOptionEntries).toEqual(
      [
        "traycer login --token",
        "traycer host start --service-label",
        "traycer host start --transition-id",
        "traycer host start --probe-nonce",
        "traycer host restart --if-idle",
        "traycer host install --if-idle",
        "traycer host apply --expected-stage-fingerprint",
        "traycer host apply --no-service",
        "traycer host update --host-update-version",
        "traycer host download --automatic",
      ].sort(),
    );
  });

  it("hides --no-bootstrap on the root and on every runner-backed leaf, and nowhere else", () => {
    const program = freshProgram();
    const allEntries = allCommands(program);

    // "Runner-backed" is derived programmatically as "carries the shared
    // --json flag", with `host capabilities` carved out: its --json is a
    // distinct raw machine-contract flag registered directly (not via
    // `addRunnerFlags`), so it never gets --no-bootstrap either.
    const runnerBackedPaths = allEntries
      .filter(
        ({ path, cmd }) =>
          cmd.options.some((option) => option.long === "--json") &&
          pathLabel(path) !== "traycer host capabilities",
      )
      .map(({ path }) => pathLabel(path))
      .sort();

    const noBootstrapPaths = allEntries
      .filter(({ cmd }) =>
        cmd.options.some(
          (option) => option.long === "--no-bootstrap" && option.hidden,
        ),
      )
      .map(({ path }) => pathLabel(path))
      .sort();

    expect(noBootstrapPaths).toEqual(runnerBackedPaths);
    expect(
      findByPath(program, ["host", "capabilities"]).options.some(
        (option) => option.long === "--no-bootstrap",
      ),
    ).toBe(false);
  });

  it("keeps internal vocabulary out of every visible command's description, its visible options' descriptions, and its registered arguments' descriptions", () => {
    const program = freshProgram();
    // Deliberately does NOT blocklist "bootstrap" (host start's description
    // is owned by another in-flight PR) or "NDJSON" (a real format name).
    const banned: ReadonlyArray<readonly [RegExp, string]> = [
      [/Internal:/, "Internal:"],
      [/config surface/i, "config surface"],
      [/host supervisor/i, "host supervisor"],
      [/calling agent/i, "calling agent"],
      [/\bepics?\b/i, "epic(s)"],
    ];

    for (const { path, cmd } of allCommands(program)) {
      if (isHiddenCommand(program, path)) continue;
      const description = cmd.description();
      for (const [pattern, label] of banned) {
        expect(
          pattern.test(description),
          `${pathLabel(path)}: description leaks '${label}': "${description}"`,
        ).toBe(false);
      }
      for (const option of cmd.options) {
        if (option.hidden) continue;
        for (const [pattern, label] of banned) {
          expect(
            pattern.test(option.description),
            `${pathLabel(path)} ${option.long}: description leaks '${label}': "${option.description}"`,
          ).toBe(false);
        }
      }
      // Positional argument descriptions are rendered help text too
      // (`comments list [artifactPaths...]`, `terminal output <terminal-id>`,
      // etc.) - a regression here (e.g. "this epic" instead of "this Task")
      // is exactly as user-visible as one in an option description, so it
      // gets the same blocklist. `registeredArguments` is commander's public
      // accessor for this - not an internal field.
      for (const argument of cmd.registeredArguments) {
        for (const [pattern, label] of banned) {
          expect(
            pattern.test(argument.description),
            `${pathLabel(path)} ${argument.name()}: description leaks '${label}': "${argument.description}"`,
          ).toBe(false);
        }
      }
    }
  });

  describe("public-surface spot checks", () => {
    it("root --help never advertises --no-bootstrap", () => {
      const program = freshProgram();
      const help = renderHelp(program);
      expect(help).not.toContain("--no-bootstrap");
    });

    it("--no-bootstrap still parses even though it is hidden (Desktop's discoverCli() slot depends on this)", async () => {
      const program = freshProgram();
      program.exitOverride();
      // Override the real action so this stays a parse-layer assertion -
      // it must not dial a host in this test process. If --no-bootstrap
      // were an unknown option, commander would throw before this action
      // ever runs.
      const hostStatus = findByPath(program, ["host", "status"]);
      let actionRan = false;
      hostStatus.action(() => {
        actionRan = true;
      });
      await program.parseAsync(["host", "status", "--no-bootstrap"], {
        from: "user",
      });
      expect(actionRan).toBe(true);
    });

    it("login --help omits --token while the option itself is still registered (the Desktop contract survives)", () => {
      const program = freshProgram();
      const login = findByPath(program, ["login"]);
      expect(login.helpInformation()).not.toContain("--token");
      expect(login.options.some((option) => option.long === "--token")).toBe(
        true,
      );
    });

    it("host --help lists 'free-port-and-restart' and not the bare 'free-port' (false-match guard)", () => {
      const program = freshProgram();
      const help = renderHelp(findByPath(program, ["host"]));
      expect(help).toContain("free-port-and-restart");
      expect(help).not.toContain("free-port ");
    });

    it("the root and named-parent descriptions use the new user-language wording", () => {
      const program = freshProgram();
      expect(program.description()).toContain(
        "sign in, run the Traycer host on this machine",
      );
      expect(findByPath(program, ["host"]).description()).toContain(
        "Install, run, update, and troubleshoot the Traycer host",
      );
      expect(findByPath(program, ["host", "service"]).description()).toContain(
        "background registration that keeps the host running",
      );
      expect(findByPath(program, ["cli"]).description()).toContain(
        "Update the 'traycer' command itself",
      );
      expect(findByPath(program, ["config"]).description()).toContain(
        "Read or change the Traycer settings stored on this machine",
      );
      expect(findByPath(program, ["config", "shell"]).description()).toContain(
        "Choose the shell Traycer uses",
      );
      expect(findByPath(program, ["config", "env"]).description()).toContain(
        "Environment variables Traycer adds",
      );
      expect(findByPath(program, ["workspace"]).description()).toContain(
        "Show the folders an agent in this Task can work in",
      );
      expect(findByPath(program, ["agent"]).description()).toContain(
        "List, inspect, message, and manage the other agents in this Task",
      );
      expect(findByPath(program, ["agent", "role"]).description()).toContain(
        "Claim, list, and relinquish the named roles",
      );
    });

    it("comments list/set-status --help say relative artifact paths are resolved against the current directory", () => {
      const program = freshProgram();
      // Commander word-wraps long option/argument descriptions across
      // lines, so the sentence can be split by a newline in the rendered
      // text even though it reads as one line in source - collapse
      // whitespace before matching rather than asserting on a raw
      // multi-line substring.
      const normalize = (text: string): string => text.replace(/\s+/g, " ");
      const list = normalize(
        renderHelp(findByPath(program, ["comments", "list"])),
      );
      const setStatus = normalize(
        renderHelp(findByPath(program, ["comments", "set-status"])),
      );
      const expectedWording =
        "relative to the current directory (resolved before the request)";
      expect(list).toContain(expectedWording);
      expect(setStatus).toContain(expectedWording);
    });

    // Belt-and-braces duplicate of the generic internal-vocabulary sweep
    // above: this is a proven regression (CLI-005 walked right back in via
    // `comments list`'s `[artifactPaths...]` argument description reverting
    // to "this epic"), and the generic sweep's failure message names the
    // command path but not what the wording SHOULD say. This one points
    // straight at the finding.
    it("comments list's [artifactPaths...] argument says 'this Task', never 'epic' (CLI-005 regression)", () => {
      const program = freshProgram();
      const list = findByPath(program, ["comments", "list"]);
      const argument = list.registeredArguments.find(
        (candidate) => candidate.name() === "artifactPaths",
      );
      expect(
        argument,
        "expected 'comments list' to register an 'artifactPaths' argument",
      ).toBeDefined();
      const description = argument?.description ?? "";
      expect(description).toContain("this Task");
      expect(description).not.toMatch(/\bepics?\b/i);
    });
  });
});
