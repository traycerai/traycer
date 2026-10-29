import { StrictMode, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import {
  BOT_ID,
  CHANNEL_ID,
  ENVIRONMENT_ID,
  HOST_ID,
  OTHER_BOT_ID,
  OTHER_BOT_TITLE,
  TRUNK_ID,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  BotMemoryContext,
  type BotMemoryAccess,
} from "@/components/bots/bot-memory-context";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import {
  memoryRailOver,
  useBotOpenThreadStore,
  useBotRail,
  type BotOpenTurn,
} from "@/stores/bots/bot-open-thread-store";

const resolveMember: BotMemberResolver = () => null;

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

/**
 * The channel as the bot tab holds it: the rail's one slot is the real store,
 * and a thread or a turn is set in it the way the tab's setters do.
 */
function Channel(): ReactNode {
  const rail = useBotRail(BOT_ID);
  const setRail = useBotOpenThreadStore((s) => s.setRail);
  const openThread = rail?.kind === "thread" ? rail : null;
  const openTurn = rail?.kind === "turn" ? rail : null;
  const openMemory = rail?.kind === "memory" ? rail : null;
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
      surfaceActions={null}
      openThread={openThread}
      onOpenThread={(open) =>
        setRail(BOT_ID, open === null ? null : { kind: "thread", ...open })
      }
      openTurn={openTurn}
      onOpenTurn={(open: BotOpenTurn | null) =>
        setRail(BOT_ID, open === null ? null : { kind: "turn", ...open })
      }
      openMemory={openMemory}
      onOpenMemory={(open) =>
        setRail(BOT_ID, open === null ? null : { kind: "memory", ...open })
      }
      environmentId={ENVIRONMENT_ID}
      botNameOf={(botId) => (botId === OTHER_BOT_ID ? OTHER_BOT_TITLE : null)}
      onOpenActivity={vi.fn()}
    />
  );
}

/**
 * The channel as the bot tab draws it with the bot's identity and its
 * memory (T87): the bot's name opens its card, whose memory row opens the
 * memory over the rail the way the tab's opener does (`memoryRailOver`).
 */
function KnowingChannel(): ReactNode {
  const rail = useBotRail(BOT_ID);
  const setRail = useBotOpenThreadStore((s) => s.setRail);
  const memory = useMemo(
    (): BotMemoryAccess => ({
      hostId: HOST_ID,
      botId: BOT_ID,
      environmentId: ENVIRONMENT_ID,
      open: () => setRail(BOT_ID, memoryRailOver(rail)),
    }),
    [rail, setRail],
  );
  return (
    <BotIdentityContext value={IDENTITY}>
      <BotMemoryContext value={memory}>
        <Channel />
      </BotMemoryContext>
    </BotIdentityContext>
  );
}

/** {@link MountedChannel} with the bot's identity and memory provided. */
export function MountedKnowingChannel(): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <KnowingChannel />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>
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
