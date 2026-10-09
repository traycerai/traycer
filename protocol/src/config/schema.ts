import { z } from "zod";
import { LOG_LEVELS, DEFAULT_LOG_LEVEL } from "./log-level";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

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

const envOverrideMapSchema = lazySchema(() =>
  z.record(z.string(), z.string().nullable()),
);

/**
 * The `logs` block in `~/.traycer/cli/config.json`: two independent thresholds —
 * one for the client processes (CLI + desktop/renderer), one for the host — both
 * defaulting to `info` so a fresh install is quiet by default. Additive and
 * `.default()`-ed, so older config files that lack it keep validating; the only
 * compatibility cost is that a pre-feature binary's writer drops it on its next
 * write (the setting then resolves back to the `info` default).
 */
export const logsConfigSchema = lazySchema(() =>
  z
    .object({
      cliLogLevel: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
      hostLogLevel: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    })
    .default({
      cliLogLevel: DEFAULT_LOG_LEVEL,
      hostLogLevel: DEFAULT_LOG_LEVEL,
    }),
);
export type LogsConfig = z.infer<typeof logsConfigSchema>;

/**
 * The `browser` block in `~/.traycer/cli/config.json`: the machine-user-global
 * switch for whether agents may drive the in-app browser. Defaults to `true` -
 * the capability existed before the switch did, so an install that has never
 * touched Settings keeps the behaviour it already had. Additive and
 * `.default()`-ed like every other block, so older config files keep validating
 * without a `CLI_CONFIG_VERSION` bump.
 */
export const browserConfigSchema = lazySchema(() =>
  z
    .object({
      agentAccess: z.boolean().default(true),
    })
    .default({ agentAccess: true }),
);
export type BrowserConfig = z.infer<typeof browserConfigSchema>;

/**
 * The `browser` block read on its own, ignoring every other key.
 *
 * `readBrowserConfigSync` validates with THIS rather than `cliConfigSchema`
 * because whole-document validation makes an unrelated defect revoke a
 * deliberate setting: a `version` this binary predates, or a block a newer
 * writer reshaped, fails the document and would send the gate to its
 * permissive default while the file plainly says `agentAccess: false`. Failing
 * open is for a block we cannot read, never for one we can.
 */
export const browserOnlyConfigSchema = lazySchema(() =>
  z.object({
    browser: browserConfigSchema,
  }),
);

/**
 * What an agent's `traycer_create_worktree` call does on this machine:
 * `allow` creates the worktree, `ask` puts the request to the user in the
 * calling agent's chat first, `never` refuses it. Worktrees the user creates
 * themselves are not governed by it.
 */
export const AGENT_WORKTREE_CREATE_POLICIES = [
  "allow",
  "ask",
  "never",
] as const;
export type AgentWorktreeCreatePolicy =
  (typeof AGENT_WORKTREE_CREATE_POLICIES)[number];

/**
 * The `worktrees` block in `~/.traycer/cli/config.json`: the
 * machine-user-global policy for worktrees agents create. Defaults to `allow` -
 * agents could create worktrees before the policy existed, so an install that
 * has never touched Settings keeps that behaviour. Additive and `.default()`-ed
 * like every other block, so older config files keep validating without a
 * `CLI_CONFIG_VERSION` bump.
 */
export const worktreesConfigSchema = lazySchema(() =>
  z
    .object({
      agentCreate: z.enum(AGENT_WORKTREE_CREATE_POLICIES).default("allow"),
    })
    .default({ agentCreate: "allow" }),
);
export type WorktreesConfig = z.infer<typeof worktreesConfigSchema>;

/**
 * The `worktrees` block read on its own, ignoring every other key - for the
 * same reason as `browserOnlyConfigSchema`: an unrelated defect elsewhere in
 * the document must not send the gate to its permissive default while the file
 * plainly says `agentCreate: "never"`.
 */
export const worktreesOnlyConfigSchema = lazySchema(() =>
  z.object({
    worktrees: worktreesConfigSchema,
  }),
);

/**
 * Bounds of `catalog.probeTimeoutSeconds`, in whole seconds. The default is
 * the bound the host used before the setting existed, so an install that has
 * never touched Settings behaves as before; it is also the floor, because a
 * shorter bound only makes honest catalog reads fail (and would undercut an
 * adapter's own discovery deadline). The ceiling covers the slowest read an
 * adapter can make on its own (OpenCode: a 30 s server start plus a 120 s
 * request) - a longer bound buys nothing and holds a shared probe slot longer.
 * They travel on the wire as data (`config.catalog.get`), so the GUI never
 * offers a value the host refuses and they can move without a protocol change.
 */
export const CATALOG_PROBE_TIMEOUT_DEFAULT_SECONDS = 60;
export const CATALOG_PROBE_TIMEOUT_MIN_SECONDS = 60;
export const CATALOG_PROBE_TIMEOUT_MAX_SECONDS = 180;

/**
 * Clamps a stored catalog probe timeout into the supported range. A
 * hand-edited value outside it is clamped on read, never rejected: the setting
 * only tunes a wait, and refusing the whole file over it would be worse.
 */
export function clampCatalogProbeTimeoutSeconds(seconds: number): number {
  return Math.min(
    CATALOG_PROBE_TIMEOUT_MAX_SECONDS,
    Math.max(CATALOG_PROBE_TIMEOUT_MIN_SECONDS, seconds),
  );
}

/**
 * The `catalog` block in `~/.traycer/cli/config.json`: how long the host waits
 * for a provider to list its models or commands. Additive and `.default()`-ed
 * like every other block, so older config files keep validating without a
 * `CLI_CONFIG_VERSION` bump. Any positive whole number parses; the range is
 * applied by `clampCatalogProbeTimeoutSeconds` on read and enforced by the
 * host on write.
 *
 * `probeTimeoutSeconds` is the value shared by every provider; `overrides`
 * holds a provider's own value, keyed by harness id, for the providers whose
 * "Same for all providers" switch is off. A provider without an entry follows
 * the shared value. Keys are open strings, not the harness enum: the file is
 * shared by binaries of different ages, and a key a newer one wrote must not
 * fail an older one's read of the whole block. `overrides` defaults to `{}`, so
 * a block written before it existed (traycer#2450) still validates.
 */
export const catalogConfigSchema = lazySchema(() =>
  z
    .object({
      probeTimeoutSeconds: z
        .number()
        .int()
        .positive()
        .default(CATALOG_PROBE_TIMEOUT_DEFAULT_SECONDS),
      overrides: z
        .record(z.string().min(1), z.number().int().positive())
        .default({}),
    })
    .default({
      probeTimeoutSeconds: CATALOG_PROBE_TIMEOUT_DEFAULT_SECONDS,
      overrides: {},
    }),
);
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;

/**
 * Clamps every stored value of a catalog block into the supported range, on
 * read - the shared value and each provider's own alike.
 */
export function clampCatalogConfig(catalog: CatalogConfig): CatalogConfig {
  const overrides: Record<string, number> = {};
  for (const [harnessId, seconds] of Object.entries(catalog.overrides)) {
    overrides[harnessId] = clampCatalogProbeTimeoutSeconds(seconds);
  }
  return {
    probeTimeoutSeconds: clampCatalogProbeTimeoutSeconds(
      catalog.probeTimeoutSeconds,
    ),
    overrides,
  };
}

/**
 * The timeout one provider's catalog reads use: its own value when it has one,
 * else the shared value. `Object.hasOwn`, not a bare index, so a key that names
 * an `Object.prototype` member can never read through to it.
 */
export function catalogProbeTimeoutSecondsFor(
  catalog: CatalogConfig,
  harnessId: string,
): number {
  return Object.hasOwn(catalog.overrides, harnessId)
    ? catalog.overrides[harnessId]
    : catalog.probeTimeoutSeconds;
}

/**
 * The `catalog` block read on its own, ignoring every other key - for the
 * same reason as `worktreesOnlyConfigSchema`: an unrelated defect elsewhere in
 * the document must not hide the timeout the file plainly sets.
 */
export const catalogOnlyConfigSchema = lazySchema(() =>
  z.object({
    catalog: catalogConfigSchema,
  }),
);

export const featureSettingsSchema = lazySchema(() =>
  z
    .object({
      agentRoles: z.boolean().default(false),
      artifactVersioning: z.boolean().default(false),
    })
    .default({ agentRoles: false, artifactVersioning: false }),
);
export type FeatureSettings = z.infer<typeof featureSettingsSchema>;

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
 * `shell.path` + `shell.args` are the CURRENTLY SELECTED command, always
 * MATERIALISED: after every write `shell.args` equals the resolved args for
 * `shell.path` (the mirror invariant in `./store`), so an old host binary that
 * reads this file per PTY spawn never applies its own platform default to the
 * wrong program. The one exception is pure system default - `shell.path === null`
 * AND `shell.args === null` - which means "follow the OS login shell and its
 * family default".
 *
 * `shell.entries` is the set of self-contained `{ path, args }` launch specs the
 * user has added and/or customised through the Settings picker. An entry is
 * created by adding a program or by the first flag edit on the selected shell,
 * and persists until removed - so it is both the "remembered" half of the
 * picker's list (detection finds the rest) and where a shell's custom flags
 * live. Additive and `.default([])`-ed, so config files written before the
 * feature keep validating without a version bump.
 *
 * `args` stores DEVIATIONS ONLY: `null` means "no flag deviation - resolution
 * uses `defaultShellArgs(path)`". Presence (an entry exists) and flag-deviation
 * (`args !== null`) are independent halves, so an added program running its
 * factory flags is `{ path, args: null }`. The store's write path canonicalises
 * any args deeply equal to the family default down to `null`, which is what
 * makes "the visible flags differ from the family default" equivalent to
 * "a non-null deviation is on disk".
 */
const shellEntrySchema = lazySchema(() =>
  z.object({
    path: z.string(),
    args: z.array(z.string()).nullable(),
  }),
);

/** A single remembered/customised launch spec: one added program and its flags. */
export interface ShellEntry {
  readonly path: string;
  readonly args: readonly string[] | null;
}

export const cliConfigSchema = lazySchema(() =>
  z
    .object({
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
          entries: z.array(shellEntrySchema).default([]),
        })
        .default({ path: null, args: null, entries: [] }),
      envOverrides: envOverrideMapSchema.default({}),
      logs: logsConfigSchema,
      features: featureSettingsSchema,
      browser: browserConfigSchema,
      worktrees: worktreesConfigSchema,
      catalog: catalogConfigSchema,
    })
    // Top-level only: an unknown BLOCK survives a read-modify-write instead of
    // being stripped. Two binaries share this file - an older CLI or host that
    // predates a block must not silently delete the newer one's setting on its
    // next write (which is exactly how `logs`/`features` would have been lost).
    // Unknown keys INSIDE a known block are still stripped: those are the shapes
    // both sides already agree on, so an extra key there is corruption, not the
    // future.
    .passthrough(),
);

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
 * An entry in the Settings → Shell picker list. `path` is absolute; a
 * `"detected"` entry was verified executable at detection time (except an OS
 * default that may be a bare command name, e.g. Windows `powershell.exe`),
 * while an `"added"` entry is listed straight from `shell.entries` and stays
 * even if the file no longer exists. `isDefault` marks the OS-default shell so
 * the UI can sort/annotate it. `source` tells the UI which rows are
 * user-removable. `missing` is a list-time `F_OK` probe (never persisted):
 * `true` only for an `"added"` row whose file is gone - detected rows are always
 * `false` - so the UI can flag a customised shell that has since been
 * uninstalled while keeping its removable row.
 */
export interface DetectedShell {
  readonly name: string;
  readonly path: string;
  readonly isDefault: boolean;
  readonly source: "detected" | "added";
  readonly missing: boolean;
  /**
   * Present only on a Windows `wsl.exe` row whose WSL cannot actually host a
   * terminal. On Windows 11 `System32\wsl.exe` exists even when WSL was never
   * installed - it is the installer stub, and spawning it as a shell prints
   * usage text and exits immediately. `"not-installed"` means exactly that
   * stub; `"no-distro"` means WSL itself works but no Linux distribution is
   * registered. Probed at list time (never persisted); absent means healthy,
   * not probed, or not a wsl.exe row.
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
  features: { agentRoles: false, artifactVersioning: false },
  browser: { agentAccess: true },
  worktrees: { agentCreate: "allow" },
  catalog: {
    probeTimeoutSeconds: CATALOG_PROBE_TIMEOUT_DEFAULT_SECONDS,
    overrides: {},
  },
};
