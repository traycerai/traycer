/**
 * The read-only bot session's transcript must withhold the same
 * layout-editor seam the status surfaces withhold - a timestamp, a
 * tool-activity group and the turn minimap must not register as layout
 * regions, and a right-click inside the transcript must not resolve to the
 * cluster menu, while an active layout editor session is live elsewhere in
 * the window. `ChatStatusReadOnlyContext` wraps the whole `BotSessionView`
 * (not just the status slot), and `useLayoutRegion` itself reads it - this
 * suite mounts the real view and the real transcript to prove the wiring
 * reaches every region, not just the chip's own.
 */
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, ChatSessionStoreHandle>,
  navigateToTabIntent: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  navigateToTabIntent: mocks.navigateToTabIntent,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useChatSessionHandleForContainer: (
    _botId: string,
    chatId: string,
  ): ChatSessionStoreHandle | null =>
    Object.hasOwn(mocks.sessions, chatId) ? mocks.sessions[chatId] : null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessCatalogForClient: () => ({ harnesses: [] }),
  useGuiHarnessesQueryForClient: () => ({ data: undefined, isPending: false }),
}));
vi.mock("@/hooks/bots/use-bot-turn-locate-query", () => ({
  useBotTurnLocateQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/chats/use-chat-locate-row", () => ({
  useChatLocateRow: () => null,
  useChatLocateRowAnswer: () => ({ status: "waiting" }),
}));
vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStart: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStop: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAll: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandStopAllIsPending: () => false,
    useManagedCommandDelete: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandConfigureIsPending: () => false,
    useManagedCommandRelaunchOnHostRestart: (
      _target: unknown,
      streamed: { relaunchOnHostRestart: boolean },
    ) => streamed.relaunchOnHostRestart,
    useManagedCommandConfigure: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeld: () => ({ mutate: vi.fn(), isPending: false }),
    useManagedCommandDeliverHeldIsPending: () => false,
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(),
}));

import { BotSessionView } from "@/components/bots/bot-session-view";
import { BotSessionStatusDataContext } from "@/components/bots/bot-session-status-context";
import {
  BotIdentityContext,
  type BotIdentity,
} from "@/components/bots/bot-identity-context";
import {
  scriptedSession,
  sessionPrompt,
  sessionTurn,
} from "@/components/bots/__tests__/bot-turn-test-support";
import {
  installLegendListTestClock,
  installLegendListViewportMetrics,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNRESOLVED_BOT_MEMBERS } from "@/lib/bots/bot-member-names";
import {
  preferredRegionInstance,
  useLayoutEditorStore,
} from "@/stores/layout/layout-editor-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HOST_ID = "host-tab";
const TRUNK_ID = "trunk-chat";

const IDENTITY: BotIdentity = {
  botId: BOT_ID,
  title: "Release Bot",
  owner: null,
};

const opened = {
  channel: vi.fn<(messageId: string | null) => void>(),
  thread: vi.fn<(threadId: string, messageId: string | null) => void>(),
  close: vi.fn<() => void>(),
};

/** A trunk session with a prompt and a tool-call turn: a timestamped row, a
 *  tool-activity group and enough content for the turn minimap to mount. */
function transcriptSession(chatId: string): ChatSessionStoreHandle {
  const { handle } = scriptedSession(chatId, [
    sessionPrompt(`${chatId}-prompt`, 1_000),
    sessionTurn({
      messageId: `${chatId}-turn`,
      turnId: `${chatId}-turn-id`,
      startedAt: 1_100,
      endedAt: 1_200,
      costUsd: 0.01,
    }),
  ]);
  handle.store.setState({ transcriptBaselineEpoch: 0, connectionEpoch: 0 });
  return handle;
}

function mountSession(): void {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <BotIdentityContext value={IDENTITY}>
            <BotSessionStatusDataContext
              value={{ tasks: [], subscriptions: null, boundHostId: null }}
            >
              <BotSessionView
                botId={BOT_ID}
                hostId={HOST_ID}
                botTitle="Release Bot"
                session={{ chatId: TRUNK_ID, threadId: null, landOn: null }}
                threads={[]}
                resolveMember={UNRESOLVED_BOT_MEMBERS}
                onClose={opened.close}
                onOpenChannel={opened.channel}
                onOpenThread={opened.thread}
              />
            </BotSessionStatusDataContext>
          </BotIdentityContext>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

function view(): HTMLElement {
  return screen.getByTestId("bot-session-view");
}

function openEditorSession(): void {
  act(() => {
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
  });
}

beforeEach(() => {
  installLegendListTestClock();
  vi.clearAllMocks();
  installLegendListViewportMetrics();
  mocks.sessions = {};
  useLayoutEditorStore.getState().endSession();
  useLayoutEditorStore.setState({ instances: new Map() });
});

afterEach(() => {
  cleanup();
  mocks.sessions = {};
  useLayoutEditorStore.getState().endSession();
});

describe("a read-only bot session's transcript, with an active layout editor session live elsewhere", () => {
  beforeEach(() => {
    mocks.sessions[TRUNK_ID] = transcriptSession(TRUNK_ID);
  });

  it("registers none of the transcript's own regions - timestamps, tool activity, minimap", async () => {
    mountSession();
    await settleLegendList();
    openEditorSession();

    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "timestamps"),
    ).toBeNull();
    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "toolActivity"),
    ).toBeNull();
    expect(
      preferredRegionInstance(useLayoutEditorStore.getState(), "minimap"),
    ).toBeNull();
    // Unnamed too (L-129's name is a fact about the element; a right-click's
    // `closest("[data-layout-region]")` must find nothing anywhere in the
    // transcript, session or no session).
    expect(view().querySelectorAll("[data-layout-region]").length).toBe(0);
  });

  it("shows no layout cluster menu on a right-click on the timestamp itself", async () => {
    mountSession();
    await settleLegendList();
    openEditorSession();

    // Right on the named element, not the container around it - the menu
    // resolves the region from `closest("[data-layout-region]")` under the
    // actual pointer target, so this is the realistic gesture.
    fireEvent.contextMenu(screen.getByTestId("chat-message-timestamp"));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Customize layout")).toBeNull();
  });
});
