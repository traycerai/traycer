import type { QueryClient } from "@tanstack/react-query";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotConversationListResponse,
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

/**
 * The REAL `bot.conversation.list` and `bot.thread.list` reads under a bot's
 * channel: a host client whose messenger answers each ask from a script the
 * case sets, so a failure the host reports reaches the view the way it does
 * in the app.
 */

export const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
/** The host the tab's client serves; every read of the view is keyed under it. */
export const TAB_HOST_ID = mockRemoteHostEntry.hostId;
export const CHANNEL_ID = "conversation-channel";
export const THREAD_ID = "thread-1";
export const POST_ID = "post-1";

export const CHANNEL_FAILURE_COPY = "Couldn't load this bot's channel.";

export const LISTED_THREAD: BotThreadSummary = {
  threadId: THREAD_ID,
  conversationId: CHANNEL_ID,
  sessionChatId: "session-1",
  anchor: {
    messageId: POST_ID,
    requestId: "req-thread",
    senderUserId: "user-teammate",
    sentAt: 1_000,
    resolvedAt: null,
    excerpt: null,
  },
  replyCount: 1,
  lastReplyAt: 2_000,
  openRequestCount: 1,
  costUsd: null,
};

export const OPEN_LISTED_THREAD: BotOpenThread = {
  anchorMessageId: POST_ID,
  announcement: false,
  anchorKind: null,
  sent: null,
};

export const CHANNEL_LIST: BotConversationListResponse = {
  conversations: [
    {
      conversationId: CHANNEL_ID,
      botId: BOT_ID,
      title: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

export const THREAD_LIST: BotThreadListResponse = {
  threads: [LISTED_THREAD],
  trunkCostUsd: null,
  threadAnchors: null,
  nextCursor: null,
  total: 1,
};

/** What the host answers each read with next; a case swaps these between asks. */
export interface HostScript {
  conversationList: () => Promise<BotConversationListResponse>;
  threadList: () => Promise<BotThreadListResponse>;
  conversationListCalls: number;
  threadListCalls: number;
}

export function freshScript(): HostScript {
  return {
    conversationList: () => Promise.resolve(CHANNEL_LIST),
    threadList: () => Promise.resolve(THREAD_LIST),
    conversationListCalls: 0,
    threadListCalls: 0,
  };
}

/** The tab's host client, over a messenger that answers from `script`. */
export function hostClientAnswering(
  script: HostScript,
  queryClient: QueryClient,
): HostRequester<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${String(++seq)}`,
    handlers: {
      "bot.conversation.list": () => {
        script.conversationListCalls += 1;
        return script.conversationList();
      },
      "bot.thread.list": () => {
        script.threadListCalls += 1;
        return script.threadList();
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockRemoteHostEntry);
}

/** The app's query client with transport-level retries off: one ask is one request. */
export function appClientWithoutRetries(): QueryClient {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  return client;
}
