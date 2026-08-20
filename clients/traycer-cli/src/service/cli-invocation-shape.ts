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
// Deliberately narrow: exactly one leading argument that NAMES the command
// itself, by resolved path or by basename. A legitimate interpreter
// registration (`<node> /path/to/entry.js host start`) names a different
// file and is preserved, and so is any invocation with no leading args.
export function isSelfNamingCliInvocation(cli: CliInvocation): boolean {
  if (cli.args.length !== 1) return false;
  const leading = cli.args[0];
  if (leading === undefined) return false;
  return (
    resolve(leading) === resolve(cli.command) ||
    basename(leading) === basename(cli.command)
  );
}
