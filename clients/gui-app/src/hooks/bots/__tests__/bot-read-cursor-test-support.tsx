import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type {
  BotReadCursorAdvanceRequest,
  BotReadCursorReadResponse,
  BotReadPosition,
} from "@traycer/protocol/host/bot/schemas";

/**
 * A host that keeps one person's read cursors and each conversation's newest
 * row (`bot.readCursor.read` / `.advance`) behind a real HostClient and
 * QueryClient. `cursors` and `latest` are what the next read answers; tests
 * change them to play another device or a row landing. `advanceAnswers`
 * overrides what an advance answers, to play a host that lags the cache.
 * While `heldRead.promise` is set, a read is counted and answered by it, to
 * play a read in flight.
 */
export interface ReadCursorHostFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly cursors: Record<string, BotReadPosition>;
  readonly latest: Record<string, BotReadPosition>;
  readonly reads: { count: number };
  readonly advances: BotReadCursorAdvanceRequest[];
  readonly advanceAnswers: Map<string, BotReadPosition>;
  readonly heldRead: { promise: Promise<BotReadCursorReadResponse> | null };
}

export function createReadCursorHostFixture(initial: {
  readonly cursors: Record<string, BotReadPosition>;
  readonly latest: Record<string, BotReadPosition>;
}): ReadCursorHostFixture {
  const cursors: Record<string, BotReadPosition> = { ...initial.cursors };
  const latest: Record<string, BotReadPosition> = { ...initial.latest };
  const heldRead: ReadCursorHostFixture["heldRead"] = { promise: null };
  const reads = { count: 0 };
  const advances: BotReadCursorAdvanceRequest[] = [];
  const advanceAnswers = new Map<string, BotReadPosition>();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "bot.readCursor.read": () => {
          reads.count += 1;
          if (heldRead.promise !== null) return heldRead.promise;
          return { cursors: { ...cursors }, latest: { ...latest } };
        },
        "bot.readCursor.advance": (params) => {
          advances.push(params);
          const position = { messageId: params.messageId, seq: params.seq };
          const answer = advanceAnswers.get(params.conversationId) ?? position;
          const held = Object.hasOwn(cursors, params.conversationId)
            ? cursors[params.conversationId]
            : null;
          if (held === null || held.seq < answer.seq) {
            cursors[params.conversationId] = answer;
          }
          return { cursor: answer };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    Wrapper,
    cursors,
    latest,
    reads,
    advances,
    advanceAnswers,
    heldRead,
  };
}
