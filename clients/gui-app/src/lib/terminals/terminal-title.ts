import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
} from "@traycer/protocol/host/terminal/unary-schemas";

export const DEFAULT_TERMINAL_TITLE = "New Terminal";

/**
 * A task's own directory on a host, and that host's name. A folderless task
 * terminal starts in the task's directory (`~/.traycer/epics/<epicId>`), whose
 * last segment is the task id: a title names it by the host instead.
 */
export interface TaskHomeDirectory {
  readonly epicId: string;
  readonly hostName: string;
}

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
  taskHome: TaskHomeDirectory | null,
): string {
  return terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
    currentCwd: "currentCwd" in session ? session.currentCwd : session.cwd,
    taskHome,
  });
}

export function terminalSessionTitle(input: {
  readonly title: string | null;
  readonly activeProcessName: string | null | undefined;
  readonly currentCwd: string | null | undefined;
  readonly taskHome: TaskHomeDirectory | null;
}): string {
  const title = input.title?.trim() ?? "";
  if (title.length > 0) return title;
  const activeProcessName = input.activeProcessName?.trim() ?? "";
  const cwdName = terminalDirectoryName(input.currentCwd);
  const taskHomeName =
    input.taskHome !== null && cwdName === input.taskHome.epicId
      ? input.taskHome.hostName
      : null;
  const directoryName = taskHomeName ?? cwdName;
  if (activeProcessName.length > 0) {
    return directoryName === null
      ? activeProcessName
      : `${directoryName} · ${activeProcessName}`;
  }
  // The host's name alone already says which terminal this is.
  if (taskHomeName !== null) return taskHomeName;
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
