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
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { BotConversationSendRequest } from "@traycer/protocol/host/bot/conversation-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { FloorEnforcingMessenger } from "@/hooks/config/__tests__/floor-enforcing-messenger";
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
  announcementId: null,
  redeliver: null,
  supersedes: null,
  answer: null,
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
  // The person's follows of the bot's threads, which the send may add to.
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "bot.threadFollow.read">(
      SENDING_HOST_ID,
      "bot.threadFollow.read",
      params,
    ),
    { follows: {} },
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

  it("makes the bot's follow read stale once the send lands, since a send follows the person to its thread, and not when it is refused", async () => {
    const accepted = mountSend({
      "bot.conversation.send": () => ({
        messageId: "message-1",
        requestId: "request-1",
        delivery: "written",
        threadId: "thread-1",
      }),
    });
    expect(accepted.isStale(SENDING_HOST_ID, "bot.threadFollow.read")).toBe(
      false,
    );
    await accepted.send();
    expect(accepted.isStale(SENDING_HOST_ID, "bot.threadFollow.read")).toBe(
      true,
    );

    const refused = mountSend({
      "bot.conversation.send": () => {
        throw new Error("refused");
      },
    });
    await refused.send();
    expect(refused.isStale(SENDING_HOST_ID, "bot.threadFollow.read")).toBe(
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

/**
 * A retry (`redeliver`) and an edit's replacement (`supersedes`) carry a
 * dispatch-time floor of `bot.conversation.send@1.1`: a host below it would
 * drop both fields and take the message as a new post. The messenger enforces
 * the floor with the transports' own predicate and error, so a hook that
 * dropped the option reaches the handler and these tests redden.
 */
describe("useBotConversationSendMutation's dispatch-time version floor", () => {
  const V10: SchemaVersion = { major: 1, minor: 0 };
  const V11: SchemaVersion = { major: 1, minor: 1 };
  const V12: SchemaVersion = { major: 1, minor: 2 };

  function floorFixture(negotiated: SchemaVersion): {
    readonly messenger: FloorEnforcingMessenger<HostRpcRegistry>;
    readonly handled: BotConversationSendRequest[];
    readonly send: (variables: BotConversationSendRequest) => Promise<unknown>;
  } {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const handled: BotConversationSendRequest[] = [];
    const messenger = new FloorEnforcingMessenger<HostRpcRegistry>(
      {
        registry: hostRpcRegistry,
        requestId: () => "req-send-floor",
        handlers: {
          "bot.conversation.send": (params) => {
            handled.push(params);
            return {
              messageId: "message-1",
              requestId: "request-1",
              delivery: "written",
              threadId: null,
            };
          },
        },
      },
      new Map([["bot.conversation.send", negotiated]]),
    );
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
    const client = spine.createRequester(mockRemoteHostEntry);
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => useBotConversationSendMutation(client),
      {
        wrapper,
      },
    );
    return {
      messenger,
      handled,
      send: (variables) =>
        result.current.mutateAsync(variables).then(
          () => null,
          (error: unknown) => error,
        ),
    };
  }

  const RETRY: BotConversationSendRequest = {
    ...SEND,
    redeliver: { requestId: "req-failed" },
  };
  const EDIT: BotConversationSendRequest = {
    ...SEND,
    supersedes: "req-failed",
    answer: null,
  };

  it.each([
    ["a retry", RETRY],
    ["an edit's replacement", EDIT],
  ])(
    "refuses %s on a host that negotiated 1.0 before it leaves: no handler runs and no request is sent",
    async (_name, variables) => {
      const f = floorFixture(V10);

      const failure = await act(() => f.send(variables));

      expect(failure).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
      expect(f.handled).toEqual([]);
      expect(f.messenger.dispatched).toEqual([]);
      expect(f.messenger.calls).toEqual([]);
    },
  );

  it.each([
    ["a retry", RETRY],
    ["an edit's replacement", EDIT],
  ])(
    "sends %s, floor attached, to a host that negotiated 1.1",
    async (_name, variables) => {
      const f = floorFixture(V11);

      const failure = await act(() => f.send(variables));

      expect(failure).toBeNull();
      expect(f.handled).toEqual([variables]);
      expect(f.messenger.calls[0]?.requiredHostMethodVersion).toEqual({
        method: "bot.conversation.send",
        version: { major: 1, minor: 1 },
      });
    },
  );

  const ANSWER: BotConversationSendRequest = {
    ...SEND,
    text: "Now",
    answer: {
      questionMessageId: "bot-question:req-q",
      questionIndex: 0,
      skipped: false,
    },
  };

  it("refuses a question card's answer on a host that negotiated 1.1 before it leaves, so it is never taken as a plain post", async () => {
    const f = floorFixture(V11);

    const failure = await act(() => f.send(ANSWER));

    expect(failure).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(f.handled).toEqual([]);
    expect(f.messenger.dispatched).toEqual([]);
    expect(f.messenger.calls).toEqual([]);
  });

  it("sends a question card's answer, floor attached, to a host that negotiated 1.2", async () => {
    const f = floorFixture(V12);

    const failure = await act(() => f.send(ANSWER));

    expect(failure).toBeNull();
    expect(f.handled).toEqual([ANSWER]);
    expect(f.messenger.calls[0]?.requiredHostMethodVersion).toEqual({
      method: "bot.conversation.send",
      version: { major: 1, minor: 2 },
    });
  });

  it("sends a plain post to a 1.0 host with no floor, which has always been allowed to take it", async () => {
    const f = floorFixture(V10);

    const failure = await act(() => f.send(SEND));

    expect(failure).toBeNull();
    expect(f.handled).toEqual([SEND]);
    expect(f.messenger.calls[0]?.requiredHostMethodVersion).toBeNull();
  });
});
