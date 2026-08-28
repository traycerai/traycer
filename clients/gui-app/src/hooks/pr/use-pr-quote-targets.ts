import { useMemo } from "react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import type { PrQuoteTarget } from "@/lib/pr/pr-quote";
import {
  useEpicChatRecords,
  useEpicTerminalAgentRecords,
} from "@/lib/epic-selectors";
import { displayTitle } from "@/lib/display-title";
import {
  usePrDetailTargetId,
  usePrDetailViewStore,
} from "@/stores/epics/pr-detail-view-store";

export interface PrQuoteTargetSelection {
  readonly target: PrQuoteTarget | null;
  readonly targets: readonly PrQuoteTarget[];
  readonly selectTarget: (target: PrQuoteTarget) => void;
}

/**
 * Every chat and terminal agent in the epic, most recently active first, plus
 * the one this PR currently sends to.
 *
 * The default pick is the PR's own OWNER when it resolves - the chat whose
 * worktree binding produced this branch is overwhelmingly the right place to
 * send a finding about it - and otherwise the most recently active chat. An
 * explicit choice always wins, and is remembered per PR.
 *
 * A stored id that no longer resolves (chat deleted) falls back to the default
 * rather than pinning a dead target, which is why the store keeps a bare id
 * instead of a resolved target object.
 */
export function usePrQuoteTargets(args: {
  readonly viewKey: string;
  readonly owners: readonly PrOwnerRef[];
}): PrQuoteTargetSelection {
  const chats = useEpicChatRecords();
  const agents = useEpicTerminalAgentRecords();
  const storedTargetId = usePrDetailTargetId(args.viewKey);
  const setTargetId = usePrDetailViewStore((state) => state.setTargetId);

  const targets = useMemo<readonly PrQuoteTarget[]>(() => {
    const entries: PrQuoteTarget[] = [
      ...chats.map((chat) => ({
        id: chat.id,
        kind: "chat" as const,
        title: displayTitle(chat.title, "chat"),
        updatedAt: chat.updatedAt,
      })),
      ...agents.map((agent) => ({
        id: agent.id,
        kind: "terminal-agent" as const,
        title: displayTitle(agent.title, "terminal-agent"),
        updatedAt: agent.updatedAt,
      })),
    ];
    return entries.sort((left, right) => right.updatedAt - left.updatedAt);
  }, [chats, agents]);

  const target = useMemo<PrQuoteTarget | null>(() => {
    if (storedTargetId !== null) {
      const stored = targets.find((entry) => entry.id === storedTargetId);
      if (stored !== undefined) return stored;
    }
    for (const owner of args.owners) {
      const owned = targets.find((entry) => entry.id === owner.ownerId);
      if (owned !== undefined) return owned;
    }
    return targets[0] ?? null;
  }, [storedTargetId, targets, args.owners]);

  const selection = useMemo<PrQuoteTargetSelection>(
    () => ({
      target,
      targets,
      selectTarget: (next: PrQuoteTarget) => setTargetId(args.viewKey, next.id),
    }),
    [target, targets, setTargetId, args.viewKey],
  );
  return selection;
}
