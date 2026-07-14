const WINDOWS_SHELL_EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".com",
  ".exe",
  ".bat",
  ".cmd",
]);

/**
 * Whether the target platform can launch `path` as a shell program. POSIX
 * relies on its executable bit; Windows treats X_OK as an existence check, so
 * it also needs one of the standard executable extensions.
 */
export function isShellExecutablePathSupported(
  path: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return true;
  const lowerPath = path.toLowerCase();
  return [...WINDOWS_SHELL_EXECUTABLE_EXTENSIONS].some((extension) =>
    lowerPath.endsWith(extension),
  );
}
