export const DEFAULT_TERMINAL_TITLE = "New Terminal";

export function deriveTitleSourceFromSessionTitle(
  title: string | null,
): "default" | "manual" {
  return title === null ? "default" : "manual";
}

export function terminalSessionTitle(input: {
  readonly title: string | null;
  readonly activeProcessName: string | null | undefined;
}): string {
  const title = input.title?.trim() ?? "";
  if (title.length > 0) return title;
  const activeProcessName = input.activeProcessName?.trim() ?? "";
  if (activeProcessName.length > 0) return activeProcessName;
  return DEFAULT_TERMINAL_TITLE;
}
