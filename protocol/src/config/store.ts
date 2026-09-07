import { randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
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
  type FeatureSettings,
  type DetectedShell,
  type EnvOverrideValue,
  type EffectiveShellConfig,
  type LogsConfig,
  type ShellEntry,
} from "./schema";
import { defaultShellArgs } from "./shell-family";
import { annotateWslHealth, probeWslHealthCached } from "./wsl-health";
import { isShellExecutablePathSupported } from "./shell-executable";
import { DEFAULT_LOG_LEVEL, type LogLevel } from "./log-level";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const TRANSIENT_WINDOWS_RENAME_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

// Re-exported so existing `@traycer/protocol/config/store` importers (the CLI's `../shell/defaults`) keep resolving the `defaultShellArgs` name from here.
export { defaultShellArgs } from "./shell-family";


/** OS-appropriate default shell binary. */
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

function passwdLoginShell(): string | null {
  try {
    const shell = userInfo().shell;
    // A real passwd login shell is always an absolute path.
    return typeof shell === "string" && nodePath.posix.isAbsolute(shell)
      ? shell
      : null;
  } catch {
    return null;
  }
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

/** Shell binary basenames scanned across every `PATH` directory. */
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
 * The `path` submodule matching a target platform, so detection builds and splits paths with the target's separators regardless of the host OS.
 */
function pathApiFor(isWindows: boolean) {
  return isWindows ? nodePath.win32 : nodePath.posix;
}

export interface ShellProbeResult {
  readonly exists: boolean;
  readonly executable: boolean;
}

async function isExecutableFile(path: string): Promise<boolean> {
  const fileStat = await stat(path).then(
    (value) => value,
    () => null,
  );
  if (
    fileStat === null ||
    !fileStat.isFile() ||
    !isShellExecutablePathSupported(path, osPlatform())
  ) {
    return false;
  }
  return access(path, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Whether a path points at something that exists and is executable, using the same `X_OK` check detection relies on.
 */
export async function probeShellPath(path: string): Promise<ShellProbeResult> {
  const [fileStat, accessible] = await Promise.all([
    stat(path).then(
      (s) => s,
      () => null,
    ),
    isExecutableFile(path),
  ]);
  return {
    exists: fileStat !== null,
    executable: accessible,
  };
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

function windowsWellKnownShellPaths(): string[] {
  const { join } = nodePath.win32;
  const env = process.env;
  const paths: string[] = [];
  const add = (base: string | undefined, ...segments: string[]): void => {
    if (base !== undefined && base.length > 0)
      paths.push(join(base, ...segments));
  };
  add(
    env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
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
 * A friendly display name for a detected shell: WSL and Git Bash get recognised labels (both are `*.exe` whose basename would otherwise read as `wsl.exe` / `bash.exe`); everything else is just its basename.
 * Purely cosmetic - never a badge or marker, so an added shell and a detected one with the same name are visually indistinguishable.
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
 * Best-effort enumeration of shells installed on this machine, for the Settings → Shell picker.
 * The OS default ({@link defaultShellPath}) is always included even when it is a bare command name that cannot be stat-ed.
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
      // A detected row passed the `X_OK` filter above (or is the always-offered
      // OS default), so it is never "missing" - only entry-derived rows can be.
      missing: false,
    }))
    .sort(sortShellsDefaultFirst);
}

/**
 * The full Settings → Shell picker list: detected shells unioned with the user's `shell.entries` paths, deduped by path (case-insensitive on win32; a path that is both keeps `source: "detected"` and `missing: false`).
 */
export async function listShells(): Promise<readonly DetectedShell[]> {
  const isWindows = osPlatform() === "win32";
  const detected = await detectShells();
  const api = pathApiFor(isWindows);
  // Best-effort like detection itself: a corrupt config must not take the whole picker down - the list degrades to detected shells only, while `config shell get/set` still surface the corruption loudly.
  const config = await readCliConfig().catch(() => EMPTY_CLI_CONFIG);
  const entryRows: DetectedShell[] = await Promise.all(
    config.shell.entries
      // Dedupe hand-edited duplicate entries against each other too (exact, and case-insensitive on win32) - writes prevent duplicates, but the list must render sanely from any on-disk content.
      .filter(
        (entry, index, all) =>
          all.findIndex((other) =>
            shellPathsEqual(other.path, entry.path, isWindows),
          ) === index,
      )
      .filter(
        (entry) =>
          !detected.some((row) =>
            shellPathsEqual(row.path, entry.path, isWindows),
          ),
      )
      .map(async (entry) => ({
        name: api.basename(entry.path),
        path: entry.path,
        isDefault: false,
        source: "added" as const,
        missing: !(await access(entry.path, fsConstants.F_OK).then(
          () => true,
          () => false,
        )),
      })),
  );
  return annotateWslHealthHere(
    [...detected, ...entryRows].sort(sortShellsDefaultFirst),
    isWindows,
  );
}

/**
 * {@link annotateWslHealth} behind the platform gate.
 * Gated on the REAL platform rather than the mockable `osPlatform()` so simulated-win32 detection tests never spawn a live process; `isWindows` keeps it off every POSIX list, where no row can be a `wsl.exe` anyway.
 */
async function annotateWslHealthHere(
  rows: readonly DetectedShell[],
  isWindows: boolean,
): Promise<readonly DetectedShell[]> {
  if (!isWindows || process.platform !== "win32") return rows;
  return await annotateWslHealth(rows, probeWslHealthCached);
}

// Oldest on-disk shape we know how to migrate from.
const OLDEST_CLI_CONFIG_VERSION = 1;

/** Per-version upgraders, keyed by the version each one upgrades FROM. */
const migrators: Record<
  number,
  (cfg: Record<string, unknown>) => Record<string, unknown>
> = {};

/**
 * Brings an older on-disk shape up to {@link CLI_CONFIG_VERSION}, one version at a time, so each migrator only has to understand the shape immediately before it.
 * A *newer* version is left as-is and stamped unchanged, so the schema below rejects it with an actionable error rather than silently misreading a future format.
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
 * Returns the validated config, or `EMPTY_CLI_CONFIG` when the file is absent.
 * Throws a clear error when the file exists but is not valid JSON or does not match `cliConfigSchema` - a malformed config is a real bug to surface, not something to silently paper over.
 */
export async function readCliConfig(): Promise<CliConfig> {
  let raw: string;
  try {
    raw = await readFile(cliConfigPath(), "utf8");
  } catch (err) {
    // Only a genuinely-absent file means "no config yet".
    // A permission or I/O error must surface - not silently become empty, or a later mutator would overwrite the real (temporarily-unreadable) config with defaults.
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
  const result = parseCliConfig(parsed);
  if (!result.success) {
    throw new Error(
      `~/.traycer/cli/config.json does not match the expected schema: ${result.error.message}`,
    );
  }
  return result.data;
}

/** Migrates and validates a parsed config document. */
function parseCliConfig(parsed: unknown) {
  return cliConfigSchema.safeParse(migrateCliConfig(parsed));
}

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
 * Validates `next` against the schema, then writes it atomically (tmp + rename) with owner-only permissions.
 */
function normalizedShellEntries(
  entries: readonly ShellEntry[],
  isWindows: boolean,
): ShellEntry[] {
  return entries
    .filter(
      (entry, index, all) =>
        all.findIndex((other) =>
          shellPathsEqual(other.path, entry.path, isWindows),
        ) === index,
    )
    .map((entry) => ({
      path: entry.path,
      args:
        entry.args !== null &&
        !argsEqual(entry.args, defaultShellArgs(entry.path))
          ? entry.args
          : null,
    }));
}

export async function writeCliConfig(next: CliConfig): Promise<void> {
  const validated = cliConfigSchema.parse({
    ...next,
    shell: {
      ...next.shell,
      entries: normalizedShellEntries(
        next.shell.entries,
        osPlatform() === "win32",
      ),
    },
  });
  await mkdir(cliConfigDir(), { recursive: true, mode: 0o700 });
  const target = cliConfigPath();
  // Per-write unique tmp name: two processes writing concurrently (e.g. two `traycer config …` invocations) must not share the same tmp file, or their bytes interleave and the rename yields a corrupt config.json.
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

// The mutable on-disk entry shape (schema-inferred).
// `args` is nullable - `null` is "no flag deviation".
type StoredShellEntry = { path: string; args: string[] | null };

/** The `shell.entries` launch spec matching `path`, or `undefined`. */
function shellEntryFor(
  entries: readonly StoredShellEntry[],
  path: string,
  isWindows: boolean,
): StoredShellEntry | undefined {
  return entries.find((entry) => shellPathsEqual(entry.path, path, isWindows));
}

/** Same ordered flag list (used to tell a picked shell from a customised one). */
function argsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The materialised args for selecting `path`: an existing entry's DEVIATION wins, otherwise the program's family default.
 * This is what "picking" a shell writes into `shell.args` - it never consults the legacy `shell.args` rung, because picking always produces a fully-materialised value.
 */
function materialisedArgs(
  config: CliConfig,
  path: string,
  isWindows: boolean,
): string[] {
  const deviation = shellEntryFor(config.shell.entries, path, isWindows)?.args;
  return deviation != null ? [...deviation] : [...defaultShellArgs(path)];
}

/**
 * Upsert `{ path, args }` into `entries`, replacing any spec for the same path.
 * It NEVER deletes an entry - `null` args keep the entry (only `removeShell` deletes) - so presence survives a revert-to-default of the flags.
 */
function upsertShellEntry(
  entries: readonly StoredShellEntry[],
  path: string,
  args: readonly string[] | null,
  isWindows: boolean,
): StoredShellEntry[] {
  const others = entries.filter(
    (entry) => !shellPathsEqual(entry.path, path, isWindows),
  );
  const canonicalArgs =
    args !== null && !argsEqual(args, defaultShellArgs(path))
      ? [...args]
      : null;
  return [...others, { path, args: canonicalArgs }];
}

/**
 * Reads the config and, for a pre-`entries` legacy file, seeds an entry for the selected shell so the first mutation preserves the user's customised flags.
 * Seeding a picked shell would wrongly leave it in the remembered list, so we don't.
 */
async function readConfigWithSeededEntries(): Promise<CliConfig> {
  const config = await readCliConfig();
  const { path, args, entries } = config.shell;
  if (path === null || args === null) return config;
  const isWindows = osPlatform() === "win32";
  const alreadyRemembered =
    shellEntryFor(entries, path, isWindows) !== undefined;
  if (alreadyRemembered || argsEqual(args, defaultShellArgs(path))) {
    return config;
  }
  return {
    ...config,
    shell: {
      ...config.shell,
      entries: upsertShellEntry(entries, path, args, isWindows),
    },
  };
}

/**
 * Resolves the effective shell config, synthesising OS defaults for any field the user has not overridden.
 */
export async function loadEffectiveShellConfig(): Promise<EffectiveShellConfig> {
  const cfg = await readCliConfig();
  const isWindows = osPlatform() === "win32";
  const path = cfg.shell.path ?? defaultShellPath();
  const entry = shellEntryFor(cfg.shell.entries, path, isWindows);
  const args = entry?.args ?? cfg.shell.args ?? defaultShellArgs(path);
  const synthesised = cfg.shell.path === null && cfg.shell.args === null;
  return { path, args, synthesised };
}

/**
 * Sets the selected shell path and/or its flags.
 * Flags always attach to a shell, never to the panel: they live in `shell.entries`, and the mirror (`shell.path`/`shell.args`) materialises only for an EXPLICIT selection.
 */
export async function setShell(
  path: string | null,
  args: readonly string[] | null,
): Promise<{
  readonly path: string | null;
  readonly args: readonly string[] | null;
}> {
  const current = await readConfigWithSeededEntries();
  const isWindows = osPlatform() === "win32";
  let nextPath: string | null;
  let nextArgs: string[] | null;
  let entries = current.shell.entries;
  if (args !== null) {
    // Flag customisation.
    const selectionPath = path !== null ? path : current.shell.path;
    const effectivePath = selectionPath ?? defaultShellPath();
    entries = upsertShellEntry(entries, effectivePath, args, isWindows);
    if (selectionPath === null) {
      nextPath = null;
      nextArgs = null;
    } else {
      nextPath = selectionPath;
      nextArgs = [...args];
    }
  } else if (path !== null) {
    // Picking a shell: materialise its args, remember nothing new.
    nextPath = path;
    nextArgs = materialisedArgs(current, path, isWindows);
  } else {
    // Neither field given (guarded against upstream) - preserve the selection.
    nextPath = current.shell.path;
    nextArgs = current.shell.args;
  }
  await writeCliConfig({
    ...current,
    shell: { path: nextPath, args: nextArgs, entries },
  });
  return { path: nextPath, args: nextArgs };
}

/**
 * Remembers `path` as a `shell.entries` launch spec AND selects it, materialising the mirror in one write.
 */
export async function addShell(
  path: string,
): Promise<{ readonly path: string; readonly entries: readonly ShellEntry[] }> {
  const current = await readConfigWithSeededEntries();
  const isWindows = osPlatform() === "win32";
  const args = [...defaultShellArgs(path)];
  const entries = upsertShellEntry(
    current.shell.entries,
    path,
    args,
    isWindows,
  );
  await writeCliConfig({
    ...current,
    shell: { path, args, entries },
  });
  return { path, entries };
}

export async function revertShellArgs(
  path: string,
): Promise<{ readonly path: string; readonly reverted: boolean }> {
  const current = await readConfigWithSeededEntries();
  const isWindows = osPlatform() === "win32";
  const entry = shellEntryFor(current.shell.entries, path, isWindows);
  // No entry means no stored deviation - nothing to revert, and we must not
  // create one (that would be remembering a shell the user never added).
  if (entry === undefined) {
    return { path, reverted: false };
  }
  const entries = current.shell.entries.map((e) =>
    shellPathsEqual(e.path, path, isWindows) ? { path: e.path, args: null } : e,
  );
  const isSelected =
    current.shell.path !== null &&
    shellPathsEqual(current.shell.path, path, isWindows);
  const nextArgs = isSelected
    ? [...defaultShellArgs(path)]
    : current.shell.args;
  await writeCliConfig({
    ...current,
    shell: { path: current.shell.path, args: nextArgs, entries },
  });
  return { path, reverted: true };
}

/**
 * Forgets a `shell.entries` launch spec; if it was the selected shell, resets the mirror to pure system default (`path`/`args` both null) so the removed shell's flags go with it.
 * Removing a path that was never remembered is a no-op success.
 */
export async function removeShell(
  path: string,
): Promise<{ readonly removed: boolean; readonly path: string | null }> {
  const current = await readConfigWithSeededEntries();
  const isWindows = osPlatform() === "win32";
  const entries = current.shell.entries.filter(
    (entry) => !shellPathsEqual(entry.path, path, isWindows),
  );
  const removed = entries.length !== current.shell.entries.length;
  const wasSelected =
    current.shell.path !== null &&
    shellPathsEqual(current.shell.path, path, isWindows);
  // Nothing to persist when the path was neither remembered nor selected.
  if (!removed && !wasSelected) {
    return { removed: false, path: current.shell.path };
  }
  const nextPath = wasSelected ? null : current.shell.path;
  const nextArgs = wasSelected ? null : current.shell.args;
  await writeCliConfig({
    ...current,
    shell: { path: nextPath, args: nextArgs, entries },
  });
  return { removed, path: nextPath };
}

/** Returns to the system default by clearing ONLY the selection (`path`/`args` both null). */
export async function resetShell(): Promise<void> {
  const current = await readConfigWithSeededEntries();
  await writeCliConfig({
    ...current,
    shell: { path: null, args: null, entries: current.shell.entries },
  });
}

/** Persists the client + host log thresholds, preserving the user's shell and env-override config. */
export async function setLogLevels(
  cliLogLevel: LogLevel,
  hostLogLevel: LogLevel,
): Promise<void> {
  const current = await readCliConfig();
  await writeCliConfig({
    ...current,
    logs: { cliLogLevel, hostLogLevel },
  });
}

/** The configured client + host log thresholds (defaults when unset). */
export async function readLogLevels(): Promise<LogsConfig> {
  return (await readCliConfig()).logs;
}

/**
 * Best-effort synchronous read of just the log thresholds, for logger construction on the hot path.
 * Never throws - any missing/corrupt/invalid config resolves to the `info` defaults, so a logger can always cheaply decide its threshold at startup without awaiting or risking a crash.
 */
export function readLogLevelsSync(): LogsConfig {
  try {
    const raw = readFileSync(cliConfigPath(), "utf8");
    const result = parseCliConfig(JSON.parse(raw));
    if (result.success) return result.data.logs;
  } catch {
    // A logger must never crash on a config read - fall through to defaults.
  }
  return { cliLogLevel: DEFAULT_LOG_LEVEL, hostLogLevel: DEFAULT_LOG_LEVEL };
}

/** The local experimental feature settings (defaults when unset). */
export async function readFeatureSettings(): Promise<FeatureSettings> {
  return (await readCliConfig()).features;
}

/**
 * Best-effort synchronous feature read for command, prompt, tool, and operation
 * gates. Feature checks fail closed when the config is absent or invalid.
 */
export function readFeatureSettingsSync(): FeatureSettings {
  try {
    const raw = readFileSync(cliConfigPath(), "utf8");
    const result = parseCliConfig(JSON.parse(raw));
    if (result.success) return result.data.features;
  } catch {
    // Feature gates must remain safe even when config cannot be read.
  }
  return { agentRoles: false };
}

/** Enables or disables agent roles while preserving the rest of the config. */
export async function setAgentRolesEnabled(enabled: boolean): Promise<void> {
  const current = await readCliConfig();
  await writeCliConfig({
    ...current,
    features: { ...current.features, agentRoles: enabled },
  });
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
    ...current,
    envOverrides: { ...current.envOverrides, [key]: value },
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
    ...current,
    envOverrides: nextOverrides,
  });
  return true;
}

export function applyEnvOverrides(
  base: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, EnvOverrideValue>>,
): NodeJS.ProcessEnv {
  // The Windows environment block is case-insensitive and Node preserves the existing key's casing (the real PATH key is spelled `Path`, not `PATH`), so an override keyed `PATH` must land on the existing `Path` in place.
  const isWindows = osPlatform() === "win32";
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const targetKey = isWindows
      ? (Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase()) ??
        key)
      : key;
    if (value === null) {
      delete env[targetKey];
    } else {
      env[targetKey] = value;
    }
  }
  return env;
}
