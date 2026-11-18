import type { Command } from "commander";

export function neuterActions(command: Command): void {
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
export function resolveCommandPath(
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
// only unknown options and excess positionals can fail it. Applied along the
// WHOLE resolved path: `_checkForMissingMandatoryOptions` walks command
// ancestors, so a required option on an intermediate command would
// otherwise still trip a level-1-only check.
export function relaxRequiredness(path: readonly Command[]): void {
  for (const cmd of path) {
    for (const option of cmd.options) option.mandatory = false;
    for (const argument of cmd.registeredArguments) argument.required = false;
  }
}

export async function parseCommand(
  program: Command,
  tokens: readonly string[],
  opts: { readonly strict: boolean },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (!opts.strict) relaxRequiredness(resolveCommandPath(program, tokens));
  try {
    await program.parseAsync(tokens, { from: "user" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
