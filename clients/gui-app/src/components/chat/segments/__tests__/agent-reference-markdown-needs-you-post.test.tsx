/**
 * An agent's chip shows the agent's own title, never the text a bot wrote in
 * the tag. The title is the live one when a task mounted in this window holds
 * the agent, else the host's `epic.getChatTitle` answer, else the written text
 * (`Agent` for an empty tag).
 *
 * A bot's "Needs you" post through the REAL markdown path
 * (`AgentReferenceMarkdown` over `TraycerMarkdown`) in a channel, where no
 * epic is open: an agent written as `<traycer-chat>` is a chip that opens its
 * task and focuses that chat, and a pull request written as a markdown link
 * is an anchor to it.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const request =
    vi.fn<(method: string, params: unknown) => Promise<unknown>>();
  return {
    request,
    client: {
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
      request,
      requestWithSignal: request,
    },
  };
});

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useOptionalHostClient: () => mocks.client,
}));
vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-test",
    isReady: true,
    hasRpcEndpoint: true,
    canExecute: true,
    requestContextUserId: "user-test",
  }),
}));
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "active-host-1",
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: vi.fn() }),
}));
vi.mock("@/components/epic-canvas/view-tab-context", () => ({
  useEpicViewTabId: () => null,
}));

const navigateToTabIntent = vi.fn();
const openOrFocusEpicIntent = vi.fn(
  (input: { epicId: string; focus: unknown }) => ({ kind: "epic", ...input }),
);
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: (...args: unknown[]) => {
    navigateToTabIntent(...args);
  },
  openOrFocusEpicIntent: (input: { epicId: string; focus: unknown }) =>
    openOrFocusEpicIntent(input),
}));

import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";
import { useAuthStore } from "@/stores/auth/auth-store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

const PR_URL = "https://github.com/example/repo/pull/42";

let queryClient: QueryClient;

beforeEach(() => {
  navigateToTabIntent.mockClear();
  openOrFocusEpicIntent.mockClear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useAuthStore
    .getState()
    .setSignedIn(
      { userId: "user-test", userName: "U", email: "u@example.com" },
      { userId: "user-test", username: "U" },
      [],
    );
});

afterEach(() => {
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  mocks.request.mockReset();
  useAuthStore.getState().setSignedOut();
});

/** The host answers every `epic.getChatTitle` with `chat`. */
function answerChatTitle(chat: { title: string | null } | null): void {
  mocks.request.mockImplementation((method) =>
    method === "epic.getChatTitle"
      ? Promise.resolve({ chat })
      : Promise.reject(new Error(`unexpected method: ${method}`)),
  );
}

function chatTitleRequests(): ReadonlyArray<unknown> {
  return mocks.request.mock.calls
    .filter(([method]) => method === "epic.getChatTitle")
    .map(([, params]) => params);
}

function renderPost(markdown: string): HTMLElement {
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentReferenceMarkdown
        isStreaming={false}
        markdown={markdown}
        proseSize="compact"
        quotable={false}
        components={null}
      />
    </QueryClientProvider>,
  ).container;
}

describe("a Needs you post in a channel with no open epic", () => {
  it("draws an agent as a chip that opens its task and focuses that chat, and a pull request as a link", () => {
    answerChatTitle(null);
    const container = renderPost(
      `- <traycer-chat epicId="epic-7" chatId="chat-9">Fix the build</traycer-chat> waits on a steer\n- [Review comments on #42](${PR_URL})`,
    );

    const chip = screen.getByRole("button", { name: "Fix the build" });
    expect(chip.getAttribute("data-traycer-ref")).toBe("chat");
    const anchor = container.querySelector(`a[href="${PR_URL}"]`);
    expect(anchor?.textContent).toBe("Review comments on #42");

    fireEvent.click(chip);

    expect(navigateToTabIntent).toHaveBeenCalledTimes(1);
    const arg = openOrFocusEpicIntent.mock.calls[0][0];
    expect(arg.epicId).toBe("epic-7");
    expect(arg.focus).toMatchObject({ focusArtifactId: "chat-9" });
  });
});

describe("an agent chip's label", () => {
  it("is the agent's real title, not the wrong name the bot wrote, and the host is asked for that task and chat", async () => {
    answerChatTitle({ title: "Fix the build" });
    renderPost(
      `<traycer-chat epicId="epic-7" chatId="chat-9">Deploy the site</traycer-chat>`,
    );

    await screen.findByRole("button", { name: "Fix the build" });

    expect(
      screen.queryByRole("button", { name: "Deploy the site" }),
    ).toBeNull();
    expect(chatTitleRequests()).toEqual([
      { taskId: "epic-7", chatId: "chat-9" },
    ]);
  });

  it("is the title for an empty tag, which still opens the task focused on that chat", async () => {
    answerChatTitle({ title: "Fix the build" });
    renderPost(`<traycer-chat epicId="epic-7" chatId="chat-9"></traycer-chat>`);

    fireEvent.click(
      await screen.findByRole("button", { name: "Fix the build" }),
    );

    expect(navigateToTabIntent).toHaveBeenCalledTimes(1);
    const arg = openOrFocusEpicIntent.mock.calls[0][0];
    expect(arg.epicId).toBe("epic-7");
    expect(arg.focus).toMatchObject({ focusArtifactId: "chat-9" });
  });

  it("is Agent for an empty tag whose chat the host cannot find, and is still clickable", async () => {
    answerChatTitle(null);
    renderPost(`<traycer-chat epicId="epic-7" chatId="chat-9"></traycer-chat>`);

    await screen.findByRole("button", { name: "Agent" });
    await vi.waitFor(() => {
      expect(chatTitleRequests()).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));

    expect(openOrFocusEpicIntent.mock.calls[0][0].epicId).toBe("epic-7");
  });

  it("is Untitled agent for a found chat that has no title", async () => {
    answerChatTitle({ title: null });
    renderPost(
      `<traycer-chat epicId="epic-7" chatId="chat-9">Fix the build</traycer-chat>`,
    );

    await screen.findByRole("button", { name: "Untitled agent" });
    expect(screen.queryByRole("button", { name: "Fix the build" })).toBeNull();
  });

  it("is the live title of a task mounted in this window, and the host is never asked", async () => {
    answerChatTitle({ title: "From the host" });
    const handle = openStoreForTest({
      epicId: "epic-7",
      userId: null,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    });
    handle.store.setState({
      chats: {
        allIds: ["chat-9"],
        byId: { "chat-9": liveChat("chat-9", "Live title") },
      },
    });
    act(() => {
      __getOpenEpicRegistryForTests().acquire("epic-7", () => handle);
    });

    renderPost(
      `<traycer-chat epicId="epic-7" chatId="chat-9">Deploy the site</traycer-chat>`,
    );

    await screen.findByRole("button", { name: "Live title" });
    // No lookup was ever registered, so none can be in flight.
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(chatTitleRequests()).toEqual([]);
    handle.dispose();
  });
});

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function liveChat(id: string, title: string): ChatProjection {
  return {
    id,
    title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: null,
    ownedByViewer: true,
    hostId: "host-a",
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
  };
}
