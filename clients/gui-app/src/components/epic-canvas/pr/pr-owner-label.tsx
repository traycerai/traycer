import type { ReactNode } from "react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import {
  useChatById,
  useEpicTerminalAgent,
  type EpicChatProjection,
  type EpicTuiAgentProjection,
} from "@/lib/epic-selectors";
import { displayTitle, tuiAgentDisplayTitle } from "@/lib/display-title";
import { cn } from "@/lib/utils";

const DELETED_OWNER_LABEL: Record<PrOwnerRef["ownerKind"], string> = {
  chat: "Removed chat",
  "terminal-agent": "Removed terminal agent",
};

function resolvePrOwnerLabel(args: {
  readonly owner: PrOwnerRef;
  readonly chat: EpicChatProjection | null;
  readonly tuiAgent: EpicTuiAgentProjection | null;
}): string {
  if (args.owner.ownerKind === "chat") {
    if (args.chat === null) return DELETED_OWNER_LABEL.chat;
    return displayTitle(args.chat.title, "chat");
  }
  if (args.tuiAgent === null) return DELETED_OWNER_LABEL["terminal-agent"];
  return tuiAgentDisplayTitle({
    title: args.tuiAgent.title,
    harnessId: args.tuiAgent.harnessId,
  });
}

/**
 * The owning chat/terminal-agent title shown as a PR row's secondary text.
 * Both lookup hooks are called unconditionally (rules-of-hooks) with the id
 * gated to `null` for the kind that doesn't apply, so only one ever resolves
 * a record. A deleted owner (orphaned worktree binding, no cascade - tech
 * plan's "Chat deleted" failure row) falls back to a neutral label instead
 * of rendering nothing.
 */
export function PrOwnerLabel(props: {
  readonly owner: PrOwnerRef | null;
  readonly className: string | undefined;
}): ReactNode {
  const chat = useChatById(
    props.owner?.ownerKind === "chat" ? props.owner.ownerId : null,
  );
  const tuiAgent = useEpicTerminalAgent(
    props.owner?.ownerKind === "terminal-agent" ? props.owner.ownerId : null,
  );
  if (props.owner === null) return null;
  const label = resolvePrOwnerLabel({ owner: props.owner, chat, tuiAgent });
  return (
    <span
      className={cn(
        "truncate text-ui-xs text-muted-foreground",
        props.className,
      )}
    >
      {label}
    </span>
  );
}
