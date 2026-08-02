export const DEFAULT_TERMINAL_TITLE = "New Terminal";

export function deriveTitleSourceFromSessionTitle(
  title: string | null,
): "default" | "manual" {
  return title === null ? "default" : "manual";
}

export function terminalSessionTitle(input: {
  readonly title: string | null;
  readonly activeProcessName: string | null | undefined;
  readonly currentCwd: string | null | undefined;
}): string {
  const title = input.title?.trim() ?? "";
  if (title.length > 0) return title;
  const activeProcessName = input.activeProcessName?.trim() ?? "";
  const directoryName = terminalDirectoryName(input.currentCwd);
  if (activeProcessName.length > 0) {
    return directoryName === null
      ? activeProcessName
      : `${directoryName} · ${activeProcessName}`;
  }
  if (directoryName !== null) {
    return `${directoryName} · ${DEFAULT_TERMINAL_TITLE}`;
  }
  return DEFAULT_TERMINAL_TITLE;
}

function terminalDirectoryName(cwd: string | null | undefined): string | null {
  if (cwd === null || cwd === undefined || cwd.length === 0) return null;
  const withoutTrailingSeparators = cwd.replace(/[\\/]+$/, "");
  if (withoutTrailingSeparators.length === 0) return "/";
  if (/^[A-Za-z]:$/.test(withoutTrailingSeparators)) {
    return `${withoutTrailingSeparators}${cwd.includes("\\") ? "\\" : "/"}`;
  }
  const segments = withoutTrailingSeparators.split(/[\\/]/);
  const name = segments.at(-1) ?? "";
  return name.length > 0 ? name : null;
}
