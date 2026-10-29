import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import {
  BOT_ID,
  CHANNEL_ID,
  HOST_ID,
  TRUNK_ID,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import {
  useBotOpenThreadStore,
  useBotRail,
  type BotOpenTurn,
} from "@/stores/bots/bot-open-thread-store";

const resolveMember: BotMemberResolver = () => null;

/**
 * The channel as the bot tab holds it: the rail's one slot is the real store,
 * and a thread or a turn is set in it the way the tab's setters do.
 */
function Channel(): ReactNode {
  const rail = useBotRail(BOT_ID);
  const setRail = useBotOpenThreadStore((s) => s.setRail);
  const openThread = rail?.kind === "thread" ? rail : null;
  const openTurn = rail?.kind === "turn" ? rail : null;
  return (
    <BotChannelView
      botId={BOT_ID}
      hostId={HOST_ID}
      boundHostId="host-runs-bot"
      boundHostEpoch={1}
      botTitle="Release Bot"
      directive={null}
      appConversationChatId={CHANNEL_ID}
      trunkChatId={TRUNK_ID}
      resolveMember={resolveMember}
      tasks={[]}
      openThread={openThread}
      onOpenThread={(open) =>
        setRail(BOT_ID, open === null ? null : { kind: "thread", ...open })
      }
      openTurn={openTurn}
      onOpenTurn={(open: BotOpenTurn | null) =>
        setRail(BOT_ID, open === null ? null : { kind: "turn", ...open })
      }
      onOpenActivity={vi.fn()}
    />
  );
}

/**
 * The bot's channel with the rail beside it, over the providers a bot tab has:
 * no chat open-state stores above the rail (the transcript lists bring their own), and the rail's one slot is the real store.
 */
export function MountedChannel(): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <Channel />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
