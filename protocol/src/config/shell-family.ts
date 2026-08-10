/**
 * Per-program default shell flags. Flags belong to a program, not to the
 * Settings panel: switching the selected program swaps the flag set, so a login
 * shell reads the user's profile with `-i -l` while a non-shell program (`cat`,
 * `nu`, `pwsh.exe`, `cmd.exe`, a custom binary) launches with none.
 *
 * Kept in its own browser-safe module (no node imports) so the renderer
 * (Settings → Shell) imports the same source of truth the store uses to
 * materialise `shell.args`, rather than duplicating the login-shell family set.
 */

/**
 * Shell basenames whose family default is interactive + login (`-i -l`) so the
 * shell sources `.zprofile`/`.zlogin`/`.zshrc` and PATH additions reach every
 * terminal AND the host. Deliberately bare names: a Windows `bash.exe` /
 * `pwsh.exe` is not in the set, which is why the old win32 platform special-case
 * (everything → `[]`) falls out naturally here.
 */
const LOGIN_SHELL_BASENAMES: ReadonlySet<string> = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "ksh",
  "tcsh",
  "dash",
]);

/** Lowercased final path segment, split on both POSIX and Windows separators. */
function shellBasename(path: string): string {
  const segments = path.split(/[\\/]/);
  return (segments[segments.length - 1] ?? path).toLowerCase();
}

/**
 * Whether `path` names a login-shell-family program, i.e. one whose family
 * default is `-i -l`. The renderer uses this to decide whether the
 * "`-i -l` loads your full shell profile" helper actually applies to the
 * selected program.
 */
export function isLoginShellFamily(path: string): boolean {
  return LOGIN_SHELL_BASENAMES.has(shellBasename(path));
}

/**
 * The family default flags for a program: `["-i", "-l"]` for a login shell,
 * `[]` for anything else. This is the fallback the store materialises into
 * `shell.args` when the selected program has no stored per-shell customisation.
 */
export function defaultShellArgs(path: string): readonly string[] {
  return isLoginShellFamily(path) ? ["-i", "-l"] : [];
}

/**
 * How the host derives a spawned agent's environment for a given Windows shell,
 * for the Settings → Shell caption. Kept in lockstep with the host's
 * `windowsShellFamily` (`traycer-host/.../provider-search-dirs.ts`) and
 * `detectShells` friendly-naming: PowerShell (pwsh 7 / Windows PowerShell 5.1)
 * and Git Bash are profile-probed; WSL runs agents as Windows processes; every
 * other shell (cmd, custom) gets the registry-merged Windows environment only.
 */
export type WindowsShellCaptionFamily =
  | "powershell"
  | "git-bash"
  | "wsl"
  | "other";

const WINDOWS_POWERSHELL_BASENAMES: ReadonlySet<string> = new Set([
  "pwsh.exe",
  "powershell.exe",
]);

export function windowsShellCaptionFamily(
  path: string,
): WindowsShellCaptionFamily {
  const base = shellBasename(path);
  if (WINDOWS_POWERSHELL_BASENAMES.has(base)) return "powershell";
  // Git Bash is a `bash.exe` in an MSYS/Git-for-Windows layout
  // (`<install>\bin\` or `<install>\usr\bin\`, any install dir name - e.g.
  // PortableGit), matching the host classifier. System32's bash.exe is legacy
  // WSL. The Settings path is user-typed and may use forward slashes.
  const lower = path.toLowerCase().replace(/\//g, "\\");
  if (
    base === "bash.exe" &&
    /\\(usr\\)?bin\\bash\.exe$/.test(lower) &&
    !lower.includes("\\system32\\")
  ) {
    return "git-bash";
  }
  // Both wsl.exe and the legacy System32 bash.exe launcher open WSL - the
  // same terminals-cross-the-boundary caption applies to either.
  if (base === "wsl.exe") return "wsl";
  if (base === "bash.exe" && lower.includes("\\system32\\")) return "wsl";
  return "other";
}
