import { z } from "zod";
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from "./log-level";

/** Current on-disk schema version for `~/.traycer/cli/config.json`. */
export const CLI_CONFIG_VERSION = 1;

export type EnvOverrideValue = string | null;

/** A host-process environment override (Settings → Shell). */
export interface EnvOverrideEntry {
  readonly key: string;
  readonly value: EnvOverrideValue;
}

const envOverrideMapSchema = z.record(z.string(), z.string().nullable());

export const logsConfigSchema = z
  .object({
    cliLogLevel: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    hostLogLevel: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  })
  .default({ cliLogLevel: DEFAULT_LOG_LEVEL, hostLogLevel: DEFAULT_LOG_LEVEL });
export type LogsConfig = z.infer<typeof logsConfigSchema>;

export const featureSettingsSchema = z
  .object({
    agentRoles: z.boolean().default(false),
  })
  .default({ agentRoles: false });
export type FeatureSettings = z.infer<typeof featureSettingsSchema>;

/**
 * Zod schema for `~/.traycer/cli/config.json` - the single on-disk source of truth for the user's shell + env-override config, shared by the CLI (`traycer config …`) and the host (terminal PTY spawns, provider-CLI PATH.
 * Validating through this schema on every read and write is what guarantees neither side can silently corrupt the file or drift from the other's expectations.
 */
const shellEntrySchema = z.object({
  path: z.string(),
  args: z.array(z.string()).nullable(),
});

/** A single remembered/customised launch spec: one added program and its flags. */
export interface ShellEntry {
  readonly path: string;
  readonly args: readonly string[] | null;
}

export const cliConfigSchema = z.object({
  version: z.literal(CLI_CONFIG_VERSION),
  shell: z
    .object({
      path: z.string().nullable().default(null),
      args: z.array(z.string()).nullable().default(null),
      entries: z.array(shellEntrySchema).default([]),
    })
    .default({ path: null, args: null, entries: [] }),
  envOverrides: envOverrideMapSchema.default({}),
  logs: logsConfigSchema,
  features: featureSettingsSchema,
});

export type CliConfig = z.infer<typeof cliConfigSchema>;

/**
 * Resolved shell config consumed by both the CLI and the host's `TerminalSessionManager` (every PTY spawn).
 */
export interface EffectiveShellConfig {
  readonly path: string;
  readonly args: readonly string[];
  readonly synthesised: boolean;
}

/** An entry in the Settings → Shell picker list. */
export interface DetectedShell {
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
  readonly source: "detected" | "added";
  readonly missing: boolean;
  /**
   * Present only on a Windows `wsl.exe` row whose WSL cannot actually host a terminal.
   * Probed at list time (never persisted); absent means healthy, not probed, or not a wsl.exe row.
   */
  readonly wslHealth?: WslHealth;
}

/** See {@link DetectedShell.wslHealth}. */
export type WslHealth = "not-installed" | "no-distro";

/**
 * Shape written when no config file exists yet. Kept schema-valid so the
 * first `writeCliConfig` after a fresh install round-trips cleanly.
 */
export const EMPTY_CLI_CONFIG: CliConfig = {
  version: CLI_CONFIG_VERSION,
  shell: { path: null, args: null, entries: [] },
  envOverrides: {},
  logs: { cliLogLevel: DEFAULT_LOG_LEVEL, hostLogLevel: DEFAULT_LOG_LEVEL },
  features: { agentRoles: false },
};
