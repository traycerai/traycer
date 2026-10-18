import { validateDataRootSelection, type DataRootPlatform } from "./data-root";

/**
 * Setup-only input for choosing a data root.
 *
 * `TRAYCER_DATA_DIR` is consumed ONLY by an explicit setup selection - `traycer
 * data init`, `traycer data migrate`, and the installer's location choice - as
 * the default when no explicit destination was given. An explicit `--to` always
 * wins. Runtime (Desktop, host, ordinary CLI commands) never reads the
 * variable: it reads the persisted location record through
 * `traycerDataRoot()`, so a stale or inherited value can never move a running
 * installation.
 *
 * The environment is passed in, never read from `process.env` here, so a caller
 * has to opt in at the setup entry point.
 */

export const TRAYCER_DATA_DIR_ENV = "TRAYCER_DATA_DIR";

export type SetupDataRootSource = "flag" | "environment";

export type SetupDataRootInput =
  | { readonly kind: "none" }
  | {
      readonly kind: "selected";
      readonly source: SetupDataRootSource;
      /** Exactly what the user supplied, for "you asked for X" displays. */
      readonly requested: string;
      /** The validated, normalized root a setup command shows before committing. */
      readonly root: string;
    }
  | {
      readonly kind: "invalid";
      readonly source: SetupDataRootSource;
      readonly requested: string;
      readonly reason: string;
    };

export function parseSetupDataRootInput(input: {
  readonly explicitTo: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: DataRootPlatform;
}): SetupDataRootInput {
  if (input.explicitTo !== null) {
    return select("flag", input.explicitTo, input.platform);
  }
  const fromEnv = readEnv(input.env, input.platform);
  if (fromEnv === undefined) return { kind: "none" };
  return select("environment", fromEnv, input.platform);
}

function select(
  source: SetupDataRootSource,
  requested: string,
  platform: DataRootPlatform,
): SetupDataRootInput {
  const check = validateDataRootSelection(requested, platform);
  if (!check.ok) {
    return { kind: "invalid", source, requested, reason: check.reason };
  }
  return { kind: "selected", source, requested, root: check.root };
}

// Windows environment names are case-insensitive; a plain object copy of the
// environment keeps whatever spelling the variable was set with.
function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  platform: DataRootPlatform,
): string | undefined {
  if (platform !== "win32") return env[TRAYCER_DATA_DIR_ENV];
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === TRAYCER_DATA_DIR_ENV) return value;
  }
  return undefined;
}
