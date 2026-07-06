import type { TerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";

/**
 * Shared "is this a live raw terminal?" predicate for every surface that lists
 * user terminals (the terminals sidebar, the command-palette opener, and the
 * setup card's liveness check). `terminal.list` also returns `terminal-agent`
 * backing PTYs; those belong to the TUI-agent surfaces, so they are excluded
 * here to avoid double-listing an agent as a plain terminal. Plain terminals
 * (including a worktree-setup shell, which stays a live interactive terminal
 * after setup finishes) are shown while their PTY is running; an exited session
 * is on its way out via grace eviction.
 */
export function isVisibleRawTerminalSession(
  session: TerminalSessionInfo,
): boolean {
  return session.sessionKind === "terminal" && session.status === "running";
}
