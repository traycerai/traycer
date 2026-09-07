const WINDOWS_SHELL_EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".com",
  ".exe",
  ".bat",
  ".cmd",
]);

/** Whether the target platform can launch `path` as a shell program. */
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
