/**
 * A reply in a thread moves the channel without a poll (Tracy Bots T43b):
 * the bot's `bot.subscribe` snapshot carries `conversationsRevision`, and a
 * changed value reads the bot's `bot.thread.list` again, even while an
 * earlier read of the same key is still in flight. The real subscription
 * hook and the real thread-list query run over a stub stream session and the
 * mock host messenger, which holds each read until the test answers it.
 */
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { BotSubscribeServerFrame } from "@traycer/protocol/host/bot/schemas";
import type { BotThreadListResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  ParamsOf,
  StreamMethodSupport,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { StreamParamsProvider } from "@traycer-clients/shared/host-transport/i-stream-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  __resetBotSubscriptionsForTesting,
  useBotSubscriptionForClient,
} from "@/hooks/bots/use-bot-subscription";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = mockLocalHostEntry.hostId;

class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  readonly close = vi.fn();

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(_handler: StatusChangeHandler): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return null;
  }

  requestReconnect(): void {}

  emit(frame: BotSubscribeServerFrame): void {
    this.serverFrameHandler(frame, null);
  }
}

/** A stream client whose every subscribe is `session`; nothing else is reached. */
class StubHostStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId = "stub-stream-client";

  constructor(private readonly session: IStreamSession) {}

  isReady(): boolean {
    return true;
  }

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: StreamParamsProvider<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {}

  isClosed(): boolean {
    return false;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => {};
  }

  notifyBearerRotated(): void {}
  notifyCloudVerdictChanged(): void {}

  reconnectAll(_reason: string, _options: ReconnectAllOptions): void {}

  getMethodSupport(): StreamMethodSupport {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => {};
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => {};
  }
}

function snapshot(
  conversationsRevision: number | null,
  openRequestCount: number,
): BotSubscribeServerFrame {
  return {
    kind: "snapshot",
    bot: {
      botId: BOT_ID,
      environmentId: "env-1",
      createdByUserId: "user-1",
      title: "Nightly triage",
      harness: "claude",
      model: "claude-opus-5-5",
      effort: null,
      profile: null,
      trunkChatId: "trunk-1",
      boundHostId: HOST_ID,
      hostEpoch: 0,
      createdAt: 1,
      archivedAt: null,
      directive: null,
    },
    tasks: [],
    openRequestCount,
    conversationsRevision,
    boundHost: { hostId: HOST_ID, epoch: 0, isThisHost: true },
    hasBinaryPayload: false,
  };
}

function fixture(): {
  readonly session: StubSession;
  readonly listReads: { value: number };
  readonly pendingReads: Array<(response: BotThreadListResponse) => void>;
  readonly queryClient: QueryClient;
  readonly threadListKey: QueryKey;
  readonly render: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const listReads = { value: 0 };
  // Each `bot.thread.list` dispatch parks here instead of answering inline,
  // so the test controls exactly when (and with what body) it resolves.
  const pendingReads: Array<(response: BotThreadListResponse) => void> = [];
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${listReads.value + 1}`,
    handlers: {
      "bot.thread.list": () => {
        listReads.value += 1;
        return new Promise<BotThreadListResponse>((resolve) => {
          pendingReads.push(resolve);
        });
      },
    },
  });
  const hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  hostClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const requester = hostClient.createRequester(mockLocalHostEntry);
  const session = new StubSession();
  const streamClient = new StubHostStreamClient(session);

  function ThreadList(): ReactNode {
    useBotThreadListQuery(requester, BOT_ID, { enabled: true });
    return null;
  }

  // Mirrors `BotTabBody`'s real gate (`bot-tab-surface.tsx`): the
  // channel/thread-list reader mounts only once the bot's subscription has
  // produced its first snapshot, never unconditionally alongside it.
  function Harness(): ReactNode {
    const subscription = useBotSubscriptionForClient({
      hostId: HOST_ID,
      botId: BOT_ID,
      enabled: true,
      client: streamClient,
    });
    if (subscription.snapshot === null) return null;
    return <ThreadList />;
  }

  return {
    session,
    listReads,
    pendingReads,
    queryClient,
    threadListKey: hostQueryKeys.method<HostRpcRegistry, "bot.thread.list">(
      HOST_ID,
      "bot.thread.list",
      { botId: BOT_ID },
    ),
    render: () => {
      render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    },
  };
}

afterEach(() => {
  cleanup();
  __resetBotSubscriptionsForTesting();
  resetHostConnectionRegistryForTest();
});

describe("the bot's thread listing follows its subscription", () => {
  it("reads the listing again when the conversations' revision moves, and not for a snapshot that leaves it", async () => {
    const world = fixture();
    world.render();
    act(() => world.session.emit(snapshot(3, 0)));
    await waitFor(() => expect(world.listReads.value).toBe(1));
    act(() => world.pendingReads[0]?.({ threads: [], trunkCostUsd: 0 }));
    await waitFor(() => expect(world.queryClient.isFetching()).toBe(0));

    // The open-request count moved; the rows did not.
    act(() => world.session.emit(snapshot(3, 1)));
    act(() => world.session.emit(snapshot(4, 1)));

    await waitFor(() => expect(world.listReads.value).toBe(2));
    act(() => world.pendingReads[1]?.({ threads: [], trunkCostUsd: 0 }));
    await waitFor(() => expect(world.queryClient.isFetching()).toBe(0));
    expect(world.listReads.value).toBe(2);
  });

  it("reads the listing again when a reply's revision moves while the first read is in flight, and keeps the fresh body", async () => {
    const world = fixture();
    world.render();

    // No snapshot yet: the thread-list reader is not mounted (the real
    // gate), so no `bot.thread.list` dispatch has gone out.
    expect(world.listReads.value).toBe(0);

    // The first snapshot mounts the gated reader, which issues the first
    // read and holds it open with nothing cached. It also caches the
    // subscription snapshot the revision check compares against.
    act(() => world.session.emit(snapshot(0, 0)));
    await waitFor(() => expect(world.listReads.value).toBe(1));
    expect(
      world.queryClient.getQueryState(world.threadListKey)?.data,
    ).toBeUndefined();

    // A reply moves the revision while that first read is unanswered.
    act(() => world.session.emit(snapshot(1, 0)));
    await waitFor(() => expect(world.listReads.value).toBe(2));

    // The second read answers with the post-reply body, then the first,
    // started before the reply, answers with its stale one.
    act(() => {
      world.pendingReads[1]?.({ threads: [], trunkCostUsd: 1.5 });
      world.pendingReads[0]?.({ threads: [], trunkCostUsd: 0 });
    });

    // Settled is the query's own `fetchStatus`, not a timer or a call count.
    await waitFor(() =>
      expect(
        world.queryClient.getQueryState(world.threadListKey)?.fetchStatus,
      ).toBe("idle"),
    );
    expect(world.listReads.value).toBe(2);
    expect(world.queryClient.getQueryState(world.threadListKey)?.data).toEqual({
      threads: [],
      trunkCostUsd: 1.5,
    });
  });
});
