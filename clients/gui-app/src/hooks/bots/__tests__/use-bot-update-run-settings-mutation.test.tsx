/**
 * The REAL `useBotUpdateRunSettingsMutation` over a real `HostClient` and
 * `QueryClient`: a run-settings write that the host accepts invalidates the
 * cached `bot.list` of every host, not only the one the write went through, so
 * the bot settings panel re-renders from the row the host now holds (`bot-settings-panel-reseed.test.tsx` pins what the panel
 * does with it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  BotRecord,
  BotUpdateRunSettingsRequest,
} from "@traycer/protocol/host/bot/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mockLocalHostEntry.hostId,
}));

import { useBotUpdateRunSettingsMutation } from "@/hooks/bots/use-bot-mutations";

const BOT: BotRecord = {
  botId: "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "env-personal",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "codex",
  model: "model-x",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: mockLocalHostEntry.hostId,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
  directive: null,
  replyMode: "thread",
  appConversationChatId: null,
};

function buildClient(
  queryClient: QueryClient,
  sent: BotUpdateRunSettingsRequest[],
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-update-run-settings",
      handlers: {
        "bot.updateRunSettings": (params) => {
          sent.push(params);
          return Promise.resolve({ bot: BOT });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

afterEach(() => {
  cleanup();
});

describe("useBotUpdateRunSettingsMutation", () => {
  it("sends the write to its host and invalidates every host's cached bot list", async () => {
    const queryClient = createAppQueryClient();
    const sent: BotUpdateRunSettingsRequest[] = [];
    const client = buildClient(queryClient, sent);
    const listKey = hostQueryKeys.method<HostRpcRegistry, "bot.list">(
      mockLocalHostEntry.hostId,
      "bot.list",
      {},
    );
    const otherHostListKey = hostQueryKeys.method<HostRpcRegistry, "bot.list">(
      "host-other",
      "bot.list",
      {},
    );
    queryClient.setQueryData(listKey, { bots: [], mainBotIds: {} });
    queryClient.setQueryData(otherHostListKey, { bots: [], mainBotIds: {} });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => useBotUpdateRunSettingsMutation(client),
      { wrapper },
    );
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherHostListKey)?.isInvalidated).toBe(
      false,
    );

    const request: BotUpdateRunSettingsRequest = {
      botId: BOT.botId,
      harness: "codex",
      model: "model-x",
      effort: null,
      profile: null,
    };
    await act(async () => {
      await result.current.mutateAsync(request);
    });

    expect(sent).toEqual([request]);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherHostListKey)?.isInvalidated).toBe(
      true,
    );
  });
});
