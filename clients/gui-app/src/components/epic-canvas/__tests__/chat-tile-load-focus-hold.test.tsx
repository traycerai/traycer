/**
 * The real `ChatTile` across its first transcript snapshot: what the reader
 * opened while the chat loaded keeps focus when the composer, a pending
 * interview card and its free-text field mount and autofocus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  advanceLegendListFrames,
  installLegendListTestClock,
  installLegendListViewportMetrics,
  restoreLegendListTestClock,
  settleLegendList,
} from "@/components/chat/__tests__/legend-list-test-environment";

const { HOST_ID } = vi.hoisted(() => ({ HOST_ID: "host-test" }));

const MOCK_HOST_ENTRY = {
  hostId: HOST_ID,
  label: "Test host",
  kind: "local" as const,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  streamUrl: "ws://127.0.0.1:1/stream",
};
const MOCK_HOST_CLIENT = {
  request: () => new Promise(() => {}),
  requestWithSignal: () => new Promise<never>(() => {}),
  getActiveHostId: () => HOST_ID,
  getActiveHost: () => MOCK_HOST_ENTRY,
  getRequestContextUserId: () => "user-test",
  onChange: () => () => undefined,
};
const MOCK_HOST_DIRECTORY = {
  onChange: () => ({ dispose() {} }),
  findById: (hostId: string) =>
    hostId === MOCK_HOST_ENTRY.hostId ? MOCK_HOST_ENTRY : null,
};

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    ActiveHostWorkspaceControls: () => null,
  }),
);
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: undefined }),
}));
vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useOptionalHostClient: () => null,
  useHostDirectory: () => MOCK_HOST_DIRECTORY,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
  }),
  useHostClient: () => MOCK_HOST_CLIENT,
  useHostRuntimeClient: () => MOCK_HOST_CLIENT,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => MOCK_HOST_CLIENT,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === HOST_ID ? MOCK_HOST_CLIENT : null,
}));
vi.mock("@/hooks/host/use-host-stream-client-for", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/host/use-host-stream-client-for")
  >()),
  useHostStreamClientFor: () => null,
  useHostStreamClientBindingFor: () => null,
}));
vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));
vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => HOST_ID,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => HOST_ID,
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
// The record gate admits a chat with no local doc record only when the cloud
// list vouches for it.
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importActual) => ({
  ...(await importActual<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatList: () => ({
    data: { chats: [] },
    isError: false,
    isPending: false,
    isFetching: false,
  }),
}));

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { TestRouterProvider } from "@/__tests__/with-test-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatTile } from "@/components/epic-canvas/renderers/chat-tile";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  __getChatSessionRegistryForTests,
  __setChatStreamClientFactoryForTests,
} from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { TestEpicSessionWrapper } from "./test-epic-session";
import { createEpicSessionTestHarness } from "./test-epic-session-harness";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatStreamClientHandle } from "@/stores/chats/chat-session-store";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatPendingInterviewState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

const EPIC_ID = "epic-chat-tile-load-focus";
const CHAT_NODE = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat" as const,
  name: "Chat 1",
  hostId: HOST_ID,
};
const SESSION_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-live",
  permissionMode: "full_access",
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const EMPTY_BROWSER_SESSIONS_STATE: BrowserSessionsState = {
  hostId: HOST_ID,
  lifecycle: "live",
  inventoryReady: true,
  canMaterializeElectron: false,
  connectionGeneration: 0,
  items: [],
  viewports: {},
  setViewport: () => Promise.reject(new Error("not used")),
  reportViewport: () => undefined,
  errorMessage: null,
  retry: () => undefined,
  openTab: () => Promise.reject(new Error("not used")),
  prepareOpenTab: () => {
    throw new Error("not used");
  },
  closeTab: () => Promise.resolve(),
  attachTab: () => Promise.reject(new Error("not used")),
  moveTab: () => Promise.reject(new Error("not used")),
};

const harness = createEpicSessionTestHarness(EPIC_ID);

function seedDocWithChat(doc: Y.Doc): void {
  const epic = doc.getMap("epic");
  const chats = new Y.Map<unknown>();
  const chat = new Y.Map<unknown>();
  chat.set("id", CHAT_NODE.id);
  chat.set("title", CHAT_NODE.name);
  chat.set("parentId", null);
  chat.set("createdAt", 0);
  chat.set("updatedAt", 0);
  chat.set("messages", new Y.Array<unknown>());
  chats.set(CHAT_NODE.id, chat);
  epic.set("title", "Epic Chat Tile");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("chats", chats);
}

/**
 * Opens the chat stream and holds its first snapshot back, so the test
 * decides when the tile's `snapshotLoaded` turns true.
 */
let streamCallbacks: ChatStreamCallbacks | null = null;
function installHeldStream(): void {
  __setChatStreamClientFactoryForTests((_epicId, _chatId, callbacks) => {
    streamCallbacks = callbacks;
    const client: ChatStreamClientHandle = {
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    };
    return client;
  });
}

function userMessage(): Message {
  return {
    role: "user",
    messageId: "message-1",
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Host chat content" }],
          },
        ],
      },
      browserAnnotations: [],
    },
    timestamp: 1,
    sessionAnchor: null,
  };
}

/** An interview whose one question has no options: pure free text. */
function freeTextInterviewMessage(): Message {
  return {
    role: "assistant",
    messageId: "free-text-interview-msg",
    startedAt: 2,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude",
      displayName: "Claude",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "interview",
        blockId: "question-1",
        status: "streaming",
        timestamp: 3,
        toolName: "AskUserQuestion",
        title: "Need input",
        description: "One decision is required.",
        questions: [
          {
            questionId: null,
            question: "What should the branch be called?",
            header: null,
            options: [],
            multiSelect: false,
            allowsCustomAnswer: null,
          },
        ],
        answers: [],
        error: null,
        metadata: null,
        outcome: null,
        draftAnswers: [],
        settlement: null,
        diagnostics: [],
        delivery: null,
        settlementExtensions: {},
      },
    ],
    timestamp: 3,
    turnId: "turn-interview",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function deliverFirstSnapshot(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly pendingInterviews: ReadonlyArray<ChatPendingInterviewState>;
}): void {
  if (streamCallbacks === null) throw new Error("expected chat callbacks");
  streamCallbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_NODE.id,
    snapshot: {
      chat: {
        id: CHAT_NODE.id,
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: CHAT_NODE.name,
        createdAt: 0,
        updatedAt: 0,
        isTitleEditedByUser: false,
        settings: SESSION_SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [...input.messages],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [...input.pendingInterviews],
      worktreeBinding: {
        entries: [
          {
            workspacePath: "/Users/test/project",
            mode: "local",
            repoIdentifier: null,
            worktreePath: null,
            branch: "main",
            isPrimary: true,
            isImported: false,
            setupState: "not_required",
            setupTerminalSessionId: null,
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: 1,
            ownedSubmodules: [],
          },
        ],
      },
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      messageDelivery: undefined,
    },
  });
}

function tree(queryClient: QueryClient, isActive: boolean): ReactNode {
  return (
    <TestRouterProvider>
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={
            new MockRunnerHost({
              signInUrl: "https://example.com",
              authnBaseUrl: "https://auth.example.com",
              localHost: null,
              hosts: [],
              workspaceFolderPickerPaths: undefined,
              hasLocalHost: undefined,
              traycerCli: undefined,
            })
          }
        >
          <BrowserSessionsContext.Provider value={EMPTY_BROWSER_SESSIONS_STATE}>
            <TooltipProvider>
              <TestEpicSessionWrapper epicId={EPIC_ID}>
                <TabHostProvider hostId={HOST_ID}>
                  <ChatTile
                    node={CHAT_NODE}
                    viewTabId="tab-test"
                    tileId="pane-test"
                    isActive={isActive}
                  />
                </TabHostProvider>
              </TestEpicSessionWrapper>
            </TooltipProvider>
          </BrowserSessionsContext.Provider>
        </RunnerHostProvider>
      </QueryClientProvider>
    </TestRouterProvider>
  );
}

/** What the reader opened elsewhere in the window while the chat loaded. */
function ReaderSurfaces(): ReactNode {
  return (
    <>
      <input aria-label="rename" />
      <div role="menu">
        <div role="menuitem" tabIndex={-1}>
          item
        </div>
      </div>
    </>
  );
}

function renderLoadingTile(isActive: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <>
      {tree(queryClient, isActive)}
      <ReaderSurfaces />
    </>,
  );
  return {
    setActive: (next: boolean) =>
      view.rerender(
        <>
          {tree(queryClient, next)}
          <ReaderSurfaces />
        </>,
      ),
    renameInput: (): HTMLInputElement => {
      const input =
        view.container.ownerDocument.querySelector<HTMLInputElement>(
          "input[aria-label='rename']",
        );
      if (input === null) throw new Error("expected the rename input");
      return input;
    },
    menuItem: (): HTMLElement => {
      const item =
        view.container.ownerDocument.querySelector<HTMLElement>(
          "[role='menuitem']",
        );
      if (item === null) throw new Error("expected the menu item");
      return item;
    },
  };
}

async function waitForStream(): Promise<void> {
  await settleLegendList();
  if (streamCallbacks === null) throw new Error("expected the chat stream");
}

async function deliverAndFlush(
  messages: ReadonlyArray<Message>,
  pendingInterviews: ReadonlyArray<ChatPendingInterviewState>,
): Promise<void> {
  act(() => {
    deliverFirstSnapshot({ messages, pendingInterviews });
  });
  await settleLegendList();
  await advanceLegendListFrames(4);
}

function composerEditor(): HTMLElement {
  const editor = document.querySelector<HTMLElement>(
    "[data-composer-editor] [contenteditable='true'], [data-composer-editor][contenteditable='true']",
  );
  if (editor === null) throw new Error("expected the composer editor");
  return editor;
}

describe("<ChatTile /> first-snapshot focus hold", () => {
  beforeEach(() => {
    installLegendListViewportMetrics();
    installLegendListTestClock();
    window.localStorage.clear();
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "owner-1",
        userName: "Owner",
        email: "owner@example.com",
      },
      contextMetadata: { userId: "owner-1", username: "Owner" },
    });
    useSettingsStore.setState({
      defaultSelection: {
        harnessId: "codex",
        modelSlug: "gpt-5-codex",
        profileId: null,
      },
    });
    useComposerDraftStore.setState({ drafts: {} });
    harness.install(seedDocWithChat, "editor");
    streamCallbacks = null;
    installHeldStream();
  });

  afterEach(() => {
    cleanup();
    restoreLegendListTestClock();
    harness.teardown();
    __setChatStreamClientFactoryForTests(null);
    __getChatSessionRegistryForTests().disposeAll();
    streamCallbacks = null;
    useAuthStore.setState({
      status: "signed-out",
      profile: null,
      contextMetadata: null,
    });
  });

  it("leaves a rename field the reader moved to while the chat loaded", async () => {
    const tile = renderLoadingTile(true);
    await waitForStream();
    fireEvent.pointerDown(document.body);
    tile.renameInput().focus();

    await deliverAndFlush([userMessage()], []);

    expect(document.activeElement).toBe(tile.renameInput());
  });

  it("leaves an open menu the reader moved to while a free-text interview seated", async () => {
    const tile = renderLoadingTile(true);
    await waitForStream();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    tile.menuItem().focus();

    await deliverAndFlush(
      [userMessage(), freeTextInterviewMessage()],
      [{ blockId: "question-1", requestedAt: 3 }],
    );

    expect(
      screen.getByTestId("interview-card").querySelector("textarea"),
    ).not.toBeNull();
    expect(document.activeElement).toBe(tile.menuItem());
  });

  it("focuses the composer at load when the reader did nothing meanwhile", async () => {
    renderLoadingTile(true);
    await waitForStream();

    await deliverAndFlush([userMessage()], []);

    expect(document.activeElement).toBe(composerEditor());
  });

  it("keeps the held field on a pane switch until a later gesture releases the hold", async () => {
    const tile = renderLoadingTile(true);
    await waitForStream();
    fireEvent.pointerDown(document.body);
    tile.renameInput().focus();
    await deliverAndFlush([userMessage()], []);

    tile.setActive(false);
    tile.setActive(true);
    await advanceLegendListFrames(4);
    expect(document.activeElement).toBe(tile.renameInput());

    fireEvent.pointerDown(document.body);
    tile.setActive(false);
    tile.setActive(true);
    await advanceLegendListFrames(4);

    expect(document.activeElement).toBe(composerEditor());
  });
});
