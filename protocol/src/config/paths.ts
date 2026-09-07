import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `~/.traycer/cli/` - the shared CLI surface.
 * Resolved with `os.homedir()` + `path.join` so it is correct on Windows too - the host and CLI both run there; never hand-build `~/` strings.
 */
export function cliConfigDir(): string {
  return join(homedir(), ".traycer", "cli");
}

export function cliConfigPath(): string {
  return join(cliConfigDir(), "config.json");
}

/**
 * Deploy slot label.
 * A free string (not a closed union) so consumers can carry slots this repo doesn't ship - e.g. the internal host/CLI `staging` - without a shared enum every repo must keep in lockstep.
 */
export type Environment = string;

/**
 * Absolute path to the stored credentials file (the single, machine-local source of truth for the signed-in user).
 * Environment-scoped by PATH: each build's baked `environment` resolves its own file, so a dev token is never presented against prod.
 */
export function cliCredentialsPath(environment: Environment): string {
  const base = cliConfigDir();
  const dir = environment === "production" ? base : join(base, environment);
  return join(dir, "credentials");
}
