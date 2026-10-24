import { createContext, use } from "react";

const NO_HOSTS: ReadonlySet<string> = new Set();

/**
 * The task's hosts this host's principal cannot reach (`reach ===
 * "other_principal"` in the task host rows), provided
 * once by the Agents panel so each row reads a set instead of subscribing to
 * the query. Empty when the rows are absent: an unknown reach is never shown
 * as unreachable.
 */
export const TaskHostReachContext =
  createContext<ReadonlySet<string>>(NO_HOSTS);

/**
 * Whether an agent's owner host is another principal's. From `reach` alone:
 * connectivity is the lock's, and a host can be online and out of reach, or
 * offline and reachable.
 */
export function useOwnerHostNotReachable(ownerHostId: string | null): boolean {
  const hostIds = use(TaskHostReachContext);
  return ownerHostId !== null && hostIds.has(ownerHostId);
}
