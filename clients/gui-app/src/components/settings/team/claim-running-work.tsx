import type { ReactNode } from "react";
import { useClaimRunningChats } from "./claim-running-chats";

/**
 * The claim confirm's line for the team work it stops: board C13's Proposal,
 * and board C30's Proposal (row 5) for exactly one chat, built while that
 * board waits.
 */
function claimRunningChatsLine(chats: number): string {
  return chats === 1
    ? "1 chat is running and will stop."
    : `${chats} chats are running and will stop.`;
}

/**
 * What the confirm says when the count is not known, ruled by the owner
 * (ruling 210). Never the nothing-running form: an unread count is not 0.
 */
const claimRunningChatsNotKnownLine = "Running chats will stop.";

/** The confirm's running-work line, by what is known of the computer's chats. */
export function ClaimRunningWork(props: {
  readonly hostId: string | null;
}): ReactNode {
  const running = useClaimRunningChats(props.hostId);
  if (running.kind === "counted" && running.chats === 0) return null;
  return (
    <p className="text-ui-sm text-muted-foreground">
      {running.kind === "not-known"
        ? claimRunningChatsNotKnownLine
        : claimRunningChatsLine(running.chats)}
    </p>
  );
}
