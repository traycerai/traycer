import type {
  BrowserSessionInfo,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";

/**
 * Session-list projection shared by the primary-host provider and the remote
 * PiP fan-in. `null` for a frame that carries no list change (captions, burst
 * markers, request/response frames), so a caller can keep dispatching.
 */
export function browserSessionsReducer(
  current: readonly BrowserSessionInfo[],
  frame: BrowserSessionsServerFrame,
): readonly BrowserSessionInfo[] | null {
  if (frame.kind === "snapshot") return frame.sessions;
  if (frame.kind === "sessionCreated" || frame.kind === "sessionUpdated") {
    const next = frame.session;
    const existing = current.findIndex(
      (session) => session.sessionId === next.sessionId,
    );
    if (existing === -1) return [...current, next];
    return current.map((session, index) =>
      index === existing ? next : session,
    );
  }
  if (frame.kind === "sessionClosed") {
    return current.filter((session) => session.sessionId !== frame.sessionId);
  }
  return null;
}
