import type { ReactNode } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  RoutingCard,
  type RoutingCardState,
} from "@/components/chat/fallback/routing-card";
import {
  fallbackGraceCardVisible,
  fallbackWaitingCardVisible,
} from "@/components/chat/fallback/fallback-state";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import type {
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

/**
 * The agent chat's routing card above a bot's box (Tracy Bots T86, decision
 * 117): while the session that answers it - the trunk under the channel, a
 * thread's session under its panel - is counting down to a switch, waiting
 * out a limit, or offering to switch back, the card says so with the agent
 * chat's own actions, unchanged. Nothing otherwise, and nothing for a
 * session not known yet (`sessionChatId` `null`).
 */
export function BotRoutingCard(props: {
  readonly botId: string;
  /** The host serving the tab. */
  readonly hostId: string;
  readonly sessionChatId: string | null;
}): ReactNode {
  const { botId, hostId, sessionChatId } = props;
  const handle = useChatSessionHandleForContainer(
    botId,
    sessionChatId ?? "",
    hostId,
    sessionChatId !== null,
  );
  if (handle === null || sessionChatId === null) return null;
  return (
    <SessionRoutingCard
      handle={handle}
      botId={botId}
      hostId={hostId}
      chatId={sessionChatId}
    />
  );
}

function SessionRoutingCard(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly hostId: string;
  readonly chatId: string;
}): ReactNode {
  const { handle, botId, hostId, chatId } = props;
  const client = useTabHostClient();
  const { pending, pendingReturn, canAct } = useStore(
    handle.store,
    useShallow((state) => ({
      pending: state.pendingFallback,
      pendingReturn: state.pendingReturn,
      // The standing the agent chat's card reads off its session: an owner
      // on an open stream may act; anyone else sees the card disabled.
      canAct:
        state.connectionStatus === "open" &&
        state.access !== null &&
        state.access.canAct,
    })),
  );
  const card = routingCardOf(pending, pendingReturn);
  if (card === null) return null;
  return (
    <div className="shrink-0 px-4 pt-2" data-testid="bot-routing-card">
      <RoutingCard
        state={card}
        client={client}
        chatId={chatId}
        epicId={botId}
        hostId={hostId}
        canAct={canAct}
      />
    </div>
  );
}

/**
 * Which card the session's routing state draws: each predicate checked on
 * its own, as the agent chat's composer does, so a state neither claims
 * draws nothing. Read BY VALUE: `undefined` is what clears a card.
 */
function routingCardOf(
  pending: PendingFallback | undefined,
  pendingReturn: PendingReturn | undefined,
): RoutingCardState | null {
  if (pending !== undefined && fallbackWaitingCardVisible(pending)) {
    return { kind: "waiting", pending };
  }
  if (pending !== undefined && fallbackGraceCardVisible(pending)) {
    return { kind: "countdown", pending };
  }
  if (pendingReturn !== undefined) {
    // No rate-limit advisory is drawn under a bot's box for the offer to
    // absorb.
    return { kind: "return", offer: pendingReturn, lowUsage: null };
  }
  return null;
}
