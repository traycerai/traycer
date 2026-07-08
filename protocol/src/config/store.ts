import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { platform as osPlatform } from "node:os";
import { basename } from "node:path";
import { cliConfigDir, cliConfigPath } from "./paths";
import {
  cliConfigSchema,
  CLI_CONFIG_VERSION,
  EMPTY_CLI_CONFIG,
  type CliConfig,
  type DetectedShell,
  type EnvOverrideValue,
  type EffectiveShellConfig,
  type LogsConfig,
} from "./schema";
import { DEFAULT_LOG_LEVEL, type LogLevel } from "./log-level";

/**
 * Filesystem-backed config store for `~/.traycer/cli/config.json`, shared
 * by the CLI (`traycer config …` CRUD) and the host (per-spawn shell
 * lookup, provider-CLI PATH discovery). Every read and write goes through
 * `cliConfigSchema`, so neither side can corrupt the file or drift from
 * the other's expectations.
 */

/**
 * OS-appropriate default shell binary.
 *   POSIX: `$SHELL` if set, else `/bin/zsh` (macOS) / `/bin/bash` (Linux).
 *   Windows: `$COMSPEC` if set, else `powershell.exe`.
 */
export function defaultShellPath(): string {
  if (osPlatform() === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return (
    process.env.SHELL ?? (osPlatform() === "darwin" ? "/bin/zsh" : "/bin/bash")
  );
}

/**
 * OS-appropriate default shell flags. Interactive + login on POSIX so the
 * shell sources `.zprofile`, `.zlogin`, AND `.zshrc` - most users keep PATH
 * additions (asdf shims, zinit setup, etc.) in zshrc, and we want those
 * reaching every terminal AND the host. No `-c` / `-Command` here; the
 * host-bootstrap CLI appends those itself around the `exec node …` line.
 */
export function defaultShellArgs(): readonly string[] {
  if (osPlatform() === "win32") {
    return [];
  }
  return ["-i", "-l"];
}

/** Common absolute shell locations probed in addition to `/etc/shells`. */
const POSIX_SHELL_PROBE_PATHS: readonly string[] = [
  "/bin/zsh",
  "/bin/bash",
  "/bin/sh",
  "/usr/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/fish",
  "/opt/homebrew/bin/fish",
  "/usr/local/bin/fish",
];

/** Known absolute shell locations probed on Windows. */
const WINDOWS_SHELL_PROBE_PATHS: readonly string[] = [
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Windows\\System32\\cmd.exe",
];

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `/etc/shells` entries (existing, non-comment lines), or `[]` if unreadable. */
async function readEtcShells(): Promise<readonly string[]> {
  try {
    const raw = await readFile("/etc/shells", "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Best-effort enumeration of shells installed on this machine, for the
 * Settings → Shell quick-picks. POSIX unions `/etc/shells` with a common
 * probe set and `$SHELL`, keeping only entries that exist and are executable;
 * Windows probes known PowerShell/cmd locations plus `%COMSPEC%`. The OS
 * default ({@link defaultShellPath}) is always included even when it is a bare
 * command name that cannot be stat-ed. Never throws - an unreadable
 * `/etc/shells` or a failed probe just yields a shorter list, and the UI still
 * accepts an arbitrary custom path.
 */
export async function detectShells(): Promise<readonly DetectedShell[]> {
  const defaultPath = defaultShellPath();
  const candidates = new Set<string>([defaultPath]);
  if (osPlatform() === "win32") {
    if (process.env.COMSPEC) candidates.add(process.env.COMSPEC);
    for (const path of WINDOWS_SHELL_PROBE_PATHS) candidates.add(path);
  } else {
    if (process.env.SHELL) candidates.add(process.env.SHELL);
    for (const path of await readEtcShells()) candidates.add(path);
    for (const path of POSIX_SHELL_PROBE_PATHS) candidates.add(path);
  }
  const probed = await Promise.all(
    [...candidates].map(async (path) => ({
      path,
      ok: await isExecutableFile(path),
    })),
  );
  const existing = probed
    .filter((entry) => entry.ok)
    .map((entry) => entry.path);
  // Guarantee the OS default is offered even if it is a bare command name
  // (e.g. Windows `powershell.exe`) that `access` cannot resolve.
  const paths = existing.includes(defaultPath)
    ? existing
    : [defaultPath, ...existing];
  return paths
    .map((path) => ({
      name: basename(path),
      path,
      isDefault: path === defaultPath,
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    });
}

// Oldest on-disk shape we know how to migrate from. A file whose `version`
// is missing or non-numeric is assumed to be this (the earliest shape), NOT
// the current version - otherwise the migration chain would be skipped for
// genuinely-old files.
const OLDEST_CLI_CONFIG_VERSION = 1;

/**
 * Per-version upgraders, keyed by the version each one upgrades FROM. Add an
 * entry whenever {@link CLI_CONFIG_VERSION} is bumped, e.g.
 * `2: (v2) => ({ ...reshaped, version: 3 })`. Today only v1 exists, so the
 * map is empty and migration is a structural no-op - the seam is here so a
 * future bump is a single localised change, not a rewrite of `readCliConfig`.
 */
const migrators: Record<
  number,
  (cfg: Record<string, unknown>) => Record<string, unknown>
> = {};

/**
 * Brings an older on-disk shape up to {@link CLI_CONFIG_VERSION}, one version
 * at a time, so each migrator only has to understand the shape immediately
 * before it. A missing/non-numeric `version` is treated as the oldest shape
 * (so a versionless legacy file is migrated, not skipped); the resolved
 * version is stamped onto the result so it validates. A *newer* version is
 * left as-is and stamped unchanged, so the schema below rejects it with an
 * actionable error rather than silently misreading a future format.
 */
export function migrateCliConfig(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const cfg: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  let version =
    typeof cfg.version === "number" ? cfg.version : OLDEST_CLI_CONFIG_VERSION;
  while (version < CLI_CONFIG_VERSION) {
    const migrate = migrators[version];
    if (migrate === undefined) break;
    Object.assign(cfg, migrate(cfg));
    version += 1;
  }
  cfg.version = version;
  return cfg;
}

/**
 * Returns the validated config, or `EMPTY_CLI_CONFIG` when the file is
 * absent. Older shapes are upgraded through {@link migrateCliConfig} first.
 * Throws a clear error when the file exists but is not valid JSON or does
 * not match `cliConfigSchema` - a malformed config is a real bug to
 * surface, not something to silently paper over.
 */
export async function readCliConfig(): Promise<CliConfig> {
  let raw: string;
  try {
    raw = await readFile(cliConfigPath(), "utf8");
  } catch (err) {
    // Only a genuinely-absent file means "no config yet". A permission or I/O
    // error must surface - not silently become empty, or a later mutator would
    // overwrite the real (temporarily-unreadable) config with defaults.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return EMPTY_CLI_CONFIG;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "~/.traycer/cli/config.json is not valid JSON; refusing to overwrite. Fix or delete it.",
    );
  }
  const result = cliConfigSchema.safeParse(migrateCliConfig(parsed));
  if (!result.success) {
    throw new Error(
      `~/.traycer/cli/config.json does not match the expected schema: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Validates `next` against the schema, then writes it atomically (tmp +
 * rename) with owner-only permissions. Validating before the write is what
 * stops a buggy modifier from persisting a broken file.
 */
export async function writeCliConfig(next: CliConfig): Promise<void> {
  const validated = cliConfigSchema.parse(next);
  await mkdir(cliConfigDir(), { recursive: true, mode: 0o700 });
  const target = cliConfigPath();
  // Per-write unique tmp name: two processes writing concurrently (e.g. two
  // `traycer config …` invocations) must not share the same tmp file, or
  // their bytes interleave and the rename yields a corrupt config.json. Each
  // writer renames a fully-written file of its own, so the rename stays atomic
  // (last writer wins - acceptable; partial corruption is not).
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(validated, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, target);
  } catch (err) {
    // Don't leave an orphaned temp file behind if the write/rename failed.
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Resolves the effective shell config, synthesising OS defaults for any
 * field the user has not overridden. Cheap (one file read); safe to call
 * per terminal spawn.
 */
export async function loadEffectiveShellConfig(): Promise<EffectiveShellConfig> {
  const cfg = await readCliConfig();
  const path = cfg.shell.path ?? defaultShellPath();
  const args = cfg.shell.args ?? defaultShellArgs();
  const synthesised = cfg.shell.path === null && cfg.shell.args === null;
  return { path, args, synthesised };
}

export async function setShell(
  path: string | null,
  args: readonly string[] | null,
): Promise<{
  readonly path: string | null;
  readonly args: readonly string[] | null;
}> {
  const current = await readCliConfig();
  const nextPath = path !== null ? path : current.shell.path;
  const nextArgs = args !== null ? [...args] : current.shell.args;
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: { path: nextPath, args: nextArgs },
    envOverrides: current.envOverrides,
    logs: current.logs,
  });
  return { path: nextPath, args: nextArgs };
}

export async function resetShell(): Promise<void> {
  const current = await readCliConfig();
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: { path: null, args: null },
    envOverrides: current.envOverrides,
    logs: current.logs,
  });
}

/**
 * Persists the client + host log thresholds, preserving the user's shell and
 * env-override config. Reads-modify-writes through the schema like every other
 * mutator, so the rest of `config.json` round-trips untouched.
 */
export async function setLogLevels(
  cliLogLevel: LogLevel,
  hostLogLevel: LogLevel,
): Promise<void> {
  const current = await readCliConfig();
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: current.shell,
    envOverrides: current.envOverrides,
    logs: { cliLogLevel, hostLogLevel },
  });
}

/** The configured client + host log thresholds (defaults when unset). */
export async function readLogLevels(): Promise<LogsConfig> {
  return (await readCliConfig()).logs;
}

/**
 * Best-effort synchronous read of just the log thresholds, for logger
 * construction on the hot path. Never throws — any missing/corrupt/invalid
 * config resolves to the `info` defaults, so a logger can always cheaply decide
 * its threshold at startup without awaiting or risking a crash.
 */
export function readLogLevelsSync(): LogsConfig {
  try {
    const raw = readFileSync(cliConfigPath(), "utf8");
    const result = cliConfigSchema.safeParse(migrateCliConfig(JSON.parse(raw)));
    if (result.success) return result.data.logs;
  } catch {
    // A logger must never crash on a config read — fall through to defaults.
  }
  return { cliLogLevel: DEFAULT_LOG_LEVEL, hostLogLevel: DEFAULT_LOG_LEVEL };
}

export async function listEnvOverrides(): Promise<
  Readonly<Record<string, EnvOverrideValue>>
> {
  return (await readCliConfig()).envOverrides;
}

export async function getEnvOverride(
  key: string,
): Promise<EnvOverrideValue | undefined> {
  return (await readCliConfig()).envOverrides[key];
}

export async function setEnvOverride(
  key: string,
  value: EnvOverrideValue,
): Promise<void> {
  const current = await readCliConfig();
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: current.shell,
    envOverrides: { ...current.envOverrides, [key]: value },
    logs: current.logs,
  });
}

export async function deleteEnvOverride(key: string): Promise<boolean> {
  const current = await readCliConfig();
  if (!(key in current.envOverrides)) return false;
  const nextOverrides: Record<string, EnvOverrideValue> = {
    ...current.envOverrides,
  };
  delete nextOverrides[key];
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: current.shell,
    envOverrides: nextOverrides,
    logs: current.logs,
  });
  return true;
}

export function applyEnvOverrides(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, EnvOverrideValue>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}
