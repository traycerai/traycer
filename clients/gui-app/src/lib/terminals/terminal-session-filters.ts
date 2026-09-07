import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";

/**
 * Shared "is this a live raw terminal?" predicate for every surface that lists user terminals (the terminals sidebar, the command-palette opener, and the setup card's liveness check).
 */
export function isVisibleRawTerminalSession(
  session: CanonicalTerminalSessionInfo,
): boolean {
  return session.sessionKind === "terminal" && session.status === "running";
}

/**
 * The epic-scoped variant, for surfaces that list one epic's terminals.
 * Since `terminal.list` became scope-tagged, a host's independent (landing) sessions travel alongside the epic ones, so an epic surface must narrow to its own epic before applying the raw predicate - otherwise a landing PTY surfaces inside an epic.
 */
export function isVisibleEpicTerminalSession(
  session: CanonicalTerminalSessionInfo,
  epicId: string,
): boolean {
  return (
    session.scope.kind === "epic" &&
    session.scope.epicId === epicId &&
    isVisibleRawTerminalSession(session)
  );
}
