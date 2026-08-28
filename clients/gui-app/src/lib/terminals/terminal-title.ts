import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
} from "@traycer/protocol/host/terminal/unary-schemas";

export const DEFAULT_TERMINAL_TITLE = "New Terminal";

export function deriveTitleSourceFromSessionTitle(
  title: string | null,
): "default" | "manual" {
  return title === null ? "default" : "manual";
}

/**
 * The one definition of what a terminal session is CALLED on screen. Every
 * surface that lists terminals (the Task's Terminals panel, the @-mention
 * picker, the canvas tile ref) reads it from here, so a shell never shows up
 * under two different names depending on where you looked.
 */
export function terminalSessionLabel(
  session:
    | CanonicalTerminalSessionInfo
    | CanonicalTerminalSessionInfoWithCurrentCwd,
): string {
  return terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
    currentCwd: "currentCwd" in session ? session.currentCwd : session.cwd,
  });
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
