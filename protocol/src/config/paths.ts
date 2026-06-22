import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `~/.traycer/cli/` - the shared CLI surface. Environment-agnostic: a
 * user's shell + env config is shared between prod and dev installs. The
 * CLI (`traycer config …`) and the host (terminal PTY spawns) both read
 * and write the single `config.json` underneath it.
 *
 * Resolved with `os.homedir()` + `path.join` so it is correct on Windows
 * too - the host and CLI both run there; never hand-build `~/` strings.
 */
export function cliConfigDir(): string {
  return join(homedir(), ".traycer", "cli");
}

export function cliConfigPath(): string {
  return join(cliConfigDir(), "config.json");
}

/**
 * Deploy slot label. A free string (not a closed union) so consumers can carry
 * slots this repo doesn't ship - e.g. the internal host/CLI `staging` - without
 * a shared enum every repo must keep in lockstep. `production` is the shared
 * root for on-disk paths; any other slot nests one level deeper.
 */
export type Environment = string;

/**
 * Absolute path to the stored credentials file (the single, machine-local
 * source of truth for the signed-in user). Environment-scoped: the file embeds
 * a per-environment `authnBaseUrl` + a token minted by that authn service, so a
 * dev token is not valid against prod.
 *
 * Lives in `@traycer/protocol/config` (not the CLI's `store/paths`) because BOTH
 * the CLI - which writes it on `traycer login` - and the host - which reads
 * `user.id` from it to pin its owner (the owner-binding gate) - must resolve the
 * exact same path. The CLI re-exports this from its `store/paths` for existing
 * callers.
 */
export function cliCredentialsPath(environment: Environment): string {
  const base = cliConfigDir();
  const dir = environment === "production" ? base : join(base, environment);
  return join(dir, "credentials");
}
