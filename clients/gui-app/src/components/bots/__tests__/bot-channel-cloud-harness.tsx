import type { ReactElement } from "react";
import { act, render } from "@testing-library/react";
import {
  notifyManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { vi } from "vitest";
import {
  BOT_ID,
  CHANNEL_ID,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { TAB_HOST_ID } from "@/components/bots/__tests__/bot-channel-cloud-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { hostQueryKeys } from "@/lib/query-keys";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

const resolveMember: BotMemberResolver = () => null;

/**
 * The real `BotChannelView` of the bot, over `queryClient`, with `extra`
 * rendered beside it (a doorbell, say). The suite mocks the tab's host client
 * and the hooks around the view; this is the one tree they all mount.
 */
export function renderRealChannel(args: {
  readonly queryClient: QueryClient;
  readonly openThread: BotOpenThread | null;
  readonly extra: ReactElement | null;
}): void {
  render(
    <QueryClientProvider client={args.queryClient}>
      {args.extra}
      <BotTestRunnerHost>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              tiles={null}
              botId={BOT_ID}
              hostId={TAB_HOST_ID}
              boundHostId={TAB_HOST_ID}
              boundHostEpoch={1}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId="trunk-chat"
              onOpenTurn={vi.fn()}
              onOpenSession={vi.fn()}
              landOn={null}
              openMemory={null}
              onOpenMemory={vi.fn()}
              environmentId="env-1"
              botNameOf={() => null}
              environmentBots={null}
              openExchange={null}
              exchangeRail={{ open: () => undefined, close: () => undefined }}
              resolveMember={resolveMember}
              tasks={[]}
              surfaceActions={null}
              openThread={args.openThread}
              onOpenThread={vi.fn()}
              setupHistory={null}
            />
          </ChatExpansionTestProviders>
        </TooltipProvider>
      </BotTestRunnerHost>
    </QueryClientProvider>,
  );
}

/**
 * Asks the read again and waits until what the answer changed is on screen:
 * TanStack hands observers their result through its own scheduler, so a check
 * made as soon as the refetch settles would look at the frame before it.
 */
export async function refetchRead(
  queryClient: QueryClient,
  method: "bot.conversation.list" | "bot.thread.list",
): Promise<void> {
  await act(async () => {
    await queryClient.refetchQueries({
      queryKey: hostQueryKeys.methodScope(TAB_HOST_ID, method),
    });
    await new Promise<void>((resolve) => notifyManager.schedule(resolve));
  });
}

/**
 * What a notice says: its text without the dots that spin beside "Reconnecting…",
 * which the DOM carries as a leading braille character.
 */
export function noticeText(notice: HTMLElement): string {
  return notice.textContent.replace(/^[\u2800-\u28ff]/u, "");
}
