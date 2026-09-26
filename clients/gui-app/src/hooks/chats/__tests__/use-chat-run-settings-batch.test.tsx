import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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

/** Chats whose read the fixture's host refuses, permanently (no retry). */
const FAILING_CHATS = new Set<string>(["chat-broken"]);

interface Fixture {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly requestedChatIds: string[];
  /** While set, every read waits for it; `release` answers them. */
  readonly gate: { current: Promise<void> | null; release: () => void };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createFixture(): Fixture {
  // `staleTime: 0` as the app-wide default, so anything that keeps these
  // entries fresh has to come from the batch's own options.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const requestedChatIds: string[] = [];
  const gate: { current: Promise<void> | null; release: () => void } = {
    current: null,
    release: () => {},
  };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "epic.getChatRunSettings": async (params) => {
          requestedChatIds.push(params.chatId);
          if (gate.current !== null) await gate.current;
          if (FAILING_CHATS.has(params.chatId)) {
            // The one code the batch does not retry, so the failure lands now.
            throw new HostRpcError({
              code: "E_HOST_UNSUPPORTED",
              message: "no",
              requestId: "req-1",
              method: "epic.getChatRunSettings",
              fatalDetails: null,
            });
          }
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
  return { queryClient, client, requestedChatIds, gate, Wrapper };
}

function closeGate(gate: {
  current: Promise<void> | null;
  release: () => void;
}): void {
  gate.current = new Promise<void>((resolve) => {
    gate.release = () => {
      gate.current = null;
      resolve();
    };
  });
}

const CHAT_IDS = ["chat-a", "chat-b", "chat-c"];

describe("useChatRunSettingsBatch", () => {
  afterEach(() => {
    cleanup();
  });

  function renderBatch(
    fixture: Fixture,
    input: {
      readonly chatIds: ReadonlyArray<string>;
      readonly enabled: boolean;
      readonly checkId: number;
    },
  ) {
    const requester = fixture.client.createRequester(mockLocalHostEntry);
    const props = { current: input };
    const view = renderHook(
      () =>
        useChatRunSettingsBatch({
          client: requester,
          epicId: EPIC_ID,
          chatIds: props.current.chatIds,
          enabled: props.current.enabled,
          checkId: props.current.checkId,
        }),
      { wrapper: fixture.Wrapper },
    );
    return { ...view, props };
  }

  it("sends nothing while disabled, and reports every read as unavailable", async () => {
    const fixture = createFixture();
    const { result } = renderBatch(fixture, {
      chatIds: CHAT_IDS,
      enabled: false,
      checkId: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestedChatIds).toEqual([]);
    expect(result.current).toEqual({
      resolving: false,
      reads: [
        { kind: "unavailable" },
        { kind: "unavailable" },
        { kind: "unavailable" },
      ],
    });
  });

  it("reads each chat once and folds the answers in chatIds order", async () => {
    const fixture = createFixture();
    const { result } = renderBatch(fixture, {
      chatIds: CHAT_IDS,
      enabled: true,
      checkId: 1,
    });

    expect(result.current.resolving).toBe(true);
    await waitFor(() => expect(result.current.resolving).toBe(false));

    expect([...fixture.requestedChatIds].sort()).toEqual(CHAT_IDS);
    expect(result.current.reads).toEqual([
      { kind: "answered", settings: settings("opus") },
      { kind: "answered", settings: null },
      { kind: "answered", settings: settings("sonnet") },
    ]);
  });

  it("keeps a failed read apart from an answer with nothing pinned", async () => {
    const fixture = createFixture();
    const { result } = renderBatch(fixture, {
      chatIds: ["chat-a", "chat-broken"],
      enabled: true,
      checkId: 1,
    });

    await waitFor(() => expect(result.current.resolving).toBe(false));

    expect(result.current.reads).toEqual([
      { kind: "answered", settings: settings("opus") },
      { kind: "failed" },
    ]);
  });

  it("reads afresh for a new check, and not again within the same one", async () => {
    const fixture = createFixture();
    const view = renderBatch(fixture, {
      chatIds: ["chat-a"],
      enabled: true,
      checkId: 1,
    });
    await waitFor(() => expect(view.result.current.resolving).toBe(false));
    expect(fixture.requestedChatIds).toEqual(["chat-a"]);

    view.rerender();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestedChatIds).toEqual(["chat-a"]);

    view.props.current = { chatIds: ["chat-a"], enabled: true, checkId: 2 };
    view.rerender();
    await waitFor(() => expect(fixture.requestedChatIds).toHaveLength(2));
    await waitFor(() => expect(view.result.current.resolving).toBe(false));
  });

  it("is resolving again while a settings write's refetch is in flight, though an answer is cached", async () => {
    const fixture = createFixture();
    const { result } = renderBatch(fixture, {
      chatIds: ["chat-a"],
      enabled: true,
      checkId: 1,
    });
    await waitFor(() => expect(result.current.resolving).toBe(false));

    closeGate(fixture.gate);
    act(() => {
      invalidateChatRunSettings(fixture.queryClient, mockLocalHostEntry.hostId);
    });
    await waitFor(() => expect(fixture.requestedChatIds).toHaveLength(2));

    expect(result.current).toEqual({
      resolving: true,
      reads: [{ kind: "pending" }],
    });

    fixture.gate.release();
    await waitFor(() => expect(result.current.resolving).toBe(false));
  });

  it("hands back the same folded result while the answers are unchanged", async () => {
    const fixture = createFixture();
    const { result, rerender } = renderBatch(fixture, {
      chatIds: CHAT_IDS,
      enabled: true,
      checkId: 1,
    });
    await waitFor(() => expect(result.current.resolving).toBe(false));
    const folded = result.current;

    rerender();

    expect(result.current).toBe(folded);
  });
});
