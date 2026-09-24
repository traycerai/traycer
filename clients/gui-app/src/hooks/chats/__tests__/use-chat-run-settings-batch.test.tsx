import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  invalidateChatRunSettings,
  useChatRunSettingsBatch,
} from "@/hooks/chats/use-chat-run-settings-query";

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "viewer",
}));

const EPIC_ID = "epic-1";

function settings(model: string): ChatRunSettings {
  return {
    harnessId: "claude",
    model,
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: "limited",
  };
}

const SETTINGS_BY_CHAT: ReadonlyMap<string, ChatRunSettings | null> = new Map([
  ["chat-a", settings("opus")],
  ["chat-b", null],
  ["chat-c", settings("sonnet")],
]);

function createFixture(): {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly requestedChatIds: string[];
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  // `staleTime: 0` as the app-wide default, so anything that keeps these
  // entries fresh has to come from the batch's own options.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const requestedChatIds: string[] = [];
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "epic.getChatRunSettings": (params) => {
          requestedChatIds.push(params.chatId);
          return { settings: SETTINGS_BY_CHAT.get(params.chatId) ?? null };
        },
      },
    }),
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { queryClient, client, requestedChatIds, Wrapper };
}

const CHAT_IDS = ["chat-a", "chat-b", "chat-c"];

describe("useChatRunSettingsBatch", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("sends nothing while disabled", async () => {
    const fixture = createFixture();
    const requester = fixture.client.createRequester(mockLocalHostEntry);
    const { result } = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: requester,
          epicId: EPIC_ID,
          chatIds: CHAT_IDS,
          enabled: false,
        }),
      { wrapper: fixture.Wrapper },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestedChatIds).toEqual([]);
    expect(result.current).toEqual({
      resolving: false,
      settings: [null, null, null],
    });
  });

  it("reads each chat once and folds the answers in chatIds order", async () => {
    const fixture = createFixture();
    const requester = fixture.client.createRequester(mockLocalHostEntry);
    const { result } = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: requester,
          epicId: EPIC_ID,
          chatIds: CHAT_IDS,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(result.current.resolving).toBe(true);
    await waitFor(() => expect(result.current.resolving).toBe(false));

    expect([...fixture.requestedChatIds].sort()).toEqual(CHAT_IDS);
    expect(result.current.settings).toEqual([
      settings("opus"),
      null,
      settings("sonnet"),
    ]);
  });

  it("does not re-read on a later mount however old the answers are, but does after a settings write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture();
    const requester = fixture.client.createRequester(mockLocalHostEntry);
    const render = () =>
      renderHook(
        () =>
          useChatRunSettingsBatch({
            client: requester,
            epicId: EPIC_ID,
            chatIds: CHAT_IDS,
            enabled: true,
          }),
        { wrapper: fixture.Wrapper },
      );

    const first = render();
    await waitFor(() => expect(first.result.current.resolving).toBe(false));
    expect(fixture.requestedChatIds).toHaveLength(3);
    first.unmount();

    vi.setSystemTime(Date.now() + 60 * 60 * 1_000);
    const second = render();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.result.current.resolving).toBe(false);
    expect(fixture.requestedChatIds).toHaveLength(3);

    act(() => {
      invalidateChatRunSettings(fixture.queryClient, mockLocalHostEntry.hostId);
    });
    await waitFor(() => expect(fixture.requestedChatIds).toHaveLength(6));
  });

  it("hands back the same folded result while the answers are unchanged", async () => {
    const fixture = createFixture();
    const requester = fixture.client.createRequester(mockLocalHostEntry);
    const { result, rerender } = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: requester,
          epicId: EPIC_ID,
          chatIds: CHAT_IDS,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.resolving).toBe(false));
    const folded = result.current;

    rerender();

    expect(result.current).toBe(folded);
  });
});
