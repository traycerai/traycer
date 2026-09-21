import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { stopAgentRequestSchema } from "@traycer/protocol/host/agent/shared";
import type {
  BackgroundItem,
  ChatActiveTurn,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * The composer's cascade-stop dialog must send "Stop all" to the tab's own
 * host, even when the app's selected host differs. Production routing
 * (`useTabHostClient` -> `useHostClientForHostId` -> `resolveNamedHostClient`)
 * and a real `HostClient` run unmocked; only provider-boundary hooks supply
 * host identities in place of a real `<HostRuntimeProvider>`.
 */

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => "supported",
  useStreamMethodSchemaVersion: () => null,
}));

vi.mock("@/components/chat/chat-lower-dock", () => ({
  ChatLowerDock: () => null,
}));

vi.mock("@/hooks/drafts/use-tab-draft-mirror", () => ({
  TabDraftMirrorMount: () => null,
}));

vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: {
    readonly workspaceControls: ReactNode;
    readonly onStopTurn: () => string | null;
    readonly stopDisabled: boolean;
  }) => (
    <div data-testid="composer-stub">
      {props.workspaceControls}
      <button
        type="button"
        data-testid="composer-stop-trigger"
        disabled={props.stopDisabled}
        onClick={() => props.onStopTurn()}
      >
        Stop
      </button>
    </div>
  ),
}));

let agentStopControlsMock: AgentStopControls = { self: null, descendants: [] };
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => agentStopControlsMock,
}));

// The layout signal, faked per test. Real module spread back in so everything
// else it exports keeps working.
const viewportMock = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/ui/use-mobile-viewport")>()),
  useIsMobileViewport: (): boolean => viewportMock.phone,
}));

interface TestHostBinding {
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry>;
}

const globalClientRef = vi.hoisted(() => ({
  value: null as HostClient<HostRpcRegistry> | null,
}));
const messengerRef = vi.hoisted(() => ({
  value: null as MockHostMessenger<HostRpcRegistry> | null,
}));
// Unscoped binding (`hostId: null`); a named resolution off it still reaches
// any host. Stabilized to one object per test, matching a real binding's
// reference stability across renders.
const bindingRef = vi.hoisted(() => ({
  value: null as TestHostBinding | null,
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
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { ChatDockCompactStrip } from "@/components/chat/chat-dock-compact-strip";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import { hostQueryKeys } from "@/lib/query-keys";
import type {
  AgentRow,
  AgentStopControls,
} from "@/hooks/agent/use-agent-stop-controls";
import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";

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

function agentRow(id: string, title: string): AgentRow {
  return {
    id,
    title,
    surface: "gui",
    activity: "turn",
    hostId: TAB_HOST.hostId,
  };
}

function activeTurn(turnId: string): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status: "running",
    harnessId: "codex",
    model: "gpt-live",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 3,
    updatedAt: 3,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function withActiveTurn(
  props: ChatLowerInteractionSurfacesProps,
  getActiveTurnForSteer: () => ChatActiveTurn | null,
): ChatLowerInteractionSurfacesProps {
  return { ...props, turn: { ...props.turn, getActiveTurnForSteer } };
}

function buildGlobalClient(): HostClient<HostRpcRegistry> {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "agent-stop-request",
    handlers: {
      "agent.stop": (request) => ({ stoppedAgentIds: [request.agentId] }),
    },
  });
  messengerRef.value = messenger;
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
      getActiveTurnForSteer: () => null,
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
    },
    todo: null,
    restoreContext: EMPTY_RESTORE,
    backgroundItems: [] as ReadonlyArray<BackgroundItem>,
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

function openStopChildrenDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("composer-stop-trigger"));
  return screen.findByTestId("stop-children-dialog");
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
  agentStopControlsMock = {
    self: agentRow(CHAT_ID, "This chat"),
    descendants: [agentRow("child-1", "Child one")],
  };
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
  messengerRef.value = null;
  bindingRef.value = null;
});

describe("composer cascade-stop dialog host routing", () => {
  it("sends Stop all's agent.stop to the tab's own host, not the app-wide effective host", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      tile(
        surfacesProps(() => null),
        queryClient,
      ),
    );

    const dialog = await openStopChildrenDialog();
    fireEvent.click(within(dialog).getByTestId("stop-children-stop-all"));

    await waitFor(() => {
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.error),
      ).toEqual([null]);
      expect(messengerRef.value?.calls).toHaveLength(1);
    });
    const call = messengerRef.value?.calls[0];
    expect(call?.method).toBe("agent.stop");
    const request = stopAgentRequestSchema.parse(call?.params);
    expect(request.epicId).toBe(EPIC_ID);
    expect(request.agentId).toBe(CHAT_ID);
    expect(request.cascade).toBe(true);
    expect(call?.authority.endpoint).toEqual({
      hostId: TAB_HOST.hostId,
      websocketUrl: TAB_HOST.websocketUrl,
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: hostQueryKeys.methodScope(TAB_HOST.hostId, "agent.list"),
      });
    });
  });

  it("stops only this agent's turn locally, with no agent.stop RPC at all", async () => {
    const onStopTurn = vi.fn((): string | null => null);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(tile(surfacesProps(onStopTurn), queryClient));

    const dialog = await openStopChildrenDialog();
    fireEvent.click(within(dialog).getByTestId("stop-children-only-this"));

    expect(onStopTurn).toHaveBeenCalledTimes(1);
    expect(messengerRef.value?.calls).toHaveLength(0);
  });
});

/**
 * The phone layout puts Stop beside Send at 32px each, so a tap meant for
 * Queue lands on Stop and kills the turn. Everything below turns on the
 * LAYOUT and nothing else: `descendants` is emptied so the cascade dialog -
 * which is already its own confirmation - cannot be what is being observed.
 */
describe("stop confirmation on a phone layout", () => {
  const PHONE_TURN_ID = "turn-phone-1";

  beforeEach(() => {
    agentStopControlsMock = {
      self: agentRow(CHAT_ID, "This chat"),
      descendants: [],
    };
  });

  function phoneProps(
    onStopTurn: () => string | null,
    getActiveTurnForSteer: () => ChatActiveTurn | null,
  ): ChatLowerInteractionSurfacesProps {
    return withActiveTurn(surfacesProps(onStopTurn), getActiveTurnForSteer);
  }

  // Stop is enabled as soon as the host starts activating a turn, before that
  // turn's ID has arrived from the steer accessor - `activeTurnStatus` is
  // "running" while `getActiveTurnForSteer()` still returns null.
  function phonePropsBeforeTurnActivates(
    onStopTurn: () => string | null,
    getActiveTurnForSteer: () => ChatActiveTurn | null,
  ): ChatLowerInteractionSurfacesProps {
    const base = phoneProps(onStopTurn, getActiveTurnForSteer);
    return { ...base, turn: { ...base.turn, activeTurnStatus: "running" } };
  }

  function renderTile(
    onStopTurn: () => string | null,
    getActiveTurnForSteer: () => ChatActiveTurn | null,
  ): void {
    render(
      tile(
        phoneProps(onStopTurn, getActiveTurnForSteer),
        new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
      ),
    );
  }

  it("asks before stopping, and does not stop while the dialog is open", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    renderTile(onStopTurn, () => activeTurn(PHONE_TURN_ID));

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(within(dialog).getByText("Stop this turn?")).not.toBeNull();
    // The whole point: raising the dialog must not have stopped anything.
    expect(onStopTurn).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(onStopTurn).toHaveBeenCalledTimes(1);
  });

  it("leaves the turn running when the confirmation is cancelled", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    renderTile(onStopTurn, () => activeTurn(PHONE_TURN_ID));

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(onStopTurn).not.toHaveBeenCalled();
  });

  it("opens and stops once when Stop is enabled before the turn's ID has materialized", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    render(
      tile(
        phonePropsBeforeTurnActivates(onStopTurn, () => null),
        new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
      ),
    );

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(onStopTurn).toHaveBeenCalledTimes(1);
  });

  it("does not stop when the turn's ID materializes to something else before confirming", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    const live: { value: ChatActiveTurn | null } = { value: null };
    render(
      tile(
        phonePropsBeforeTurnActivates(onStopTurn, () => live.value),
        new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
      ),
    );

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");

    live.value = activeTurn(PHONE_TURN_ID);
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(onStopTurn).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });

  it("does not stop the turn when a different turn became active while the confirmation was open", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    // A mutable box read through the SAME getter reference every call - this
    // is how a live steer-turn getter actually drifts under a dialog that is
    // already mounted, with no rerender in between.
    const live: { value: ChatActiveTurn | null } = {
      value: activeTurn("turn-A"),
    };
    renderTile(onStopTurn, () => live.value);

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");

    live.value = activeTurn("turn-B");
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(onStopTurn).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
  });

  it("does not stop the turn when it already ended while the confirmation was open", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    const live: { value: ChatActiveTurn | null } = {
      value: activeTurn("turn-A"),
    };
    renderTile(onStopTurn, () => live.value);

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");

    live.value = null;
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    expect(onStopTurn).not.toHaveBeenCalled();
  });

  it("hands over to the cascade prompt when a sub-agent starts while it is open", async () => {
    viewportMock.phone = true;
    const onStopTurn = vi.fn((): string | null => null);
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const props = phoneProps(onStopTurn, () => activeTurn(PHONE_TURN_ID));
    const view = render(tile(props, client));

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");

    agentStopControlsMock = {
      self: agentRow(CHAT_ID, "This chat"),
      descendants: [agentRow("child-1", "Child one")],
    };
    view.rerender(tile(props, client));
    fireEvent.click(within(dialog).getByTestId("confirm-action"));

    // Confirming must not stop only this turn behind the sub-agent's back.
    expect(onStopTurn).not.toHaveBeenCalled();
    expect(await screen.findByText("Child one")).not.toBeNull();
  });

  it("stops immediately on a desktop layout, with no confirmation at all", () => {
    viewportMock.phone = false;
    const onStopTurn = vi.fn((): string | null => null);
    renderTile(onStopTurn, () => activeTurn(PHONE_TURN_ID));

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));

    expect(onStopTurn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
  });
});

/**
 * Both stop dialogs stay bound to the turn they were raised for. Raising
 * either one captures the live turn at that moment, and every action inside
 * it - confirming, or handing off from the phone dialog to the cascade
 * dialog - must refuse to proceed once that turn is no longer the live one,
 * whether the dialog was opened directly or reached by handoff.
 */
describe("cascade stop confirmation stays scoped to the captured turn", () => {
  const TURN_A = "turn-A";
  const TURN_B = "turn-B";

  it.each([
    ["Stop all", "stop-children-stop-all"],
    ["Only this agent", "stop-children-only-this"],
  ] as const)(
    "opened directly: %s does nothing once a different turn is live",
    async (_label, testId) => {
      const onStopTurn = vi.fn((): string | null => null);
      const live: { value: ChatActiveTurn | null } = {
        value: activeTurn(TURN_A),
      };
      const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      render(
        tile(
          withActiveTurn(surfacesProps(onStopTurn), () => live.value),
          queryClient,
        ),
      );

      const dialog = await openStopChildrenDialog();
      live.value = activeTurn(TURN_B);
      fireEvent.click(within(dialog).getByTestId(testId));

      expect(onStopTurn).not.toHaveBeenCalled();
      // Checked synchronously, right after the click: mutation creation is
      // synchronous, so this proves `agentStop.mutate` was never called at
      // all, rather than merely that its request hasn't reached the
      // messenger yet.
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
      expect(messengerRef.value?.calls).toHaveLength(0);
    },
  );

  it.each([
    ["Stop all", "stop-children-stop-all"],
    ["Only this agent", "stop-children-only-this"],
  ] as const)(
    "transferred from the phone dialog: %s does nothing once a different turn is live",
    async (_label, testId) => {
      viewportMock.phone = true;
      agentStopControlsMock = {
        self: agentRow(CHAT_ID, "This chat"),
        descendants: [],
      };
      const onStopTurn = vi.fn((): string | null => null);
      const live: { value: ChatActiveTurn | null } = {
        value: activeTurn(TURN_A),
      };
      const queryClient = new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      });
      const props = withActiveTurn(surfacesProps(onStopTurn), () => live.value);
      const view = render(tile(props, queryClient));

      fireEvent.click(screen.getByTestId("composer-stop-trigger"));
      const phoneDialog = await screen.findByTestId(
        "confirm-destructive-dialog",
      );

      // A sub-agent starts while the phone dialog is open, and the turn is
      // still TURN_A at the moment of confirm - the handoff itself must
      // carry the captured turnId (not re-read a fresh one) into the cascade
      // dialog that replaces it.
      agentStopControlsMock = {
        self: agentRow(CHAT_ID, "This chat"),
        descendants: [agentRow("child-1", "Child one")],
      };
      view.rerender(tile(props, queryClient));
      fireEvent.click(within(phoneDialog).getByTestId("confirm-action"));

      const cascadeDialog = await screen.findByTestId("stop-children-dialog");
      live.value = activeTurn(TURN_B);
      fireEvent.click(within(cascadeDialog).getByTestId(testId));

      expect(onStopTurn).not.toHaveBeenCalled();
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
      expect(messengerRef.value?.calls).toHaveLength(0);
    },
  );

  it("refuses a stale phone confirmation once sub-agents have appeared and the turn has moved on", async () => {
    viewportMock.phone = true;
    agentStopControlsMock = {
      self: agentRow(CHAT_ID, "This chat"),
      descendants: [],
    };
    const onStopTurn = vi.fn((): string | null => null);
    const live: { value: ChatActiveTurn | null } = {
      value: activeTurn(TURN_A),
    };
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const props = withActiveTurn(surfacesProps(onStopTurn), () => live.value);
    const view = render(tile(props, queryClient));

    fireEvent.click(screen.getByTestId("composer-stop-trigger"));
    const phoneDialog = await screen.findByTestId("confirm-destructive-dialog");

    agentStopControlsMock = {
      self: agentRow(CHAT_ID, "This chat"),
      descendants: [agentRow("child-1", "Child one")],
    };
    view.rerender(tile(props, queryClient));

    // The turn moves on to TURN_B before the user ever confirms - the stale
    // phone dialog is still showing, on the same getter, with no rerender.
    live.value = activeTurn(TURN_B);
    fireEvent.click(within(phoneDialog).getByTestId("confirm-action"));

    expect(onStopTurn).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(messengerRef.value?.calls).toHaveLength(0);
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(screen.queryByTestId("stop-children-dialog")).toBeNull();
  });
});
