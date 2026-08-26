import { execFile } from "node:child_process";
import nodePath from "node:path";
import type { DetectedShell, WslHealth } from "./schema";

/**
 * Liveness probe behind `DetectedShell.wslHealth`.
 *
 * On Windows 11 `System32\wsl.exe` exists on every machine - when the WSL
 * feature was never installed it is only the installer stub, and EVERY
 * invocation (including spawning it as a terminal shell) prints usage text and
 * exits with code 1. A file-existence check therefore says nothing about
 * whether WSL can host a terminal; only asking wsl.exe itself does.
 *
 * Classification is deliberately locale-independent - exit codes and line
 * counts, never message text:
 *
 *   1. `wsl --list --quiet` exits 0 and names at least one distribution
 *      → healthy (`undefined`).
 *   2. otherwise `wsl --status` exits 0 → WSL runs but nothing is registered
 *      (`"no-distro"`).
 *   3. otherwise → the installer stub, or wsl.exe too old to answer
 *      (`"not-installed"`; pre-`--status` WSL without a distro lands here too,
 *      where the remedy - `wsl --install` - is the same).
 */

const PROBE_TIMEOUT_MS = 3_000;
/**
 * Coalesces the burst of `listShells` calls a Settings open can trigger while
 * staying short enough that the panel's explicit "re-detect" control observes
 * a just-installed WSL rather than a memoised verdict.
 */
const MEMO_TTL_MS = 5_000;

interface WslRunResult {
  /** Spawn succeeded AND the process exited 0. */
  readonly ok: boolean;
  readonly stdout: string;
}

/** How the probe runs wsl.exe; injectable so tests never spawn a process. */
export type WslRunner = (
  wslPath: string,
  args: readonly string[],
) => Promise<WslRunResult>;

/**
 * wsl.exe historically writes UTF-16LE regardless of console code page (the
 * `WSL_UTF8=1` env below asks newer builds for UTF-8, but the installer stub
 * and older builds ignore it). ASCII-range UTF-16LE is riddled with NUL bytes
 * and valid UTF-8 never contains one, so a single NUL check picks the decoder.
 */
export function decodeWslOutput(raw: Buffer): string {
  return raw.includes(0) ? raw.toString("utf16le") : raw.toString("utf8");
}

const runWsl: WslRunner = (wslPath, args) =>
  new Promise((resolvePromise) => {
    execFile(
      wslPath,
      [...args],
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: "buffer",
        env: { ...process.env, WSL_UTF8: "1" },
      },
      (error, stdout) => {
        resolvePromise({
          ok: error === null,
          stdout: decodeWslOutput(stdout),
        });
      },
    );
  });

/**
 * `undefined` = WSL can host a terminal; see the module doc for the ladder.
 * The runner is explicit (tests pass a fake; production callers go through
 * `probeWslHealthCached`, which binds the real spawn).
 */
export async function probeWslHealth(
  wslPath: string,
  run: WslRunner,
): Promise<WslHealth | undefined> {
  const list = await run(wslPath, ["--list", "--quiet"]);
  const hasDistro = list.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().length > 0);
  if (list.ok && hasDistro) return undefined;
  const status = await run(wslPath, ["--status"]);
  return status.ok ? "no-distro" : "not-installed";
}

const memo = new Map<
  string,
  { readonly at: number; readonly result: Promise<WslHealth | undefined> }
>();

/**
 * `probeWslHealth` with in-flight coalescing and a short TTL, keyed
 * case-insensitively (Windows paths). The promise is memoised, not the value,
 * so concurrent list calls share one spawn.
 */
export function probeWslHealthCached(
  wslPath: string,
): Promise<WslHealth | undefined> {
  const key = wslPath.toLowerCase();
  const now = Date.now();
  const hit = memo.get(key);
  if (hit !== undefined && now - hit.at < MEMO_TTL_MS) return hit.result;
  const result = probeWslHealth(wslPath, runWsl);
  memo.set(key, { at: now, result });
  return result;
}

export function clearWslHealthMemoForTests(): void {
  memo.clear();
}

/** How {@link annotateWslHealth} asks about one `wsl.exe` path. */
export type WslHealthProbe = (
  wslPath: string,
) => Promise<WslHealth | undefined>;

/**
 * Attaches {@link DetectedShell.wslHealth} to every `wsl.exe` row whose WSL
 * cannot host a terminal, so pickers can warn (and refuse) instead of offering
 * a shell that prints usage text and exits.
 *
 * Probed PER DISTINCT PATH, never once for the basename: an added row may point
 * at a different `wsl.exe` than System32's (a wrapper, a copy, a Sysnative
 * view), and answering for one with another's verdict would flag a working
 * shell or clear a broken one. Distinct paths are rare - normally exactly one -
 * and the caching prober is keyed by path, so the common case is one spawn.
 *
 * Best-effort like the rest of listing: a probe that cannot answer (rejects, or
 * resolves `undefined`) leaves its rows unannotated rather than failing the
 * list. Callers own the platform gate; this is pure mapping.
 */
export async function annotateWslHealth(
  rows: readonly DetectedShell[],
  probe: WslHealthProbe,
): Promise<readonly DetectedShell[]> {
  const isWslRow = (row: DetectedShell): boolean =>
    nodePath.win32.basename(row.path).toLowerCase() === "wsl.exe";
  // Keyed by the case-insensitive path (win32 filesystem), valued by the
  // original spelling so the probe spawns the path as the user wrote it.
  const distinct = new Map<string, string>();
  for (const row of rows) {
    if (isWslRow(row)) distinct.set(row.path.toLowerCase(), row.path);
  }
  if (distinct.size === 0) return rows;
  const verdicts = new Map<string, WslHealth | undefined>();
  await Promise.all(
    [...distinct].map(async ([key, path]) => {
      verdicts.set(key, await probe(path).catch(() => undefined));
    }),
  );
  return rows.map((row) => {
    if (!isWslRow(row)) return row;
    const verdict = verdicts.get(row.path.toLowerCase());
    return verdict === undefined ? row : { ...row, wslHealth: verdict };
  });
}
