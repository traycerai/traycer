import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BackgroundItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * The queue pill's tooltip, end to end through the tile: the tile feeds the
 * REAL `ChatLowerDock` and the REAL `QueuedMessagePanel` (the dock is NOT
 * mocked), and the routing state lives on the registered session store, so a
 * tooltip that depends on a liveness predicate read at the wrong seam shows up
 * here. Under a routing pause the pill says ONE thing in every state.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/hooks/drafts/use-tab-draft-mirror", () => ({
  TabDraftMirrorMount: () => null,
}));

vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: { readonly workspaceControls: ReactNode }) => (
    <div data-testid="composer-stub">{props.workspaceControls}</div>
  ),
}));

let agentStopControlsMock: AgentStopControls = { self: null, descendants: [] };
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => agentStopControlsMock,
}));

const viewportMock = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/ui/use-mobile-viewport")>()),
  useIsMobileViewport: (): boolean => viewportMock.phone,
}));

interface TestHostBinding {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry>;
}

const globalClientRef = vi.hoisted(
  (): { value: HostClient<HostRpcRegistry> | null } => ({ value: null }),
);
const bindingRef = vi.hoisted((): { value: TestHostBinding | null } => ({
  value: null,
}));

function requireGlobalClient(): HostClient<HostRpcRegistry> {
  if (globalClientRef.value === null) {
    throw new Error("test global client not configured");
  }
  return globalClientRef.value;
}

function requireBinding(): TestHostBinding {
  if (bindingRef.value === null) {
    throw new Error("test binding not configured");
  }
  return bindingRef.value;
}

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: requireGlobalClient,
  useHostBinding: requireBinding,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: requireGlobalClient,
  useHostBinding: requireBinding,
}));

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { ChatDockCompactStrip } from "@/components/chat/chat-dock-compact-strip";
import { useChatDockOpenStore } from "@/stores/chats/chat-dock-open-store";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { AgentStopControls } from "@/hooks/agent/use-agent-stop-controls";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { ChatStopConfirmationTarget } from "@/stores/chats/chat-turn-lifecycle";

const EPIC_ID = "epic-1";
const TAB_ID = "tab-1";
const CHAT_ID = "chat-1";
const OTHER_CHAT_ID = "chat-2";

const DEFAULT_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "default-host",
  websocketUrl: "ws://127.0.0.1:59997/stream",
};
const TAB_HOST: HostDirectoryEntry = {
  ...mockLocalHostEntry,
  hostId: "tab-host",
  websocketUrl: "ws://127.0.0.1:59998/stream",
};

const EMPTY_RESTORE: ChatRestoreContextValue = {
  accessRole: "owner",
  currentUserId: "user-1",
  activeHostId: TAB_HOST.hostId,
  activeTurnStatus: null,
  localSnapshotsClearedAt: null,
  restore: null,
  restoreActionPending: false,
  restoreCheckpoint: () => null,
  accumulatedFileChanges: [],
  undeliveredChangeCount: 0,
  accumulatedSetComplete: true,
  revertFileChanges: () => null,
};

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

let epicHandle: OpenedStoreForTest;

function stopTarget(
  turnId: string | null,
  revision: number,
  connectionEpoch: number,
): ChatStopConfirmationTarget {
  return { turnId, revision, connectionEpoch };
}

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "queue-pill-request",
    handlers: {},
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger,
    findHostById: (requestedHostId) =>
      [DEFAULT_HOST, TAB_HOST].find(
        (entry) => entry.hostId === requestedHostId,
      ) ?? null,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(DEFAULT_HOST);
}

const NO_BACKGROUND_ITEMS: ReadonlyArray<BackgroundItem> = [];

function surfacesProps(
  onStopTurn: () => string | null,
): ChatLowerInteractionSurfacesProps {
  return {
    epicId: EPIC_ID,
    viewTabId: TAB_ID,
    chatId: CHAT_ID,
    hostId: TAB_HOST.hostId,
    runtime: { snapshotLoaded: true },
    access: { isViewer: false, canAct: true, readOnlyNotice: null },
    turn: {
      activeTurnStatus: null,
      steerCapable: false,
      steerProtocolSupported: true,
      autoPermissionModeProtocolSupported: null,
      getDraftBlobBridgeSupported: () => false,
      // Composer-only under the new contract; Stop no longer reads this.
      getActiveTurnForSteer: () => null,
      getStopConfirmationTarget: () => stopTarget(null, 0, 0),
      stopDisabled: false,
      onStopTurn,
    },
    interview: {
      pending: null,
      isBusy: false,
      unanswerable: [],
      unanswerableBusy: false,
      onAnswer: () => null,
      onSkip: () => null,
      onFork: null,
      highlightedBlockId: null,
    },
    approvals: {
      pendingFileEditApprovals: [],
      pendingApprovals: [],
      onFileEditDecision: () => undefined,
      onApprovalDecision: () => undefined,
      highlightedApprovalId: null,
      ruleDraftWorkspace: { remote: null, branch: null },
      onOpenSettings: () => undefined,
    },
    queue: {
      editingItem: null,
      editingItemId: null,
      value: { status: "idle", items: [] },
      resumeRequested: false,
      keepPausedRequested: false,
      onPause: () => null,
      onResume: () => null,
      onEdit: () => undefined,
      onCancel: () => undefined,
      onAbortSteer: () => undefined,
      onCancelEdit: () => undefined,
      onStopBackgroundItem: () => null,
      onStopAllBackgroundItems: () => null,
      onStopBackgroundSession: () => null,
      onReorder: () => undefined,
      onSteerNow: () => undefined,
    },
    composer: {
      sessionSettingsSeed: null,
      fallbackSettingsSeed: null,
      nodeId: CHAT_ID,
      isActive: true,
      mentionRoots: [],
      fallbackToGlobalMentionRoots: true,
      currentEpicId: EPIC_ID,
      onSubmitMessage: () => false,
      onSideChat: () => false,
      onSettingsChange: null,
      workspaceControls: (
        <ChatDockCompactStrip
          actionsRef={() => undefined}
          snapshotLoaded
          onSettled={() => undefined}
        />
      ),
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
      suggestedPrompt: undefined,
    },
    todo: null,
    restoreContext: EMPTY_RESTORE,
    backgroundItems: NO_BACKGROUND_ITEMS,
    providerFallback: NO_PROVIDER_FALLBACK,
    backgroundStopPendingTaskIds: new Set(),
    backgroundStopAllPending: false,
    backgroundSessionStopPending: false,
    onBackgroundItemClick: () => undefined,
    subagentView: null,
  };
}

function tile(
  props: ChatLowerInteractionSurfacesProps,
  queryClient: QueryClient,
): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicHandle}>
        <TabHostProvider hostId={TAB_HOST.hostId}>
          <TooltipProvider>
            <ChatLowerInteractionSurfaces {...props} />
          </TooltipProvider>
        </TabHostProvider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  installManagedCommandChatSession({
    hostId: TAB_HOST.hostId,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
  });
  installManagedCommandChatSession({
    hostId: TAB_HOST.hostId,
    epicId: EPIC_ID,
    chatId: OTHER_CHAT_ID,
  });
  useChatDockOpenStore.setState({
    openByChatId: new Map(),
    queueCollapsedByChatId: new Map(),
  });
  epicHandle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
  });
  const client = buildGlobalClient();
  globalClientRef.value = client;
  bindingRef.value = { hostId: null, hostClient: client };
});

afterEach(() => {
  cleanup();
  useChatDockOpenStore.setState({
    openByChatId: new Map(),
    queueCollapsedByChatId: new Map(),
  });
  disposeManagedCommandChatSessions();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  agentStopControlsMock = { self: null, descendants: [] };
  viewportMock.phone = false;
  globalClientRef.value = null;
  bindingRef.value = null;
});


const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function queuedPrompt(queueItemId: string): ChatQueuedPromptItem {
  const content: JsonContent = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: queueItemId }] },
    ],
  };
  return {
    kind: "prompt",
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: { kind: "user", content, browserAnnotations: [] },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tileFor(
  chatId: string,
  items: ReadonlyArray<ChatQueuedPromptItem>,
  queryClient: QueryClient,
): ReactElement {
  const props = surfacesProps(() => null);
  const queue: ChatSessionState["queue"] = { status: "idle", items: [...items] };
  return tile(
    {
      ...props,
      chatId,
      composer: { ...props.composer, nodeId: chatId },
      queue: { ...props.queue, value: queue },
    },
    queryClient,
  );
}

describe("the Message queue fold survives the queue emptying (#2441)", () => {
  it("keeps a folded queue folded when the next message arrives after the panel unmounted", () => {
    const queryClient = new QueryClient();
    const view = render(
      tileFor(CHAT_ID, [queuedPrompt("first")], queryClient),
    );
    expect(screen.getByTestId("queued-message-list")).not.toBeNull();

    fireEvent.click(screen.getByTestId("queued-message-header-toggle"));
    expect(screen.queryByTestId("queued-message-list")).toBeNull();

    view.rerender(tileFor(CHAT_ID, [], queryClient));
    expect(screen.queryByTestId("queued-message-rows")).toBeNull();

    view.rerender(tileFor(CHAT_ID, [queuedPrompt("second")], queryClient));
    // The panel is back (header says one message), and it is still folded.
    expect(screen.getByTestId("queued-message-rows")).not.toBeNull();
    expect(screen.getByTestId("queued-message-header").textContent).toContain(
      "1 message",
    );
    expect(screen.queryByTestId("queued-message-list")).toBeNull();
    expect(
      useChatDockOpenStore.getState().queueCollapsedByChatId.get(CHAT_ID),
    ).toBe(true);
  });

  it("reopens from the header after a remount and forgets the fold", () => {
    const queryClient = new QueryClient();
    const view = render(
      tileFor(CHAT_ID, [queuedPrompt("first")], queryClient),
    );
    fireEvent.click(screen.getByTestId("queued-message-header-toggle"));
    view.rerender(tileFor(CHAT_ID, [], queryClient));
    view.rerender(tileFor(CHAT_ID, [queuedPrompt("second")], queryClient));

    fireEvent.click(screen.getByTestId("queued-message-header-toggle"));

    expect(screen.getByTestId("queued-message-list")).not.toBeNull();
    expect(
      useChatDockOpenStore.getState().queueCollapsedByChatId.has(CHAT_ID),
    ).toBe(false);
  });

  it("leaves another chat's queue open", () => {
    useChatDockOpenStore.getState().setQueueCollapsed(CHAT_ID, true);

    render(tileFor(OTHER_CHAT_ID, [queuedPrompt("other")], new QueryClient()));

    expect(screen.getByTestId("queued-message-list")).not.toBeNull();
  });

  it("opens a queue with no recorded fold", () => {
    render(tileFor(CHAT_ID, [queuedPrompt("first")], new QueryClient()));

    expect(screen.getByTestId("queued-message-list")).not.toBeNull();
  });
});
