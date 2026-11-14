import type { ReactNode } from "react";

/**
 * How many of the team's chats are running on the computer. `not-known` is
 * its own state, never folded into a count of 0: a failed read, a null answer
 * or a computer that does not answer the question says nothing about what is
 * running there.
 */
type ClaimRunningChats =
  | { readonly kind: "counted"; readonly chats: number }
  | { readonly kind: "not-known" };

/**
 * The claim confirm's line for the team work it stops, board C13's Proposal
 * character for character. Only the board's plural form exists; a count of
 * one has no words yet.
 */
function claimRunningChatsLine(chats: number): string {
  return `${chats} chats are running and will stop.`;
}

/**
 * What the confirm says when the count is not known. Not ruled (with the
 * head), so the slot holds no words and the confirm draws as the board's
 * nothing-running form until it is.
 */
const claimRunningChatsNotKnownLine: ReactNode = null;

/**
 * No host method answers the count yet (the head's ruling 191 gives
 * `environment.previewLocalFacts@1.0` a `{ kind: "computer" }` subject for
 * it), so it is not known.
 */
function useClaimRunningChats(_hostId: string | null): ClaimRunningChats {
  return { kind: "not-known" };
}

/** The confirm's running-work line, by what is known of the computer's chats. */
export function ClaimRunningWork(props: {
  readonly hostId: string | null;
}): ReactNode {
  const running = useClaimRunningChats(props.hostId);
  if (running.kind === "not-known") return claimRunningChatsNotKnownLine;
  if (running.chats === 0) return null;
  return (
    <p className="text-ui-sm text-muted-foreground">
      {claimRunningChatsLine(running.chats)}
    </p>
  );
}
