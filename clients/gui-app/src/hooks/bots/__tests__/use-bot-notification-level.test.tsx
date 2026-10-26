import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { BotNotificationLevelReadResponse } from "@traycer/protocol/host/bot/schemas";
import {
  useBotNotificationLevelSetMutation,
  useBotNotificationLevelsQuery,
} from "@/hooks/bots/use-bot-notification-level";

// A person's notification levels (T63) under a host key: the hooks, the real
// `useHostQuery` / `useHostMutation` and the QueryClient are real; only the
// viewer id and the host transport are faked.

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const viewer = vi.hoisted(() => ({ current: "" }));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => viewer.current,
}));

/** A read the test answers when it chooses; `null` answers at once. */
type ReadGate = { release: (() => void) | null; held: boolean };

function createFixture(levels: () => BotNotificationLevelReadResponse) {
  const gate: ReadGate = { release: null, held: false };
  const queryClient = new QueryClient({
    // Infinity so A's entry survives the account switch: that lingering entry
    // is the hazard, and with gc the test would pass without any partition.
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
        "bot.notificationLevel.read": async () => {
          if (gate.held) {
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
          }
          return levels();
        },
        "bot.notificationLevel.set": (params) => ({ level: params.level }),
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, queryClient, Wrapper, gate };
}

afterEach(() => {
  cleanup();
  viewer.current = "";
});

describe("useBotNotificationLevelsQuery - per-viewer cache partition", () => {
  it("keeps one entry per viewer, and never serves viewer A's levels on viewer B's first render", async () => {
    const fixture = createFixture(() => ({
      levels: { [`channel-of-${viewer.current}`]: "off" },
    }));
    viewer.current = "user-a";
    const first = renderHook(
      () => useBotNotificationLevelsQuery(fixture.client, BOT_ID, true),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(first.result.current.data?.levels).toEqual({
        "channel-of-user-a": "off",
      });
    });
    first.unmount();

    // What an identity transition does to host keys: stale, not dropped.
    await fixture.queryClient.invalidateQueries({
      queryKey: ["host"],
      refetchType: "none",
    });
    viewer.current = "user-b";
    const second = renderHook(
      () => useBotNotificationLevelsQuery(fixture.client, BOT_ID, true),
      { wrapper: fixture.Wrapper },
    );

    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(second.result.current.data?.levels).toEqual({
        "channel-of-user-b": "off",
      });
    });
    const entries = fixture.queryClient
      .getQueryCache()
      .findAll()
      .filter((query) =>
        JSON.stringify(query.queryKey).includes("bot.notificationLevel.read"),
      );
    expect(entries).toHaveLength(2);
  });
});

describe("useBotNotificationLevelSetMutation", () => {
  it("stays pending until the levels it wrote are read back", async () => {
    let stored: "mentions" | "off" = "mentions";
    const fixture = createFixture(() => ({ levels: { "channel-1": stored } }));
    viewer.current = "user-a";
    const { result } = renderHook(
      () => ({
        levels: useBotNotificationLevelsQuery(fixture.client, BOT_ID, true),
        update: useBotNotificationLevelSetMutation(fixture.client),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.levels.data?.levels["channel-1"]).toBe("mentions");
    });

    // The re-read the write triggers is held until the test releases it.
    fixture.gate.held = true;
    stored = "off";
    act(() => {
      result.current.update.mutate({
        botId: BOT_ID,
        conversationId: "channel-1",
        level: "off",
      });
    });
    await waitFor(() => {
      expect(fixture.gate.release).not.toBeNull();
    });
    expect(result.current.update.isPending).toBe(true);
    expect(result.current.levels.data?.levels["channel-1"]).toBe("mentions");

    act(() => {
      fixture.gate.release?.();
    });
    await waitFor(() => {
      expect(result.current.update.isPending).toBe(false);
    });
    expect(result.current.levels.data?.levels["channel-1"]).toBe("off");
  });
});
