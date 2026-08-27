import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { buildProgramWithAgentRoles } from "../../index";

// CLI-006 (recovery command parseability audit): every recovery instruction
// this CLI prints - `terminalCommand` literals Desktop renders as a
// copy-paste "Open in Terminal" chip, and the `'traycer ...'` prose
// references inside message/description strings that are this codebase's
// convention for "run this" - must actually be a command `buildProgram()`
// recognizes. `traycer host install latest` was the defect: `host install`
// takes no positional (a pin is `--release <version>`), so the string Doctor
// printed for people to copy would itself fail with "too many arguments".
//
// This is a STATIC regression guard, not a snapshot of today's strings: it
// scans the real source tree on every run and validates whatever it finds
// against the real command tree, so a future recovery string that drifts
// from the command surface fails here instead of shipping.
//
// Two strictness levels:
//   - EVERYTHING (terminalCommand and prose) must resolve to a registered
//     command path, with no excess positionals and no unknown options.
//   - terminalCommand values must ADDITIONALLY parse completely, including
//     required options, because Desktop executes them verbatim. Some prose
//     references are legitimately partial (`'traycer agent stop'` omits its
//     required `--agent-id`) and are not held to that bar.

const SRC_ROOT = join(__dirname, "..", "..");

interface FoundCommand {
  readonly file: string;
  readonly raw: string;
  readonly kind: "terminalCommand" | "prose";
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

// Extracts the source text of the value bound to `terminalCommand:` - a
// string literal, a template literal, or (in `launchd-wedge.ts`) a ternary
// between two literals - by scanning characters until the enclosing
// object's depth returns to zero. Handles multi-line ternaries; a
// line-oriented regex cannot.
function extractAssignedValueSource(text: string, startIndex: number): string {
  let i = startIndex;
  let depth = 0;
  let stringQuote: '"' | "'" | null = null;
  let inTemplate = false;
  const chars: string[] = [];
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (stringQuote !== null) {
      chars.push(ch);
      if (ch === "\\") {
        chars.push(text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === stringQuote) stringQuote = null;
      i++;
      continue;
    }
    if (inTemplate) {
      chars.push(ch);
      if (ch === "\\") {
        chars.push(text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === "`") inTemplate = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      stringQuote = ch;
      chars.push(ch);
      i++;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      chars.push(ch);
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      chars.push(ch);
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) break;
      depth--;
      chars.push(ch);
      i++;
      continue;
    }
    if (ch === "," && depth === 0) break;
    chars.push(ch);
    i++;
  }
  return chars.join("");
}

// A `'traycer ...'` prose reference can be split across an adjacent
// double-quoted `"a" + "b"` concatenation purely by line-wrapping (see
// `doctor/engine.ts`'s "'traycer host " + "restart'"). Collapse those before
// scanning so the single-quoted match lands on the real command text
// instead of also swallowing the `" + "` JS syntax between the halves.
function collapseAdjacentStringConcatenation(text: string): string {
  const pattern = /"((?:[^"\\]|\\.)*)"\s*\+\s*"((?:[^"\\]|\\.)*)"/g;
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(
      pattern,
      (_match, a: string, b: string) => `"${a}${b}"`,
    );
  } while (current !== previous);
  return current;
}

// Single-quoted literals are matched too. Formatting normalises `terminalCommand`
// values to double quotes or backticks today, so omitting them looked harmless -
// but the scanner's job is to be robust to how the source is WRITTEN, not to
// today's formatter settings. A single-quoted `terminalCommand: 'traycer ...'`
// would otherwise be picked up only by the prose pass, silently dropping it from
// the strict level-2 check that Desktop's copy-paste chip actually depends on.
const STRING_OR_TEMPLATE_LITERAL =
  /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function findTerminalCommandLiterals(
  file: string,
  text: string,
): FoundCommand[] {
  const found: FoundCommand[] = [];
  const marker = "terminalCommand:";
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(marker, searchFrom);
    if (idx === -1) break;
    const valueSource = extractAssignedValueSource(text, idx + marker.length);
    for (const match of valueSource.matchAll(STRING_OR_TEMPLATE_LITERAL)) {
      found.push({ file, raw: match[0], kind: "terminalCommand" });
    }
    searchFrom = idx + marker.length;
  }
  return found;
}

const PROSE_TRAYCER_REFERENCE = /'traycer [^']*'/g;

function findProseReferences(file: string, text: string): FoundCommand[] {
  const found: FoundCommand[] = [];
  for (const match of text.matchAll(PROSE_TRAYCER_REFERENCE)) {
    found.push({ file, raw: match[0], kind: "prose" });
  }
  return found;
}

// Strips the enclosing quote/backtick pair and substitutes `${...}`
// interpolations and `<placeholder>` tokens with a concrete stand-in - "1"
// works uniformly for every pid/port/path/version/harness placeholder this
// codebase uses.
function normalizeCommandString(raw: string): string {
  const inner = raw.slice(1, -1);
  return inner
    .replace(/\$\{[^}]*\}/g, "1")
    .replace(/<[^>]*>/g, "1")
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.split(/\s+/).filter((t) => t.length > 0);
}

function neuterActions(command: Command): void {
  command.action(() => undefined);
  for (const sub of command.commands) neuterActions(sub);
}

function findSubcommand(parent: Command, name: string): Command | null {
  for (const child of parent.commands) {
    if (child.name() === name) return child;
  }
  return null;
}

// Mirrors commander's own greedy subcommand resolution: walk down while the
// next token names a registered subcommand of the current cursor.
function resolveCommandPath(
  program: Command,
  tokens: readonly string[],
): Command[] {
  const path: Command[] = [program];
  let cursor: Command = program;
  for (const token of tokens) {
    const next = findSubcommand(cursor, token);
    if (next === null) break;
    path.push(next);
    cursor = next;
  }
  return path;
}

// Bypasses "required option/argument missing" for level-1 validation, so
// only unknown options and excess positionals can fail it. Applied along
// the WHOLE resolved path: `_checkForMissingMandatoryOptions` walks command
// ancestors, so a required option on an intermediate command would
// otherwise still trip a level-1-only check.
function relaxRequiredness(path: readonly Command[]): void {
  for (const cmd of path) {
    for (const option of cmd.options) option.mandatory = false;
    for (const argument of cmd.registeredArguments) argument.required = false;
  }
}

async function parseCommand(
  tokens: readonly string[],
  opts: { readonly strict: boolean },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  // `true` so feature-flagged subtrees (e.g. `agent role list`, gated on
  // `agentRolesEnabled`) are registered - `buildProgram()` alone reads a
  // possibly-disabled feature setting, which would make this scanner's
  // validation depend on ambient config rather than the real command
  // surface.
  const program = buildProgramWithAgentRoles(true);
  neuterActions(program);
  program.exitOverride();
  program.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  if (!opts.strict) {
    relaxRequiredness(resolveCommandPath(program, tokens));
  }
  try {
    await program.parseAsync(tokens, { from: "user" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function collectCandidates(): FoundCommand[] {
  const found: FoundCommand[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const text = collapseAdjacentStringConcatenation(
      readFileSync(file, "utf8"),
    );
    found.push(...findTerminalCommandLiterals(file, text));
    found.push(...findProseReferences(file, text));
  }
  return found;
}

describe("recovery command parseability (CLI-006 regression guard)", () => {
  const candidates = collectCandidates()
    .map((c) => ({ ...c, normalized: normalizeCommandString(c.raw) }))
    .filter((c) => c.normalized.startsWith("traycer "));

  it("found at least one terminalCommand literal and one prose reference to validate", () => {
    // A guard against the scanner itself silently finding nothing (e.g. a
    // refactor renaming `terminalCommand` out from under this file) and the
    // suite below passing vacuously.
    expect(candidates.some((c) => c.kind === "terminalCommand")).toBe(true);
    expect(candidates.some((c) => c.kind === "prose")).toBe(true);
  });

  it.each(
    candidates.map((c) => [c.file, c.raw, c.kind, c.normalized] as const),
  )(
    "%s: %s (%s) resolves to a registered command path with no excess positionals or unknown options",
    async (file, raw, _kind, normalized) => {
      const tokens = tokenize(normalized).slice(1); // drop the leading "traycer"
      const result = await parseCommand(tokens, { strict: false });
      expect(
        result.ok,
        `${raw} (${file}) failed level-1 parse (resolve/positionals/options): ${
          result.ok
            ? ""
            : String(
                (result.error as { message?: string })?.message ?? result.error,
              )
        }`,
      ).toBe(true);
    },
  );

  const terminalCommands = candidates.filter(
    (c) => c.kind === "terminalCommand",
  );

  it.each(terminalCommands.map((c) => [c.file, c.raw, c.normalized] as const))(
    "%s: %s (terminalCommand) parses completely, including required options",
    async (file, raw, normalized) => {
      const tokens = tokenize(normalized).slice(1);
      const result = await parseCommand(tokens, { strict: true });
      expect(
        result.ok,
        `${raw} (${file}) is a terminalCommand and must parse completely (Desktop executes it verbatim): ${
          result.ok
            ? ""
            : String(
                (result.error as { message?: string })?.message ?? result.error,
              )
        }`,
      ).toBe(true);
    },
  );
});
