/**
 * Where a team host's `TEAM_MEMBER_REMOVED` fatal reaches the app. A team host
 * is reached over the relay, and it ends a removed member's session there with
 * that fatal, so the relay session reports its host here when it closes with
 * it, and the app's removal close turns the first report for a team into its
 * one toast and one close of the team's tiles. Main-thread module state: relay
 * sessions are built on the main thread, the epic worker's streams included.
 */
type TeamMemberRemovedCloseListener = (hostId: string) => void;

const listeners = new Set<TeamMemberRemovedCloseListener>();

/** A session on `hostId` was closed because this person left its team. */
export function reportTeamMemberRemovedClose(hostId: string): void {
  for (const listener of listeners) listener(hostId);
}

export function subscribeTeamMemberRemovedClose(
  listener: TeamMemberRemovedCloseListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
