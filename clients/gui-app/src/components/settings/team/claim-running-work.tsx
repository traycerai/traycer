import type { ReactNode } from "react";
import { useClaimRunningChats } from "./claim-running-chats";

function claimRunningChatsLine(chats: number): string {
  return chats === 1
    ? "1 chat is running and will stop."
    : `${chats} chats are running and will stop.`;
}

// Never the nothing-running form: an unread count is not 0.
const claimRunningChatsNotKnownLine = "Running chats will stop.";

export function ClaimRunningWork(props: {
  readonly hostId: string | null;
  readonly environmentId: string | null;
}): ReactNode {
  const running = useClaimRunningChats(props.hostId, props.environmentId);
  if (running.kind === "counted" && running.chats === 0) return null;
  return (
    <p className="text-ui-sm text-muted-foreground">
      {running.kind === "not-known"
        ? claimRunningChatsNotKnownLine
        : claimRunningChatsLine(running.chats)}
    </p>
  );
}
