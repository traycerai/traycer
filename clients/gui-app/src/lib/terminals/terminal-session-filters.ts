import type { TerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";

export function isVisibleTerminalSidebarSession(
  session: TerminalSessionInfo,
): boolean {
  // Plain terminals (including a worktree-setup shell, which stays a live
  // interactive terminal after setup finishes) are shown while their PTY is
  // running; an exited session is on its way out via grace eviction.
  return session.sessionKind === "terminal" && session.status === "running";
}
