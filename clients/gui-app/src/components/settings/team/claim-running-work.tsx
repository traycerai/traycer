import type { ReactNode } from "react";

/**
 * The claim confirm's line for the team work it stops, board C13's Proposal
 * character for character. Only the board's plural form exists; a count of
 * one has no words yet.
 */
function claimRunningChatsLine(chats: number): string {
  return `${chats} chats are running and will stop.`;
}

/**
 * How many of the team's chats are running on the computer, or `null` when
 * that is not known. No host method answers it yet (the head's ruling 191:
 * `environment.previewLocalFacts@1.0` gains a subject for it), so it is not
 * known, and the confirm shows the board's nothing-running form.
 */
function useClaimRunningChats(_hostId: string | null): number | null {
  return null;
}

/** The confirm's running-work line: none when nothing runs or it is not known. */
export function ClaimRunningWork(props: {
  readonly hostId: string | null;
}): ReactNode {
  const chats = useClaimRunningChats(props.hostId);
  if (chats === null || chats === 0) return null;
  return (
    <p className="text-ui-sm text-muted-foreground">
      {claimRunningChatsLine(chats)}
    </p>
  );
}
