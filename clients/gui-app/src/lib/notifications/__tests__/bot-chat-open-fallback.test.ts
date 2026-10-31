import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { IHostDirectoryService } from "@traycer-clients/shared/host-client/host-runtime";

const navigateSpy = vi.hoisted(() => vi.fn<(options: unknown) => void>());

/** `null` is "no host runtime mounted", the state a bot row can reach. */
const bindingState = vi.hoisted<{
  current: {
    readonly hostClient: unknown;
    readonly directory: IHostDirectoryService;
  } | null;
}>(() => ({ current: null }));

vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("@/lib/host", () => ({
  useHostBinding: () => bindingState.current,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import { useNotificationActivation } from "@/hooks/notifications/use-notification-activation";
import { NO_DEVICE_AVAILABLE } from "@/lib/composer/landing-placement";
import { openChatSearchResult } from "@/lib/chat-search/open-chat-search-result";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { rowFromHostEntry } from "@/stores/notifications/merged-notifications";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";

/**
 * A bot's chat container id IS the bot id, so a chat route that does not
 * know the id is a bot's falls back to an EPIC tab keyed by it, a tab no
 * host can open. Two doors reach that fallback and both must end at the
 * bot's tab, or at nothing with a reason:
 *  - a chat search hit (a team host answers with the bot id as `epicId`);
 *  - a bot row activated while no device is bound (the server writes the row
 *    with no host, so the bot's tab has nowhere to open).
 */

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** The intents that open an epic tab keyed by the bot id. */
function epicIntentsKeyedByBotId(
  intents: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  return intents.filter(
    (intent) =>
      typeof intent === "object" &&
      intent !== null &&
      "params" in intent &&
      typeof intent.params === "object" &&
      intent.params !== null &&
      "epicId" in intent.params &&
      intent.params.epicId === BOT_ID,
  );
}

beforeEach(async () => {
  __resetTabNavigationControllerForTesting();
  __resetTabSyncCoordinatorForTesting();
  installTabSyncCoordinator({ readyPromise: Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  useBotTabsStore.setState({ tabs: {} });
  useBotTabLandingStore.setState({ byBotId: {} });
  navigateSpy.mockReset();
  navigateSpy.mockImplementation(() => undefined);
  vi.mocked(toast.error).mockReset();
  bindingState.current = null;
});

describe("a chat search hit in a bot's chat", () => {
  function searchHit(chatId: string): ReadonlyArray<unknown> {
    const navigate = vi.fn<(options: unknown) => Promise<void>>(() =>
      Promise.resolve(),
    );
    openChatSearchResult(
      navigate,
      { hostId: "host-team", epicId: BOT_ID, chatId, messageId: "row-1" },
      { effectiveHostId: "host-team", now: 1_000 },
    );
    return navigate.mock.calls.map((call) => call[0]);
  }

  // Which of the bot's chats the hit is in (channel, thread, session) is the
  // tab's to resolve: bot-tab-surface.test.tsx lands each kind.
  it("opens the bot's tab and hands it the hit's chat and row, never an epic tab keyed by the bot id", () => {
    const intents = searchHit("chat-1");

    expect(epicIntentsKeyedByBotId(intents)).toEqual([]);
    expect(intents).toContainEqual(
      expect.objectContaining({ params: { botId: BOT_ID } }),
    );
    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toMatchObject(
      { hostId: "host-team" },
    );
    expect(useBotTabLandingStore.getState().byBotId[BOT_ID]).toEqual({
      kind: "chat",
      chatId: "chat-1",
      messageId: "row-1",
    });
  });
});

describe("a bot row activated with no device", () => {
  // The server's row: no host, the bot id in `epicId`, the thread in `chatId`.
  const row = rowFromHostEntry({
    id: "bot.reply:message-1",
    updatedAt: 10,
    readAt: null,
    kind: "host.operation.finished",
    sourceRef: "message-1",
    severity: "done",
    outcome: "completed",
    epicId: BOT_ID,
    chatId: "thread-1",
    payload: {
      kind: "bot_conversation",
      event: "reply",
      operation: "bot.reply",
      title: "Tracy",
      message: "Something in the thread",
      botId: BOT_ID,
      botTitle: "Tracy",
      conversationId: "conversation-1",
      threadId: "thread-1",
      messageId: "message-1",
      authorUserId: null,
      mention: false,
    },
  });

  function wrapper(props: { readonly children: ReactNode }): ReactNode {
    return createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      props.children,
    );
  }

  it("opens nothing, keeps the row unread and says why", () => {
    const { payload } = row;
    if (payload === null) throw new Error("the bot row carried no payload");
    const onResult = vi.fn();
    const hook = renderHook(() => useNotificationActivation(), { wrapper });

    act(() => {
      hook.result.current.activate({
        payload,
        receivedAt: 2_000,
        feedId: row.feedId,
        originHostId: null,
        onResult,
      });
    });

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("failure");
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(NO_DEVICE_AVAILABLE);
  });
});
