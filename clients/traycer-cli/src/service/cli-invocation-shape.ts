import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { CliInvocation } from "./cli-binary";

// Shape predicates over an ALREADY-REGISTERED service invocation, kept out
// of `cli-binary.ts` on purpose: every suite that exercises a registration
// path mocks that module wholesale (`provision`, `auto-bootstrap`, `ensure`,
// `install-lifecycle`), so a predicate living there would resolve to
// `undefined` inside those tests. Only the TYPE is imported here, and a
// type-only import is erased, so this module has no runtime dependency on
// the mocked one.

// Whether a registered invocation carries the self-naming leading argument
// emitted by the pre-fix packaged fallback: `<SEA> traycer host start`,
// `<SEA> /usr/local/bin/traycer host start`, `<SEA> ./traycer host start`.
// A packaged binary's `process.argv[1]` is the raw invocation spelling
// rather than an entry script, so the old fallback spliced the binary's own
// name back in as a subcommand and every launch died on
// `error: unknown command`.
//
// Recognising the shape matters because supervisors report those launches
// as SUCCESSFUL - `systemctl start` and `launchctl kickstart` return once
// the executable spawns, and Commander exits a moment later - so no
// failure-triggered repair downstream ever fires. Callers that would
// otherwise PRESERVE an existing registration verbatim (macOS `host
// update`) use this to re-resolve instead, which is what carries the fix
// onto machines that already registered a broken unit under
// `cli-v1.2.0-rc.1`.
//
// The test is inverted on purpose: PRESERVE only what can be positively
// verified as a legitimate interpreter registration - a single leading
// argument that is an existing file, distinct from the command itself.
// Everything else is either the known-broken shape or unverifiable, and
// re-resolving is the safe answer for both.
//
// Comparing lexically is not enough. `process.execPath` reports the
// RESOLVED executable while `argv[1]` keeps the raw invocation spelling, so
// a CLI reached through a differently named symlink (`tr -> /opt/traycer`)
// registered `{command: "/opt/traycer", args: ["tr"]}` - neither path-equal
// nor basename-equal to its own command. Filesystem identity catches the
// spellings that name a real path; the "not a file" arm catches the bare
// and relative ones, which cannot be an entry script under any cwd.
//
// A legitimate interpreter registration (`<node> /path/to/entry.js host
// start`) names a different existing file and is preserved. So is any
// invocation with no leading args, which is every correctly registered
// packaged CLI.
export async function isSelfNamingCliInvocation(
  cli: CliInvocation,
): Promise<boolean> {
  if (cli.args.length !== 1) return false;
  const leading = cli.args[0];
  if (leading === undefined) return false;
  if (basename(leading) === basename(cli.command)) return true;
  if (resolve(leading) === resolve(cli.command)) return true;
  const leadingReal = await realpathOrNull(leading);
  // Not a file on disk under any interpretation - it cannot be the entry
  // script a real interpreter registration would name. Note the sibling
  // reader already refuses to preserve a registration whose COMMAND has
  // gone missing; this applies the same standard to its argument.
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
