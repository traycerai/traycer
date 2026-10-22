import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { ChatSearchPanel } from "@/components/chat-search/chat-search-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { cloudChatListQueryKey } from "@/lib/chats/cloud-chat-list-cache";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useChatSearchStore } from "@/stores/chat-search/chat-search-store";

const HOST_ID = mockLocalHostEntry.hostId;
const VIEWER = "viewer-1";
const TASK = "epic-1";

const activeEpic = vi.hoisted(() => ({ current: null as string | null }));
const hostClientRef = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_ID,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => hostClientRef.current,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: HOST_ID,
    requestContextUserId: VIEWER,
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
  }),
}));
vi.mock("@/hooks/chats/use-chat-search-task-titles", () => ({
  useChatSearchTaskTitles: () => new Map<string, string>(),
}));
vi.mock("@/hooks/ui/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));
vi.mock("@/stores/epics/canvas/canvas-selectors", () => ({
  useActiveEpicId: () => activeEpic.current,
}));
vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicTitle: () => null,
}));
vi.mock("@/lib/chat-search/open-chat-search-result", () => ({
  openChatSearchResult: vi.fn(),
}));

function chat(chatId: string, ownerHostId: string): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId, ownerUserId: VIEWER },
    ownerHostId,
    createdAt: 1,
    visibility: "task",
    title: chatId,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

function mount() {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "search",
    handlers: {
      "chat.search": () =>
        Promise.resolve({
          chatMatches: [],
          chatNextCursor: null,
          messageMatches: [],
          messageNextCursor: null,
          indexState: "complete",
        }),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostClientRef.current = spine.createRequester(mockLocalHostEntry);
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSearchPanel onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return { queryClient, messenger };
}

async function search(): Promise<void> {
  await userEvent
    .setup()
    .type(screen.getByRole("searchbox", { name: "Search chats" }), "hello");
}

describe("ChatSearchPanel coverage line", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER, username: VIEWER },
    });
  });

  afterEach(() => {
    cleanup();
    activeEpic.current = null;
    hostClientRef.current = null;
    useChatSearchStore.getState().resetForTests();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("states other devices aren't searched for every-task scope, with only chat.search read", async () => {
    useChatSearchStore.getState().setScope("all-accessible-tasks");
    const { messenger } = mount();

    await search();

    const note = await screen.findByTestId("chat-search-coverage");
    expect(note.textContent).toBe("Chats on other devices aren't searched.");
    expect(messenger.calls.length).toBeGreaterThan(0);
    expect(new Set(messenger.calls.map((call) => call.method))).toEqual(
      new Set(["chat.search"]),
    );
  });

  it("counts the chats a task keeps elsewhere from its seeded list, with only chat.search read", async () => {
    activeEpic.current = TASK;
    useChatSearchStore.getState().setScope("current-task");
    const view = mount();
    view.queryClient.setQueryData(
      cloudChatListQueryKey({
        hostId: HOST_ID,
        viewerUserId: VIEWER,
        taskId: TASK,
      }),
      { chats: [chat("here", HOST_ID), chat("away", "host-2")] },
    );

    await search();

    await waitFor(() => {
      expect(screen.getByTestId("chat-search-coverage").textContent).toBe(
        "1 chat in this task can't be searched from this device.",
      );
    });
    expect(new Set(view.messenger.calls.map((call) => call.method))).toEqual(
      new Set(["chat.search"]),
    );
  });
});
