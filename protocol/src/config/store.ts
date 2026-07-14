import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { platform as osPlatform, userInfo } from "node:os";
import * as nodePath from "node:path";
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

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const TRANSIENT_WINDOWS_RENAME_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

/**
 * Filesystem-backed config store for `~/.traycer/cli/config.json`, shared
 * by the CLI (`traycer config …` CRUD) and the host (per-spawn shell
 * lookup, provider-CLI PATH discovery). Every read and write goes through
 * `cliConfigSchema`, so neither side can corrupt the file or drift from
 * the other's expectations.
 */

/**
 * OS-appropriate default shell binary.
 *   POSIX: the passwd login shell, else `$SHELL`, else `/bin/zsh` (macOS) /
 *     `/bin/bash` (Linux).
 *   Windows: `$COMSPEC` if set, else `powershell.exe`.
 *
 * The passwd entry (`os.userInfo().shell`) is preferred over `$SHELL` because
 * launchers routinely leak an inherited `$SHELL` into the app's environment
 * that is NOT the user's real login shell - the desktop dev stack (make →
 * Electron) leaks `SHELL=/bin/bash` even when the user's login shell is zsh, so
 * trusting `$SHELL` reported bash as the "system default". The passwd `shell`
 * field is the authoritative login shell; `$SHELL` is only a fallback for the
 * rare case with no passwd entry.
 */
export function defaultShellPath(): string {
  if (osPlatform() === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  const passwdShell = passwdLoginShell();
  if (passwdShell !== null) return passwdShell;
  return (
    process.env.SHELL ?? (osPlatform() === "darwin" ? "/bin/zsh" : "/bin/bash")
  );
}

/**
 * The current user's login shell from the passwd database, or `null` when it is
 * unavailable (no passwd entry - `userInfo` throws - or an empty/absent shell
 * field, as on Windows).
 */
function passwdLoginShell(): string | null {
  try {
    const shell = userInfo().shell;
    return typeof shell === "string" && shell.length > 0 ? shell : null;
  } catch {
    return null;
  }
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

/**
 * Shell binary basenames scanned across every `PATH` directory. Deliberately a
 * fixed set (not "anything on PATH") so the probe stays cheap and predictable -
 * it catches whatever an installer (homebrew, nix, scoop, winget, Git Bash) put
 * on PATH without stat-ing every executable on the machine.
 */
const POSIX_PATH_SCAN_NAMES: readonly string[] = [
  "zsh",
  "bash",
  "fish",
  "nu",
  "pwsh",
];
const WINDOWS_PATH_SCAN_NAMES: readonly string[] = [
  "pwsh.exe",
  "powershell.exe",
  "cmd.exe",
  "bash.exe",
  "nu.exe",
  "wsl.exe",
];

/**
 * The `path` submodule matching a target platform, so detection builds and
 * splits paths with the target's separators regardless of the host OS. This is
 * what lets the win32 detection logic be exercised honestly from a POSIX test
 * runner (and vice versa).
 */
function pathApiFor(isWindows: boolean) {
  return isWindows ? nodePath.win32 : nodePath.posix;
}

export interface ShellProbeResult {
  readonly exists: boolean;
  readonly executable: boolean;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a path points at something that exists and is executable, using the
 * same `X_OK` check detection relies on. Backs the Settings picker's live
 * "Add a shell" validation (surfaced natively by the desktop shell, which
 * mirrors this logic rather than spawning the CLI per keystroke).
 */
export async function probeShellPath(path: string): Promise<ShellProbeResult> {
  const [exists, executable] = await Promise.all([
    access(path, fsConstants.F_OK).then(
      () => true,
      () => false,
    ),
    isExecutableFile(path),
  ]);
  return { exists, executable };
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

/** Case-insensitive on win32 (its filesystem is), exact elsewhere. */
function shellPathsEqual(a: string, b: string, isWindows: boolean): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Well-known Windows shell locations, built from environment variables rather
 * than hardcoded `C:\` prefixes so a machine with a relocated `%SystemRoot%` or
 * `%ProgramFiles%` still resolves them. Any entry whose backing env var is
 * unset is skipped.
 */
function windowsWellKnownShellPaths(): string[] {
  const { join } = nodePath.win32;
  const env = process.env;
  const paths: string[] = [];
  const add = (base: string | undefined, ...segments: string[]): void => {
    if (base !== undefined && base.length > 0) paths.push(join(base, ...segments));
  };
  add(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  add(env.SystemRoot, "System32", "cmd.exe");
  add(env.SystemRoot, "System32", "wsl.exe");
  add(env.ProgramFiles, "PowerShell", "7", "pwsh.exe");
  add(env.ProgramFiles, "Git", "bin", "bash.exe");
  add(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe");
  add(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe");
  add(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe");
  return paths;
}

/** `dir/<name>` candidates for every `PATH` directory × the platform name set. */
function pathScanCandidates(isWindows: boolean): string[] {
  const raw = process.env.PATH;
  if (raw === undefined || raw.length === 0) return [];
  const api = pathApiFor(isWindows);
  const names = isWindows ? WINDOWS_PATH_SCAN_NAMES : POSIX_PATH_SCAN_NAMES;
  return raw
    .split(api.delimiter)
    .filter((dir) => dir.length > 0)
    .flatMap((dir) => names.map((name) => api.join(dir, name)));
}

/**
 * A friendly display name for a detected shell: WSL and Git Bash get recognised
 * labels (both are `*.exe` whose basename would otherwise read as `wsl.exe` /
 * `bash.exe`); everything else is just its basename. Purely cosmetic - never a
 * badge or marker, so an added shell and a detected one with the same name are
 * visually indistinguishable.
 */
function friendlyShellName(shellPath: string, isWindows: boolean): string {
  const api = pathApiFor(isWindows);
  const base = api.basename(shellPath);
  if (base.toLowerCase() === "wsl.exe") return "WSL";
  const lower = shellPath.toLowerCase();
  if (
    base.toLowerCase() === "bash.exe" &&
    (lower.includes("\\git\\bin\\") || lower.includes("\\git\\usr\\bin\\"))
  ) {
    return "Git Bash";
  }
  return base;
}

/** Resolved real path, or the original path when it cannot be resolved. */
async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function sortShellsDefaultFirst(a: DetectedShell, b: DetectedShell): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

/**
 * Best-effort enumeration of shells installed on this machine, for the
 * Settings → Shell picker. POSIX unions `/etc/shells`, a common probe set,
 * `$SHELL`, and a scan of every `PATH` directory for known shell names; Windows
 * scans `PATH` plus env-var-derived well-known locations (WSL, Git Bash, Store
 * PowerShell) and `%COMSPEC%`. Every candidate passes the same `X_OK` filter,
 * duplicates that resolve to the same real file (usr-merged `/bin` vs
 * `/usr/bin`) collapse to one entry - preferring the OS default - and WSL /
 * Git Bash get friendly names. The OS default ({@link defaultShellPath}) is
 * always included even when it is a bare command name that cannot be stat-ed.
 * Never throws - an unreadable `/etc/shells`, a permission error on a PATH
 * directory, or a failed probe just yields a shorter list, and the UI still
 * accepts an arbitrary added path.
 */
export async function detectShells(): Promise<readonly DetectedShell[]> {
  const isWindows = osPlatform() === "win32";
  const defaultPath = defaultShellPath();
  const candidates = new Set<string>([defaultPath]);
  if (isWindows) {
    if (process.env.COMSPEC) candidates.add(process.env.COMSPEC);
    for (const path of windowsWellKnownShellPaths()) candidates.add(path);
  } else {
    if (process.env.SHELL) candidates.add(process.env.SHELL);
    for (const path of await readEtcShells()) candidates.add(path);
    for (const path of POSIX_SHELL_PROBE_PATHS) candidates.add(path);
  }
  for (const path of pathScanCandidates(isWindows)) candidates.add(path);

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

  // Collapse paths that resolve to the same real file, preferring the OS
  // default so its row keeps the default marker and canonical spelling.
  const resolved = await Promise.all(
    paths.map(async (path) => ({ path, real: await resolveRealPath(path) })),
  );
  const chosenByRealPath = new Map<string, string>();
  for (const { path, real } of resolved) {
    const key = isWindows ? real.toLowerCase() : real;
    if (!chosenByRealPath.has(key) || path === defaultPath) {
      chosenByRealPath.set(key, path);
    }
  }

  return [...chosenByRealPath.values()]
    .map((path) => ({
      name: friendlyShellName(path, isWindows),
      path,
      isDefault: path === defaultPath,
      source: "detected" as const,
    }))
    .sort(sortShellsDefaultFirst);
}

/**
 * The full Settings → Shell picker list: detected shells unioned with the
 * user's remembered `shell.added` paths, deduped by path (case-insensitive on
 * win32; a path that is both keeps `source: "detected"`), sorted default-first
 * then alphabetically. Added entries are always listed - even when the file no
 * longer exists - so a removable row is never silently dropped. This is what
 * `traycer config shell list` returns, so every client and the host see one
 * list.
 */
export async function listShells(): Promise<readonly DetectedShell[]> {
  const isWindows = osPlatform() === "win32";
  const detected = await detectShells();
  const api = pathApiFor(isWindows);
  const config = await readCliConfig();
  const added: DetectedShell[] = config.shell.added
    .filter(
      (path) =>
        !detected.some((entry) =>
          shellPathsEqual(entry.path, path, isWindows),
        ),
    )
    .map((path) => ({
      name: api.basename(path),
      path,
      isDefault: false,
      source: "added" as const,
    }));
  return [...detected, ...added].sort(sortShellsDefaultFirst);
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
 * Atomically replaces the config, tolerating the short-lived access-denied
 * windows that Windows filesystem filters (for example antivirus/indexers) can
 * create around a newly-written file. Node's `rename` has no retry option, so a
 * bounded retry belongs at this persistence boundary rather than in every UI or
 * CLI caller. POSIX and non-transient failures still surface immediately.
 */
async function renameCliConfig(
  source: string,
  target: string,
  retryIndex: number,
): Promise<void> {
  try {
    await rename(source, target);
  } catch (err) {
    const code =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof err.code === "string"
        ? err.code
        : null;
    const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
    if (
      osPlatform() !== "win32" ||
      code === null ||
      !TRANSIENT_WINDOWS_RENAME_ERROR_CODES.has(code) ||
      retryDelay === undefined
    ) {
      throw err;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, retryDelay);
    });
    await renameCliConfig(source, target, retryIndex + 1);
  }
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
    await renameCliConfig(tmp, target, 0);
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
    shell: { path: nextPath, args: nextArgs, added: current.shell.added },
    envOverrides: current.envOverrides,
    logs: current.logs,
  });
  return { path: nextPath, args: nextArgs };
}

/**
 * Remembers `path` in `shell.added` (deduped, case-insensitive on win32) AND
 * selects it as `shell.path`, in one read-modify-write. `shell.args` is left
 * untouched. The caller is responsible for having validated the path first
 * (the CLI's `config shell add` enforces absolute + executable); this helper is
 * the persistence step only.
 */
export async function addShell(
  path: string,
): Promise<{ readonly path: string; readonly added: readonly string[] }> {
  const current = await readCliConfig();
  const isWindows = osPlatform() === "win32";
  const already = current.shell.added.some((entry) =>
    shellPathsEqual(entry, path, isWindows),
  );
  const added = already ? current.shell.added : [...current.shell.added, path];
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: { path, args: current.shell.args, added },
    envOverrides: current.envOverrides,
    logs: current.logs,
  });
  return { path, added };
}

/**
 * Drops `path` from `shell.added`; if it was the selected `shell.path`, clears
 * the selection back to `null` (the synthesised OS default) while leaving
 * `shell.args` untouched. Removing a path that was never added is a no-op
 * success. Returns whether an entry was removed and the resulting selection.
 */
export async function removeShell(
  path: string,
): Promise<{ readonly removed: boolean; readonly path: string | null }> {
  const current = await readCliConfig();
  const isWindows = osPlatform() === "win32";
  const added = current.shell.added.filter(
    (entry) => !shellPathsEqual(entry, path, isWindows),
  );
  const removed = added.length !== current.shell.added.length;
  const wasSelected =
    current.shell.path !== null &&
    shellPathsEqual(current.shell.path, path, isWindows);
  const nextPath = wasSelected ? null : current.shell.path;
  // Nothing to persist when the path was neither remembered nor selected.
  if (!removed && !wasSelected) {
    return { removed: false, path: current.shell.path };
  }
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    shell: { path: nextPath, args: current.shell.args, added },
    envOverrides: current.envOverrides,
    logs: current.logs,
  });
  return { removed, path: nextPath };
}

export async function resetShell(): Promise<void> {
  const current = await readCliConfig();
  await writeCliConfig({
    version: CLI_CONFIG_VERSION,
    // Reset clears only the current selection; the remembered `added` list is
    // independent of which shell is selected, so it survives.
    shell: { path: null, args: null, added: current.shell.added },
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
