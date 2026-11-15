import type { ReactElement } from "react";
import { act, render, waitFor } from "@testing-library/react";
import {
  notifyManager,
  QueryClientProvider,
  timeoutManager,
  type QueryClient,
} from "@tanstack/react-query";
import { expect, vi } from "vitest";
import {
  BOT_ID,
  CHANNEL_ID,
} from "@/components/bots/__tests__/bot-turn-test-support";
import { TAB_HOST_ID } from "@/components/bots/__tests__/bot-channel-cloud-test-support";
import { BotTestRunnerHost } from "@/components/bots/__tests__/bot-test-runner-host";
import { BotChannelView } from "@/components/bots/bot-channel-view";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MobileTileCount } from "@/lib/layout/mobile-layout-form";
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
  /** How many tiles the installed app shows; `null` where the container decides. */
  readonly tiles: MobileTileCount | null;
  readonly extra: ReactElement | null;
}): void {
  render(
    <QueryClientProvider client={args.queryClient}>
      {args.extra}
      <BotTestRunnerHost>
        <TooltipProvider>
          <ChatExpansionTestProviders tileInstanceId="tile-1">
            <BotChannelView
              tiles={args.tiles}
              botId={BOT_ID}
              hostId={TAB_HOST_ID}
              boundHostId={TAB_HOST_ID}
              boundHostEpoch={1}
              botTitle="Release Bot"
              directive={null}
              appConversationChatId={CHANNEL_ID}
              trunkChatId="trunk-chat"
              onOpenTurn={vi.fn()}
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
 * Waits past everything a cursor read's answer can set off, so a check that
 * no advance was asked is made after the last place one could come from.
 * The chain, and what each step waits on (an event, never a clock):
 * - TanStack hands the answer to observers in `notifyManager`'s batch, so a
 *   callback scheduled behind it runs after React has been told;
 * - that `act` renders and runs the passive effect in
 *   `use-bot-read-while-presented.ts`, which calls `mutateAsync` as it runs,
 *   so an advance that is going to be asked is in flight when the `act` ends
 *   (and the host's handler, which records it, runs inside that call);
 * - `isMutating() === 0` is the event that the advance, if any, has settled.
 * A refusal to advance leaves nothing in flight, and the same wait returns.
 */
export async function settleCursorAdvances(
  queryClient: QueryClient,
): Promise<void> {
  await flushObservers();
  await waitFor(() => {
    expect(queryClient.isMutating()).toBe(0);
  });
  await flushObservers();
}

/**
 * What a notice says: its text without the dots that spin beside "Reconnecting…",
 * which the DOM carries as a leading braille character.
 */
export function noticeText(notice: HTMLElement): string {
  return notice.textContent.replace(/^[\u2800-\u28ff]/u, "");
}

/** Hands observers what the reads have settled: TanStack tells them in its own batch. */
export async function flushObservers(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(resolve));
  });
}

/** TanStack's default wait before a read's one retry. */
const RETRY_BACKOFF_MS = 1_000;

export interface QueryTimers {
  /** Resolves once a read's retry is waiting in its backoff. */
  readonly backoffWaiting: () => Promise<void>;
  /** Fires the retries waiting in their backoff. */
  readonly fireBackoff: () => Promise<void>;
  readonly restore: () => void;
}

/**
 * Holds the timers TanStack Query core sets (its retry backoff and its garbage
 * collection, its only two) so a case fires a read's retry as an explicit
 * event rather than by waiting. Give `restore` to the case's cleanup.
 */
export function holdQueryTimers(): QueryTimers {
  let nextId = 1;
  const held = new Map<number, () => void>();
  const delays = new Map<number, number>();
  timeoutManager.setTimeoutProvider({
    setTimeout: (callback, delay) => {
      const id = nextId++;
      held.set(id, callback);
      delays.set(id, delay);
      return id;
    },
    clearTimeout: (id) => {
      if (typeof id !== "number") return;
      held.delete(id);
      delays.delete(id);
    },
    // Not held. The provider's ids are numbers, and a runtime's interval
    // handle coerces to its id.
    setInterval: (callback, delay) => Number(setInterval(callback, delay)),
    clearInterval: (id) => clearInterval(id),
  });
  const waiting = (): ReadonlyArray<number> =>
    [...delays]
      .filter(([, delay]) => delay === RETRY_BACKOFF_MS)
      .map(([id]) => id);
  return {
    backoffWaiting: () =>
      waitFor(() => {
        expect(waiting()).not.toHaveLength(0);
      }),
    fireBackoff: async () => {
      await act(async () => {
        for (const id of waiting()) {
          const callback = held.get(id);
          held.delete(id);
          delays.delete(id);
          callback?.();
        }
        await new Promise<void>((resolve) => notifyManager.schedule(resolve));
      });
    },
    restore: () => {
      timeoutManager.setTimeoutProvider({
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
        setInterval: (callback, delay) => setInterval(callback, delay),
        clearInterval: (id) => clearInterval(id),
      });
    },
  };
}
