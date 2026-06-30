import { z } from "zod";
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from "./log-level";

/**
 * Current on-disk schema version for `~/.traycer/cli/config.json`. Bump it
 * (and add a `migrators` entry in `./store`) whenever the shape changes in
 * a NON-additive way - purely additive keys should instead be added as
 * `.optional()`/`.default()` fields so old files keep validating without a
 * version bump. `readCliConfig` upgrades older files through the migration
 * chain before validating against this version.
 */
export const CLI_CONFIG_VERSION = 1;

export type EnvOverrideValue = string | null;

/**
 * A host-process environment override (Settings → Shell). Harness-scoped env
 * overrides are no longer stored here - they live per-provider in the host's
 * `provider-overrides.json` (Settings → Providers) so they follow the selected
 * host, while this file stays the local machine's host-process env.
 */
export interface EnvOverrideEntry {
  readonly key: string;
  readonly value: EnvOverrideValue;
}

const envOverrideMapSchema = z.record(z.string(), z.string().nullable());

/**
 * The `logs` block in `~/.traycer/cli/config.json`: two independent thresholds —
 * one for the client processes (CLI + desktop/renderer), one for the host — both
 * defaulting to `info` so a fresh install is quiet by default. Additive and
 * `.default()`-ed, so older config files that lack it keep validating; the only
 * compatibility cost is that a pre-feature binary's writer drops it on its next
 * write (the setting then resolves back to the `info` default).
 */
export const logsConfigSchema = z
  .object({
    cliLogLevel: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    hostLogLevel: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  })
  .default({ cliLogLevel: DEFAULT_LOG_LEVEL, hostLogLevel: DEFAULT_LOG_LEVEL });
export type LogsConfig = z.infer<typeof logsConfigSchema>;

/**
 * Zod schema for `~/.traycer/cli/config.json` - the single on-disk source
 * of truth for the user's shell + env-override config, shared by the CLI
 * (`traycer config …`) and the host (terminal PTY spawns, provider-CLI
 * PATH discovery). Validating through this schema on every read and write
 * is what guarantees neither side can silently corrupt the file or drift
 * from the other's expectations.
 *
 * Validates the CURRENT version only; older shapes are brought up to it by
 * `migrateCliConfig` (in `./store`) before they reach this schema.
 *
 * `shell.path === null` and `shell.args === null` both mean "fall back to
 * OS defaults" - tracked separately so a user who customised args but not
 * path (or vice versa) keeps the partial override.
 */
export const cliConfigSchema = z.object({
  version: z.literal(CLI_CONFIG_VERSION),
  // Each section defaults so a partial file (e.g. only `shell.path` set, or
  // `envOverrides` absent) still reads - restoring the tolerance the previous
  // hand-rolled reader had. Defaults fill ONLY missing/`undefined` fields;
  // a present-but-wrong-typed value (e.g. `path: 5`) is still rejected, so
  // genuine corruption is still surfaced.
  shell: z
    .object({
      path: z.string().nullable().default(null),
      args: z.array(z.string()).nullable().default(null),
    })
    .default({ path: null, args: null }),
  envOverrides: envOverrideMapSchema.default({}),
  logs: logsConfigSchema,
});

export type CliConfig = z.infer<typeof cliConfigSchema>;

/**
 * Resolved shell config consumed by both the CLI and the host's
 * `TerminalSessionManager` (every PTY spawn). `synthesised: true` means no
 * stored override existed and OS defaults were filled in - the UI surfaces
 * this as "(default - not stored)".
 */
export interface EffectiveShellConfig {
  readonly path: string;
  readonly args: readonly string[];
  readonly synthesised: boolean;
}

/**
 * A shell binary detected on the machine, surfaced as a quick-pick in the
 * Settings → Shell combobox. `path` is absolute and was verified executable
 * at detection time, except an OS default that may be a bare command name
 * (e.g. Windows `powershell.exe`). `isDefault` marks the OS-default shell so
 * the UI can sort/annotate it.
 */
export interface DetectedShell {
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
}

/**
 * Shape written when no config file exists yet. Kept schema-valid so the
 * first `writeCliConfig` after a fresh install round-trips cleanly.
 */
export const EMPTY_CLI_CONFIG: CliConfig = {
  version: CLI_CONFIG_VERSION,
  shell: { path: null, args: null },
  envOverrides: {},
  logs: { cliLogLevel: DEFAULT_LOG_LEVEL, hostLogLevel: DEFAULT_LOG_LEVEL },
};
