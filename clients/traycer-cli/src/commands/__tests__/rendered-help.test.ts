import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { buildProgramWithAgentRoles } from "../../index";
import { extractRunnerFlags } from "../../runner/commander-flags";

// Regression suite for the CLI command audit's "Help audit checklist"
// (epics/.../artifacts/cli-command-audit/index.md): rendered root/parent/leaf
// `--help` output must match the inventory - every supported flag/command
// visible, every internal one hidden and undocumented in user-facing text,
// and parent help enumerating exactly its intended public children.
//
// Built once per test via `buildProgramWithAgentRoles(true)` (the full agent
// surface, agent roles enabled) so `agent role` and every non-readonly-gated
// command are present.
//
// IMPORTANT - anti-tautology note: several checks below walk the LIVE
// command tree (`cmd.options`, `cmd.registeredArguments`) and verify it
// against its OWN rendered help. Those checks are real and worth having, but
// they cannot by themselves catch a flag or command that was DELETED from
// registration entirely - there is nothing left in the live tree to iterate
// once it's gone, so a walk-and-check-yourself test stays green through a
// silent removal. That is exactly what an independent review proved: deleting
// `worktree create --branch` passed the whole suite. `EXPECTED_PUBLIC_SURFACE`
// below exists specifically to close that hole - it is a hand-maintained
// literal that does NOT come from `cmd`, so removing something public has
// something fixed to disagree with.

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

function splitPath(path: string): readonly string[] {
  return path === "" ? [] : path.split(" ");
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
// for the root, every named parent, `host update`, and the full-render
// vocabulary sweep below; `helpInformation()` is used where no addHelpText
// content is in play.
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

function expectRecordDefined(
  value: Record<string, unknown> | null,
  message: string,
): Record<string, unknown> {
  if (value === null) throw new Error(message);
  return value;
}

// Commander's help sections ("Arguments:", "Options:", "Commands:") list one
// ROW per item, indented by EXACTLY two spaces before the row's own content.
// A word-wrapped CONTINUATION of a row's description is indented to the
// description column instead, which is always deeper than two spaces - so
// matching only lines with precisely a two-space indent isolates real rows
// from wrapped text. This is what makes flag/argument presence checks
// EXACT: a name only counts as "rendered" if some row's own content
// contains it, never because the string happens to appear inside a
// DIFFERENT row's flags or description - e.g. "--branch" is a literal
// substring of "--source-branch"'s own flags and of both its and
// "--carry-uncommitted"'s description text in the real `worktree create`
// help, which is exactly the false-positive an independent review caught a
// naive `help.includes("--branch")` check missing.
function parseSectionRows(
  help: string,
  heading: string,
  stopHeadings: readonly string[],
): string[] {
  const startIndex = help.indexOf(`${heading}:`);
  if (startIndex === -1) return [];
  let section = help.slice(startIndex + heading.length + 1);
  for (const stop of stopHeadings) {
    const stopIndex = section.indexOf(`\n${stop}:`);
    if (stopIndex !== -1) section = section.slice(0, stopIndex);
  }
  const rows: string[] = [];
  for (const line of section.split("\n")) {
    const match = /^ {2}(\S.*?)(?: {2,}|$)/.exec(line);
    if (match !== null) rows.push(match[1]);
  }
  return rows;
}

// Every option row's leading term is commander's own `option.flags` string
// verbatim (e.g. "-a, --all", "--workspace <path>") - confirmed by reading
// `Option#flags` against real rendered rows, not assumed. Returned AS THE
// FULL TERM, not reduced to the bare long flag: reducing to `--all` would
// let the public `-a` alias on `agent list` be deleted with nothing to
// disagree - `parseOptionRowFlagTerms(...)` would still report `--all`
// present, and a caller of `traycer agent list -a` breaks with no test
// failure. The auto-added `-h, --help` is excluded uniformly rather than
// tracked per command.
function parseOptionRowFlagTerms(help: string): string[] {
  return parseSectionRows(help, "Options", ["Commands"]).filter(
    (term) => term !== "-h, --help",
  );
}

// The "Arguments:" section lists the bare argument name (no `<>`/`[]`/
// `...`), e.g. `artifactPaths`, `terminal-id` - confirmed against real
// rendered output, not guessed. Commander OMITS the entire "Arguments:"
// heading whenever no registered argument has a non-empty description
// (`Help#visibleArguments`), so a blanked description silently removes the
// whole section - exactly the mutation verified below for the fixed
// inventory's argument check.
function parseArgumentRowNames(help: string): string[] {
  return parseSectionRows(help, "Arguments", ["Options", "Commands"]);
}

interface ExpectedArgument {
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
}

// Commander renders the SAME bare row name for `[artifactPaths]`,
// `[artifactPaths...]`, and `<artifactPaths...>` in the "Arguments:"
// section - the name alone can't tell them apart, so a name-only inventory
// entry cannot catch `comments list` silently losing its variadic (only one
// path accepted) or becoming required (breaking a no-args invocation). Both
// `.required` and `.variadic` are public fields on commander's `Argument`
// (confirmed by reading `argument.js`, not assumed).
function actualArgumentSignature(cmd: Command): readonly ExpectedArgument[] {
  return cmd.registeredArguments.map((argument) => ({
    name: argument.name(),
    required: argument.required,
    variadic: argument.variadic,
  }));
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

interface ExpectedOption {
  readonly flags: string;
  readonly mandatory: boolean;
}

interface ExpectedSurfaceEntry {
  readonly path: string;
  readonly options: readonly ExpectedOption[];
  readonly args: readonly ExpectedArgument[];
}

// The full public command surface under `buildProgramWithAgentRoles(true)` -
// every visible command path (`""` is the root itself; parents are listed
// too, so deleting a whole subtree is caught, not just a leaf), each
// command's own visible options as their FULL rendered flags term PLUS
// mandatory-ness (short alias included, e.g. `"-a, --all"`, not reduced to
// the long flag - see `parseOptionRowFlagTerms`; `.requiredOption(...)` vs
// `.option(...)` renders the IDENTICAL flags term and row, so mandatory-ness
// has to be tracked as its own fact or a required flag silently becoming
// optional - or vice versa - passes with nothing to disagree), and each
// command's registered arguments as their full name/required/variadic
// signature (see `ExpectedArgument` above) rather than just a name.
//
// THIS LITERAL IS MEANT TO BE EDITED whenever the public surface
// legitimately changes - a new command, a renamed/added/removed flag or
// alias, a flag becoming required/optional, a new positional argument, a
// changed arity. That edit is the enforcement mechanism, not a maintenance
// cost to route around: unlike everything else in this file, nothing here
// is derived from `cmd`, so it is the one check that can prove something
// disappeared or silently changed shape.
const EXPECTED_PUBLIC_SURFACE: readonly ExpectedSurfaceEntry[] = [
  {
    path: "",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "-V, --version", mandatory: false },
    ],
    args: [],
  },
  {
    path: "login",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "logout",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "whoami",
    options: [
      { flags: "--json", mandatory: false },
      // The observational mode (CLI-018): `whoami` validates and may rewrite
      // the stored credentials, so `--local` is the read that touches nothing.
      { flags: "--local", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "link-phone",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--no-qr", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "host", options: [], args: [] },
  {
    path: "host start",
    options: [
      { flags: "--cwd <path>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host capabilities",
    options: [
      { flags: "--has <capability>", mandatory: false },
      { flags: "--json", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host status",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host doctor",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host restart",
    options: [
      { flags: "--force", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host stop",
    options: [
      { flags: "--force", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "host service", options: [], args: [] },
  {
    path: "host service install",
    options: [
      { flags: "--allow-self-invocation", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-linger", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--takeover", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host service status",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host service uninstall",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host install",
    options: [
      { flags: "--allow-self-invocation", mandatory: false },
      { flags: "--force", mandatory: false },
      { flags: "--from <path>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-linger", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--no-service-register", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--release <version>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host ensure",
    options: [
      { flags: "--allow-self-invocation", mandatory: false },
      { flags: "--force", mandatory: false },
      { flags: "--from <path>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-linger", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--no-service-register", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--release <version>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host apply",
    options: [
      { flags: "--force", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host update",
    options: [
      { flags: "--force", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host download",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [{ name: "version", required: false, variadic: false }],
  },
  {
    path: "host uninstall",
    options: [
      { flags: "--all", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host available",
    options: [
      { flags: "--include-pre-releases", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-include-pre-releases", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host logs",
    options: [
      { flags: "--follow", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--tail <lines>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "host free-port-and-restart",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--pid <pid>", mandatory: false },
      { flags: "--port <port>", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "cli", options: [], args: [] },
  {
    path: "cli upgrade",
    options: [
      { flags: "--dry-run", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--target <version>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "cli re-anchor",
    options: [
      { flags: "--binary-path <path>", mandatory: true },
      { flags: "--installed-version <version>", mandatory: true },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "config", options: [], args: [] },
  { path: "config shell", options: [], args: [] },
  {
    path: "config shell get",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config shell list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config shell set",
    options: [
      { flags: "--clear-args", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--path <path>", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [{ name: "shellArgs", required: false, variadic: true }],
  },
  {
    path: "config shell add",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--path <path>", mandatory: true },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config shell remove",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--path <path>", mandatory: true },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config shell revert-args",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--path <path>", mandatory: true },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config shell reset",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "config env", options: [], args: [] },
  {
    path: "config env list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config env get",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--key <key>", mandatory: true },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config env set",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--key <key>", mandatory: true },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--value <value>", mandatory: true },
    ],
    args: [],
  },
  {
    path: "config env unset",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--key <key>", mandatory: true },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "config env delete",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--key <key>", mandatory: true },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "comments", options: [], args: [] },
  {
    path: "comments list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--status <status>", mandatory: false },
    ],
    args: [{ name: "artifactPaths", required: false, variadic: true }],
  },
  {
    path: "comments set-status",
    options: [
      { flags: "--artifact <path>", mandatory: true },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--status <status>", mandatory: true },
    ],
    args: [{ name: "threadIds", required: true, variadic: true }],
  },
  { path: "terminal", options: [], args: [] },
  {
    path: "terminal list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "terminal output",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [{ name: "terminal-id", required: true, variadic: false }],
  },
  { path: "workspace", options: [], args: [] },
  {
    path: "workspace list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "worktree", options: [], args: [] },
  {
    path: "worktree list",
    options: [
      { flags: "--cursor <worktreePath>", mandatory: false },
      { flags: "--include-activity", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--limit <n>", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "worktree delete",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--path <path>", mandatory: true },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "worktree create",
    options: [
      { flags: "--branch <branch>", mandatory: false },
      { flags: "--carry-uncommitted", mandatory: false },
      { flags: "--existing <branch>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--source-branch <branch>", mandatory: false },
      { flags: "--workspace <path>", mandatory: true },
    ],
    args: [],
  },
  { path: "agent", options: [], args: [] },
  {
    path: "agent list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "-a, --all", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent create",
    options: [
      { flags: "--cwd <path>", mandatory: false },
      { flags: "--fast", mandatory: false },
      { flags: "--harness <id>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--model <id>", mandatory: false },
      { flags: "--name <name>", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--permission-mode <mode>", mandatory: false },
      { flags: "--profile <ambient|id>", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--reasoning-effort <effort>", mandatory: false },
      { flags: "--surface <surface>", mandatory: false },
      { flags: "--workspace-entry <workspace=path>", mandatory: false },
      { flags: "--workspace-path <path>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent fork",
    options: [
      { flags: "--agent-id <id>", mandatory: true },
      { flags: "--cwd <path>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--name <name>", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--permission-mode <mode>", mandatory: false },
      { flags: "--profile <ambient|id>", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--workspace-entry <workspace=path>", mandatory: false },
      { flags: "--workspace-path <path>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent selection-guide",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent list-harnesses",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent list-harness-models",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [{ name: "harness", required: true, variadic: false }],
  },
  {
    path: "agent list-profiles",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [{ name: "harness", required: true, variadic: false }],
  },
  {
    path: "agent profile-rate-limits",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--profile <ambient|id>", mandatory: true },
      { flags: "--quiet", mandatory: false },
    ],
    args: [{ name: "harness", required: true, variadic: false }],
  },
  {
    path: "agent configure",
    options: [
      { flags: "--agent-id <id>", mandatory: true },
      { flags: "--fast", mandatory: false },
      { flags: "--harness <id>", mandatory: true },
      { flags: "--json", mandatory: false },
      { flags: "--model <id>", mandatory: true },
      { flags: "--no-progress", mandatory: false },
      { flags: "--permission-mode <mode>", mandatory: false },
      { flags: "--profile <ambient|id>", mandatory: true },
      { flags: "--quiet", mandatory: false },
      { flags: "--reasoning-effort <effort>", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent stop",
    options: [
      { flags: "--agent-id <id>", mandatory: true },
      { flags: "--cascade", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent archive",
    options: [
      { flags: "--agent-id <id>", mandatory: true },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--unarchive", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent send",
    options: [
      { flags: "--expect-reply", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--message <text>", mandatory: true },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--response-id <id>", mandatory: false },
      { flags: "--to <agentId>", mandatory: true },
    ],
    args: [],
  },
  {
    path: "agent transcript",
    options: [
      { flags: "--agent-id <id>", mandatory: true },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  { path: "agent role", options: [], args: [] },
  {
    path: "agent role claim",
    options: [
      { flags: "--agent-id <id>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
      { flags: "--role <name>", mandatory: true },
      { flags: "--scope <scope>", mandatory: true },
    ],
    args: [],
  },
  {
    path: "agent role list",
    options: [
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent role relinquish",
    options: [
      { flags: "--agent-id <id>", mandatory: false },
      { flags: "--claim-id <id>", mandatory: true },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "agent inbox",
    options: [
      { flags: "--after <createdAt:eventId>", mandatory: false },
      { flags: "--agent-id <id>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
  {
    path: "monitor",
    options: [
      { flags: "--agent-id <id>", mandatory: false },
      { flags: "--json", mandatory: false },
      { flags: "--no-progress", mandatory: false },
      { flags: "--quiet", mandatory: false },
    ],
    args: [],
  },
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

  // Anti-tautology check (see the file-level comment). Set equality both
  // ways against `EXPECTED_PUBLIC_SURFACE`, with separate MISSING vs
  // UNEXPECTED messages because they call for different reactions: missing
  // means something public disappeared (fix the regression); unexpected
  // means something new needs documenting in the literal above (update the
  // inventory) - or, if it was never meant to be public, hiding it.
  it("matches the fixed public-surface inventory exactly - nothing removed, nothing undocumented added", () => {
    const program = freshProgram();

    const actualPaths = new Set(
      allCommands(program)
        .filter(({ path }) => !isHiddenCommand(program, path))
        .map(({ path }) => path.join(" ")),
    );
    const expectedPaths = new Set(EXPECTED_PUBLIC_SURFACE.map((e) => e.path));

    const missingPaths = [...expectedPaths].filter((p) => !actualPaths.has(p));
    const unexpectedPaths = [...actualPaths].filter(
      (p) => !expectedPaths.has(p),
    );
    expect(
      missingPaths,
      `command path(s) removed or newly hidden from the public surface: ${missingPaths.join(", ")}`,
    ).toEqual([]);
    expect(
      unexpectedPaths,
      `undocumented new public command path(s) - add to EXPECTED_PUBLIC_SURFACE if intentional: ${unexpectedPaths.join(", ")}`,
    ).toEqual([]);

    for (const entry of EXPECTED_PUBLIC_SURFACE) {
      if (!actualPaths.has(entry.path)) continue; // already reported above
      const cmd = findByPath(program, splitPath(entry.path));
      const label = pathLabel(splitPath(entry.path));
      const help = cmd.helpInformation();

      // Full flags TERM (short alias included, e.g. "-a, --all"), not
      // reduced to the long flag - a deleted `-a` alias with `--all` still
      // registered must show up as a mismatch here.
      const renderedOptionTerms = new Set(parseOptionRowFlagTerms(help));
      const expectedFlagTerms = new Set(entry.options.map((o) => o.flags));
      const missingOptions = [...expectedFlagTerms].filter(
        (f) => !renderedOptionTerms.has(f),
      );
      const unexpectedOptions = [...renderedOptionTerms].filter(
        (f) => !expectedFlagTerms.has(f),
      );
      expect(
        missingOptions,
        `${label}: option row(s) removed or newly hidden from rendered help: ${missingOptions.join(", ")}`,
      ).toEqual([]);
      expect(
        unexpectedOptions,
        `${label}: undocumented new rendered option(s) - add to EXPECTED_PUBLIC_SURFACE if intentional: ${unexpectedOptions.join(", ")}`,
      ).toEqual([]);

      // Mandatory-ness has NO rendered representation at all -
      // `.requiredOption("--artifact <path>", ...)` and
      // `.option("--artifact <path>", ...)` produce the byte-identical
      // Options: row, so this can only be checked against the live `Option`
      // object's public `.mandatory` field, never parsed from text. Flipping
      // a required flag to optional (or vice versa) changes the public CLI
      // contract with nothing in rendered help to disagree - for
      // `--artifact` specifically it would let the `opts.artifact ?? ""`
      // empty-string fallback in `index.ts` reach the RPC.
      const mandatoryMismatches = entry.options
        .map((expectedOption) => {
          const actualOption = cmd.options.find(
            (option) => option.flags === expectedOption.flags,
          );
          return actualOption === undefined ||
            actualOption.mandatory === expectedOption.mandatory
            ? null
            : `${expectedOption.flags} (expected mandatory=${expectedOption.mandatory}, actual=${actualOption.mandatory})`;
        })
        .filter((entryLabel): entryLabel is string => entryLabel !== null);
      expect(
        mandatoryMismatches,
        `${label}: option mandatory-ness changed: ${mandatoryMismatches.join(", ")}`,
      ).toEqual([]);

      // Full argument SIGNATURE (name + required + variadic), not just the
      // name - commander renders the identical bare row name for
      // `[artifactPaths]`, `[artifactPaths...]`, and `<artifactPaths...>`,
      // so a name-only comparison can't catch an arity change (e.g.
      // `comments list` silently losing its "many paths" variadic, or
      // becoming required). Compared via a canonical string key so a
      // mismatch reports which exact signature is missing/unexpected
      // rather than just a name.
      const argumentKey = (arg: ExpectedArgument): string =>
        `${arg.name} (required=${arg.required}, variadic=${arg.variadic})`;
      const actualArgs = new Set(actualArgumentSignature(cmd).map(argumentKey));
      const expectedArgs = new Set(entry.args.map(argumentKey));
      const missingArgs = [...expectedArgs].filter((a) => !actualArgs.has(a));
      const unexpectedArgs = [...actualArgs].filter(
        (a) => !expectedArgs.has(a),
      );
      expect(
        missingArgs,
        `${label}: argument signature(s) removed or changed from rendered help: ${missingArgs.join(", ")}`,
      ).toEqual([]);
      expect(
        unexpectedArgs,
        `${label}: undocumented new/changed rendered argument signature(s) - add to EXPECTED_PUBLIC_SURFACE if intentional: ${unexpectedArgs.join(", ")}`,
      ).toEqual([]);
    }
  });

  // Defense-in-depth alongside the fixed inventory above: this walks the
  // LIVE tree (so it also covers anything not yet added to
  // EXPECTED_PUBLIC_SURFACE) but checks EXACT row membership rather than
  // substring presence anywhere in the text - `option.flags` / an
  // argument's `.name()` must appear as some row's own content, not merely
  // somewhere in the rendered string. A bare `help.includes(...)` check
  // (the prior version of this test) is fooled by "--branch" appearing
  // inside "--source-branch"'s own flags/description, and by an argument
  // name that's already present in the auto-generated `Usage:` line even
  // when its "Arguments:" row is gone.
  it("renders every non-hidden option and every registered argument as an actual row - not merely present somewhere in the text", () => {
    const program = freshProgram();
    for (const { path, cmd } of allCommands(program)) {
      const help = cmd.helpInformation();
      const renderedOptionTerms = parseSectionRows(help, "Options", [
        "Commands",
      ]);
      for (const option of cmd.options) {
        if (option.hidden) continue;
        expect(
          renderedOptionTerms.includes(option.flags),
          `${pathLabel(path)}: no OPTION ROW for '${option.flags}' (a substring match elsewhere in the help text does not count)`,
        ).toBe(true);
      }
      const renderedArgumentNames = parseArgumentRowNames(help);
      for (const argument of cmd.registeredArguments) {
        expect(
          renderedArgumentNames.includes(argument.name()),
          `${pathLabel(path)}: no ARGUMENT ROW for '${argument.name()}' (its presence in 'Usage:' does not count)`,
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

  // Full-render vocabulary sweep (not field-by-field): `renderHelp(cmd)` is
  // the REAL `--help` output, which naturally covers descriptions, option
  // descriptions, argument descriptions, commander-generated content, AND
  // `addHelpText` blocks in one pass - a field-by-field scan of
  // `cmd.description()`/`option.description`/`argument.description` misses
  // addHelpText entirely (confirmed: banned text added to `host update`'s
  // addHelpText block passes a field-by-field scan silently). Hidden
  // commands' text is absent from a render by construction (nothing to
  // render), so this stays correct without a separate skip list beyond the
  // `isHiddenCommand` filter already needed to know which commands are
  // public.
  it("keeps internal vocabulary out of every visible command's FULL rendered --help", () => {
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
      const rendered = renderHelp(cmd);
      for (const [pattern, label] of banned) {
        expect(
          pattern.test(rendered),
          `${pathLabel(path)}: rendered --help leaks '${label}'`,
        ).toBe(false);
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

    // The compatibility vector `--no-bootstrap`'s own comment describes:
    // Desktop's `discoverCli()` may place the flag BEFORE the subcommand
    // (`traycer --no-bootstrap host status`), binding to the root's global
    // copy rather than the leaf's own. The prior test only covers the
    // after-command spelling and only proves the action ran - this asserts
    // the actual runtime signal (`optsWithGlobals()` /
    // `extractRunnerFlags(...)`) a real command body reads.
    it("--no-bootstrap placed BEFORE the subcommand binds through the root's global copy", async () => {
      const program = freshProgram();
      program.exitOverride();
      const hostStatus = findByPath(program, ["host", "status"]);
      let observedOpts: Record<string, unknown> | null = null;
      hostStatus.action((...actionArgs: unknown[]) => {
        const command = actionArgs[actionArgs.length - 1] as Command;
        observedOpts = command.optsWithGlobals() as Record<string, unknown>;
      });
      await program.parseAsync(["--no-bootstrap", "host", "status"], {
        from: "user",
      });
      const opts = expectRecordDefined(
        observedOpts,
        "expected 'host status' action to run and capture opts",
      );
      expect(opts.bootstrap).toBe(false);
      expect(extractRunnerFlags(opts).noBootstrap).toBe(true);
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
