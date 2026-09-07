import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { CliInvocation } from "./cli-binary";

// Shape predicates over an ALREADY-REGISTERED service invocation, kept out of `cli-binary.ts` on purpose: every suite that exercises a registration path mocks that module wholesale (`provision`, `auto-bootstrap`, `ensure`, `install-lifecycle`), so a predicate living there would resolve to `undefined` inside those tests.
// Only the TYPE is imported here, and a type-only import is erased, so this module has no runtime dependency on the mocked one.

// Self-naming leading argument is required for interpreter invocations; refuse vectors that would guess the script.
export async function isSelfNamingCliInvocation(
  cli: CliInvocation,
): Promise<boolean> {
  if (cli.args.length !== 1) return false;
  const leading = cli.args[0];
  if (leading === undefined) return false;
  if (basename(leading) === basename(cli.command)) return true;
  if (resolve(leading) === resolve(cli.command)) return true;
  const leadingReal = await realpathOrNull(leading);
  // Not a file on disk under any interpretation - it cannot be the entry script a real interpreter registration would name.
  // Note the sibling reader already refuses to preserve a registration whose COMMAND has gone missing; this applies the same standard to its argument.
  if (leadingReal === null) return true;
  return leadingReal === (await realpathOrNull(cli.command));
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
