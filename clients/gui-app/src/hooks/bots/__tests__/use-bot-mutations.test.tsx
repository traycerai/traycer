/**
 * A member's post or reply adds a thread or a reply (Tracy Bots), so a
 * successful `bot.conversation.send` makes the channel's `bot.thread.list`
 * stale on the host the send went through - and on no other host, whose list
 * is that host's own read.
 *
 * Real hook over two hosts' mock messengers sharing one query client.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { hostQueryKeys } from "@/lib/query-keys";

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const SENDING_HOST_ID = mockRemoteHostEntry.hostId;
const OTHER_HOST_ID = mockLocalHostEntry.hostId;
const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const SEND: BotConversationSendRequest = {
  botId: BOT_ID,
  conversationId: "conversation-channel",
  text: "Please review the release",
  threadId: null,
};

function hostOver(
  entry: HostDirectoryEntry,
  queryClient: QueryClient,
  handlers: MockHandlerMap<HostRpcRegistry>,
): HostClient<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `${entry.hostId}-${String(++seq)}`,
    handlers,
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(entry);
}

/** A send through host B with `bot.thread.list` cached under both hosts. */
function mountSend(handlers: MockHandlerMap<HostRpcRegistry>): {
  readonly send: () => Promise<void>;
  readonly isStale: (hostId: string, method: string) => boolean;
} {
  const queryClient = new QueryClient();
  const sendingHost = hostOver(mockRemoteHostEntry, queryClient, handlers);
  const params = { botId: BOT_ID };
  for (const hostId of [SENDING_HOST_ID, OTHER_HOST_ID]) {
    queryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "bot.thread.list">(
        hostId,
        "bot.thread.list",
        params,
      ),
      { threads: [] },
    );
  }
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "bot.conversation.list">(
      SENDING_HOST_ID,
      "bot.conversation.list",
      params,
    ),
    { conversations: [] },
  );
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () => useBotConversationSendMutation(sendingHost),
    { wrapper },
  );
  return {
    send: async () => {
      await act(async () => {
        await result.current.mutateAsync(SEND).catch(() => undefined);
      });
    },
    isStale: (hostId, method) =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: hostQueryKeys.methodScope(hostId, method) })
        .some((query) => query.state.isInvalidated),
  };
}

describe("useBotConversationSendMutation", () => {
  it("makes the thread list stale on the host the send went through, and on no other host or method", async () => {
    const mounted = mountSend({
      "bot.conversation.send": () => ({
        messageId: "message-1",
        requestId: "request-1",
        delivery: "written",
        threadId: "thread-1",
      }),
    });
    expect(mounted.isStale(SENDING_HOST_ID, "bot.thread.list")).toBe(false);

    await mounted.send();

    expect(mounted.isStale(SENDING_HOST_ID, "bot.thread.list")).toBe(true);
    expect(mounted.isStale(OTHER_HOST_ID, "bot.thread.list")).toBe(false);
    expect(mounted.isStale(SENDING_HOST_ID, "bot.conversation.list")).toBe(
      false,
    );
  });

  it("leaves the thread list alone when the send is refused", async () => {
    const mounted = mountSend({
      "bot.conversation.send": () => {
        throw new Error("refused");
      },
    });

    await mounted.send();

    expect(mounted.isStale(SENDING_HOST_ID, "bot.thread.list")).toBe(false);
  });
});
