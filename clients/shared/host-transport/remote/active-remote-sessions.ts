/**
 * Live-session-evidence registry (Architecture §7, R4-B5): "a client holding
 * an open E2E session to a host renders it Online regardless of the lease —
 * the data path is firsthand truth; the lease is hearsay about a different
 * leg." Every independently-constructed `RemoteSession` for a host (one RPC
 * consumer, one durable stream consumer, the app-wide client, …) registers
 * itself here at construction; `hasReadyRemoteSession` is checked lazily by
 * the status-honesty derivation (`my-hosts-model.ts`) rather than pushed, so
 * a session mid-attempt (not yet `isReady()`) is correctly not counted as
 * evidence until it actually attaches.
 */

interface TrackedRemoteSession {
  isReady(): boolean;
}

const sessionsByHostId = new Map<string, Set<TrackedRemoteSession>>();

/** Registers a session for `hostId`; returns the disposer to call on close. */
export function registerActiveRemoteSession(
  hostId: string,
  session: TrackedRemoteSession,
): () => void {
  let sessions = sessionsByHostId.get(hostId);
  if (sessions === undefined) {
    sessions = new Set();
    sessionsByHostId.set(hostId, sessions);
  }
  sessions.add(session);
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const current = sessionsByHostId.get(hostId);
    if (current === undefined) {
      return;
    }
    current.delete(session);
    if (current.size === 0) {
      sessionsByHostId.delete(hostId);
    }
  };
}

/** True if any registered session for `hostId` is currently `isReady()`. */
export function hasReadyRemoteSession(hostId: string): boolean {
  const sessions = sessionsByHostId.get(hostId);
  if (sessions === undefined) {
    return false;
  }
  for (const session of sessions) {
    if (session.isReady()) {
      return true;
    }
  }
  return false;
}
