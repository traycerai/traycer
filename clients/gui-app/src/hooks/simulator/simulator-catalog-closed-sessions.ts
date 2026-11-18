import type {
  SimulatorCatalogIdentity,
  SimulatorCatalogRecord,
} from "@traycer/protocol/host/simulator/catalog-contracts";

/**
 * Sessions this window closed, per viewer and task. The host answers a close
 * before its catalog tombstone lands, so a read in between still lists the
 * session; filtering every later read keeps the row from coming back. Hosts
 * mint session ids as fresh ulids, so a closed id is never listed again
 * legitimately.
 */
const closedSessionsByScope = new Map<string, Set<string>>();

function scopeKey(userId: string, epicId: string): string {
  return JSON.stringify([userId, epicId]);
}

function sessionKey(hostId: string, sessionId: string): string {
  return JSON.stringify([hostId, sessionId]);
}

export function noteClosedSimulatorCatalogSession(
  userId: string,
  identity: SimulatorCatalogIdentity,
): void {
  const key = scopeKey(userId, identity.epicId);
  const closed = closedSessionsByScope.get(key) ?? new Set<string>();
  closed.add(sessionKey(identity.hostId, identity.sessionId));
  closedSessionsByScope.set(key, closed);
}

export function withoutClosedSimulatorCatalogSessions(
  userId: string,
  epicId: string,
  records: readonly SimulatorCatalogRecord[],
): readonly SimulatorCatalogRecord[] {
  const closed = closedSessionsByScope.get(scopeKey(userId, epicId));
  if (closed === undefined) return records;
  return records.filter(
    (record) => !closed.has(sessionKey(record.hostId, record.sessionId)),
  );
}

/** Test seam: forgets every closed session. */
export function resetClosedSimulatorCatalogSessionsForTests(): void {
  closedSessionsByScope.clear();
}
