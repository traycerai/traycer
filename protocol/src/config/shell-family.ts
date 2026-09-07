/** Per-program default shell flags. */

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

/** Whether `path` names a login-shell-family program, i.e. one whose family default is `-i -l`. */
export function isLoginShellFamily(path: string): boolean {
  return LOGIN_SHELL_BASENAMES.has(shellBasename(path));
}

/** The family default flags for a program: `["-i", "-l"]` for a login shell, `[]` for anything else. */
export function defaultShellArgs(path: string): readonly string[] {
  return isLoginShellFamily(path) ? ["-i", "-l"] : [];
}

/**
 * How the host derives a spawned agent's environment for a given Windows shell, for the Settings → Shell caption.
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
  // Git Bash is a `bash.exe` in an MSYS/Git-for-Windows layout (`<install>\bin\` or `<install>\usr\bin\`, any install dir name - e.g.
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
