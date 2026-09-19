/**
 * The expansion hook carries the response's OWN total for the chat it asked
 * about. `ExpandedRows` prefers it over the parent row's count, which came from
 * a different snapshot - so a hook that quietly dropped it would leave every
 * panel-level test green (they mock this hook) and bring back "3 of 2 matches".
 *
 * Driven end to end over the real host client and query layer; only the host's
 * answer is scripted.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ChatSearchMessageHit,
  ChatSearchMessageMatch,
  ChatSearchResponse,
} from "@traycer/protocol/host/chat-search/schemas";
import {
  useChatSearchMessageRows,
  type ChatSearchBaseRequest,
  type ChatSearchExpansionStatus,
} from "@/hooks/chats/use-chat-search-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";

const BASE: ChatSearchBaseRequest = {
  query: "needle",
  scope: { kind: "current-task", epicId: EPIC_ID },
  tiers: null,
  roleFilter: "any",
  dateRange: null,
  harness: null,
  mode: "ranked",
};

type ReadyExpansion = Extract<
  ChatSearchExpansionStatus,
  { readonly kind: "ready" }
>;

function hit(messageId: string): ChatSearchMessageHit {
  return {
    messageId,
    tier: "assistant",
    createdAt: 1,
    interAgent: false,
    truncated: false,
    snippet: { text: `text of ${messageId}`, highlights: [] },
  };
}

function group(
  epicId: string,
  chatId: string,
  matchCount: number,
): ChatSearchMessageMatch {
  return {
    epicId,
    ownerUserId: "user-1",
    chatId,
    title: `title-${chatId}`,
    lifecycleState: "active",
    updatedAt: 1,
    matchCount,
    best: hit(`${chatId}-best`),
    messages: [hit(`${chatId}-m1`), hit(`${chatId}-m2`)],
  };
}

function answer(
  groups: ReadonlyArray<ChatSearchMessageMatch>,
): ChatSearchResponse {
  return {
    chatMatches: [],
    chatNextCursor: null,
    messageMatches: [...groups],
    messageNextCursor: null,
    indexState: "complete",
  };
}

function fixture(response: ChatSearchResponse): {
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly client: HostClient<HostRpcRegistry>;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: { "chat.search": () => response },
    }),
  });
  hostClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { Wrapper, client: hostClient.createRequester(mockLocalHostEntry) };
}

async function readyExpansion(
  response: ChatSearchResponse,
): Promise<ReadyExpansion> {
  const { Wrapper, client } = fixture(response);
  const { result } = renderHook(
    () =>
      useChatSearchMessageRows({
        client,
        base: BASE,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        cursors: [],
      }),
    { wrapper: Wrapper },
  );
  await waitFor(() => {
    expect(result.current.kind).toBe("ready");
  });
  const status = result.current;
  if (status.kind !== "ready") throw new Error("expected a ready expansion");
  return status;
}

afterEach(() => {
  cleanup();
});

describe("useChatSearchMessageRows: the expansion's own total", () => {
  it("carries the matching chat group's count, not another group's", async () => {
    const status = await readyExpansion(
      answer([
        // Same chat id in another task, and another chat in this task: neither
        // is the group this expansion asked about.
        group("epic-2", CHAT_ID, 99),
        group(EPIC_ID, "chat-2", 98),
        group(EPIC_ID, CHAT_ID, 7),
      ]),
    );

    expect(status.matchCount).toBe(7);
  });

  it("reports no total when the response holds no group for the chat", async () => {
    const status = await readyExpansion(answer([]));

    expect(status.matchCount).toBeNull();
  });
});
