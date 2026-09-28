import { act, cleanup, render, screen, within } from "@testing-library/react";
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
  PendingFallback,
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
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { ChatDockCompactStrip } from "@/components/chat/chat-dock-compact-strip";
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
      workspaceControls: <ChatDockCompactStrip />,
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
  disposeManagedCommandChatSessions();
  epicHandle.dispose();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  agentStopControlsMock = { self: null, descendants: [] };
  viewportMock.phone = false;
  globalClientRef.value = null;
  bindingRef.value = null;
});

const ROUTING_SENTENCE = "Held by routing after the last turn failed.";
const TURN_ERROR_SENTENCE =
  "Held because the last turn failed. Resume to send it.";
const HOLD_REASON = "Queue paused while routing recovers the failed turn.";
const RESTAMP_REASON =
  "Queue paused: this message's settings are not supported on the provider the chat switched to, so it was left on the previous one. Resume it to run it anyway.";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

type FallbackState = PendingFallback["state"];
type PausedReason = "routing" | "turn_error";

function docContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function pausedPrompt(
  queueItemId: string,
  text: string,
  fallbackReason: string,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: {
      kind: "user",
      content: docContent(text),
      browserAnnotations: [],
    },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "paused",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason,
    createdAt: 1,
    updatedAt: 1,
  };
}

const HELD_ROW = pausedPrompt("queue-held", "Held prompt", HOLD_REASON);
const REJECTED_ROW = pausedPrompt(
  "queue-rejected",
  "Rejected prompt",
  RESTAMP_REASON,
);

function pendingFallbackIn(state: FallbackState): PendingFallback {
  return {
    traversalId: "t1",
    revision: 1,
    state,
    reason: "rate_limit",
    failedTuple: SETTINGS,
    targetTuple: null,
    impendingAction: null,
    deadline: null,
    graceRemainingMs: null,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
  };
}

function sessionStore() {
  const handle = __getChatSessionRegistryForTests().peek(
    EPIC_ID,
    CHAT_ID,
    TAB_HOST.hostId,
  );
  if (handle === null) throw new Error("chat session was not registered");
  return handle.store;
}

function setFallbackState(state: FallbackState | undefined) {
  act(() => {
    sessionStore().setState({
      pendingFallback:
        state === undefined ? undefined : pendingFallbackIn(state),
    });
  });
}

/** `pausedReason` undefined is the ABSENT key: a host that predates it. */
function pausedQueue(
  pausedReason: PausedReason | undefined,
): ChatSessionState["queue"] {
  const base: ChatSessionState["queue"] = {
    status: "paused",
    items: [HELD_ROW, REJECTED_ROW],
  };
  return pausedReason === undefined ? base : { ...base, pausedReason };
}

function renderQueue(pausedReason: PausedReason | undefined) {
  const props = surfacesProps(() => null);
  render(
    tile(
      { ...props, queue: { ...props.queue, value: pausedQueue(pausedReason) } },
      new QueryClient(),
    ),
  );
}

function rows(): readonly HTMLElement[] {
  return screen.getAllByTestId("queued-message-row");
}

function badgeOf(row: HTMLElement): HTMLElement {
  return within(row).getByTestId("queued-message-status-badge");
}

function pillTooltips(): readonly (string | null)[] {
  return rows().map((row) => tooltipTextNear(badgeOf(row)));
}

function expectOneRoutingSentence() {
  for (const row of rows()) {
    expect(badgeOf(row).textContent).toBe("Paused after an error");
  }
  const tooltips = pillTooltips();
  expect(tooltips).toEqual([ROUTING_SENTENCE, ROUTING_SENTENCE]);
  for (const tooltip of tooltips) {
    expect(tooltip).not.toContain("moved the chat");
    expect(tooltip).not.toContain("runs when routing finishes");
    expect(tooltip).not.toContain("sends it now");
  }
}

describe("queue pill tooltip through the tile, routing pause", () => {
  it.each<{
    readonly name: string;
    readonly state: FallbackState | undefined;
    readonly launchedFrom: FallbackState | null;
  }>([
    { name: "hold", state: "hold", launchedFrom: null },
    { name: "choosing", state: "choosing", launchedFrom: null },
    { name: "waiting", state: "waiting", launchedFrom: null },
    { name: "switching", state: "switching", launchedFrom: null },
    { name: "retrying", state: "retrying", launchedFrom: null },
    {
      name: "undefined: the launched replacement",
      state: undefined,
      launchedFrom: "retrying",
    },
    {
      name: "undefined: the traversal over with a parked row",
      state: undefined,
      launchedFrom: null,
    },
  ])(
    "says one sentence in both rows with pendingFallback $name",
    ({ state, launchedFrom }) => {
      renderQueue("routing");
      if (launchedFrom !== null) setFallbackState(launchedFrom);
      setFallbackState(state);

      expectOneRoutingSentence();
    },
  );

  it("F9: retrying with a routing-paused queue never says the chat moved or that Resume sends it now", () => {
    renderQueue("routing");
    setFallbackState("retrying");

    for (const tooltip of pillTooltips()) {
      expect(tooltip).not.toContain("moved the chat");
      expect(tooltip).not.toContain("Resume sends it now");
    }
  });

  it("F10: switching gives the rejected row the one sentence and never says it runs when routing finishes", () => {
    renderQueue("routing");
    setFallbackState("switching");

    const [heldRow, rejectedRow] = rows();
    expect(tooltipTextNear(badgeOf(rejectedRow))).toBe(ROUTING_SENTENCE);
    expect(within(rejectedRow).getByText(RESTAMP_REASON)).not.toBeNull();
    expect(rejectedRow.textContent).not.toContain("runs when routing finishes");
    expect(tooltipTextNear(badgeOf(rejectedRow))).not.toContain(
      "runs when routing finishes",
    );
    expect(within(heldRow).queryByText(HOLD_REASON)).toBeNull();
  });
});

describe("queue pill tooltip through the tile, turn_error pause", () => {
  it.each<{
    readonly name: string;
    readonly state: FallbackState | undefined;
  }>([
    { name: "hold", state: "hold" },
    { name: "choosing", state: "choosing" },
    { name: "waiting", state: "waiting" },
    { name: "switching", state: "switching" },
    { name: "retrying", state: "retrying" },
    { name: "undefined", state: undefined },
  ])("keeps the spec sentence with pendingFallback $name", ({ state }) => {
    renderQueue("turn_error");
    setFallbackState(state);

    for (const row of rows()) {
      expect(badgeOf(row).textContent).toBe("Paused after an error");
    }
    expect(pillTooltips()).toEqual([TURN_ERROR_SENTENCE, TURN_ERROR_SENTENCE]);
  });
});

const ERROR_HOLD_REASON =
  "Queue paused because the previous turn ended with an error.";

function renderErrorHeldQueue() {
  const props = surfacesProps(() => null);
  const queue: ChatSessionState["queue"] = {
    status: "paused",
    pausedReason: "turn_error",
    items: [pausedPrompt("queue-error-held", "Held prompt", ERROR_HOLD_REASON)],
  };
  render(
    tile(
      { ...props, queue: { ...props.queue, value: queue } },
      new QueryClient(),
    ),
  );
}

describe("queue pill tooltip through the tile, turn_error truthfulness", () => {
  it("turn_error while a manual retry is in flight never says Resume sends it now", () => {
    renderErrorHeldQueue();
    setFallbackState("retrying");

    const tooltip = tooltipTextNear(badgeOf(rows()[0]));
    expect(tooltip).not.toContain("sends it now");
    expect(tooltip).toBe(TURN_ERROR_SENTENCE);
  });

  it("a queue left parked after a manual rung never says Retry or switch sends it after", () => {
    renderErrorHeldQueue();
    setFallbackState(undefined);

    const tooltip = tooltipTextNear(badgeOf(rows()[0]));
    expect(tooltip).not.toContain("Retry or switch sends it after");
    expect(tooltip).toBe(TURN_ERROR_SENTENCE);
  });
});

describe("queue pill tooltip through the tile, older host", () => {
  it("shows a plain Paused with no tooltip when pausedReason is absent", () => {
    renderQueue(undefined);

    for (const row of rows()) {
      expect(badgeOf(row).textContent).toBe("Paused");
    }
    expect(pillTooltips()).toEqual([null, null]);
  });
});
