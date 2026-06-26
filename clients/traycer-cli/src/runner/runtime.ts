import type { Environment } from "./environment";
import { config } from "../config";
import { createCliLogger, type ILogger } from "../logger";

// Single centralised read of `process.env` typed as the readonly env map
// every runner-aware code path consumes. Threading this through one
// helper keeps the cast off random call sites and keeps the runtime
// boundary obvious - production code passes `readonlyEnv()`, tests pass
// an explicit map.
export function readonlyEnv(): Readonly<Record<string, string | undefined>> {
  return process.env as Readonly<Record<string, string | undefined>>;
}

// Raw flag inputs as parsed by commander, before defaults/env are folded
// in. `null` means "the user did not set this flag" so the resolver can
// distinguish unset from explicit-false.
export interface RawRunnerFlags {
  readonly json: boolean | null;
  readonly quiet: boolean | null;
  readonly noProgress: boolean | null;
  readonly noBootstrap: boolean | null;
}

// The post-resolution runtime context every command function consults.
// All flags collapse to booleans/enums here; downstream code doesn't
// re-read process.env or argv.
export interface RuntimeContext {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly noProgress: boolean;
  readonly noBootstrap: boolean;
  readonly nonInteractive: boolean;
  readonly environment: Environment;
  readonly logger: ILogger;
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "" || value === "0" || value === "false") return false;
  return true;
}

// Builds the runtime context from parsed flags + the process env.
//
// - CI=1 OR TRAYCER_NONINTERACTIVE=1 → nonInteractive=true AND implies
//   noProgress=true (avoids progress spam in CI logs; future install
//   commands will also skip stdin prompts).
// - The environment (deployment slot) is `config.environment`, baked per build -
//   there is no flag or env for it.
export function resolveRuntimeContext(
  flags: RawRunnerFlags,
  env: Readonly<Record<string, string | undefined>>,
): RuntimeContext {
  const nonInteractive = envFlag(env.CI) || envFlag(env.TRAYCER_NONINTERACTIVE);
  const environment: Environment = config.environment;
  return {
    json: flags.json === true,
    quiet: flags.quiet === true,
    noProgress: flags.noProgress === true || nonInteractive,
    noBootstrap: flags.noBootstrap === true,
    nonInteractive,
    environment,
    logger: createCliLogger(environment),
  };
}
