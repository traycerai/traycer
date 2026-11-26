import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import type {
  ChatRunSettings,
  OpenChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  SandboxCatalogue,
  SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import type { ChatComposerSubmitInput } from "@/components/chat/composer/chat-composer";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { ActivationOutcome } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { ChatStateLineContext } from "@/components/epic-canvas/renderers/chat-state-line";
import { chatSandboxStateLine } from "@/components/epic-canvas/renderers/chat-sandbox-state-line";
import { useBoundSandboxSend } from "@/hooks/sandboxes/use-bound-sandbox-send";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import {
  resolveChatSandbox,
  type ChatSandboxState,
  type RestingChatSandbox,
  wakeOf,
} from "@/lib/sandboxes/chat-sandbox-state";
import {
  MESSAGE_CONTENT,
  PICKED_SETTINGS,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { usePendingSandboxSendStore } from "@/stores/sandboxes/pending-sandbox-send-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { persistKey, STORE_KEYS } from "@/lib/persist";

const COMPOSER_DRAFT_STORAGE_KEY = persistKey(STORE_KEYS.composerDraft);
const PERSONAL_SANDBOX_HOST_ID = "personal-sandbox-after-pool";
const PERSONAL_SANDBOX_ID = "sandbox-after-pool";

const composerProps = vi.hoisted(
  () => [] as Array<{ sendDisabled: boolean | undefined }>,
);
const poolActionHarness = vi.hoisted(() => {
  return {
    catalogue: null as SandboxCatalogue | null,
    activate:
      vi.fn<
        (
          option: HostScopeOption,
          report: (show: () => void) => void,
          current: () => boolean,
        ) => Promise<ActivationOutcome>
      >(),
    directoryEntry: null as HostDirectoryEntry | null,
    directoryListeners: new Set<() => void>(),
    auth: {
      sandboxControlUnavailableReason: () => null,
      environmentCloud: () => ({ onOriginSignIn: () => true }),
      createSandbox:
        vi.fn<
          (input: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>
        >(),
      listEnvironments: vi.fn(),
      attachTaskEnvironment: vi.fn(),
    },
    directory: {
      knownHostIds: () => [],
      refresh: vi.fn(),
      findById: (hostId: string) =>
        poolActionHarness.directoryEntry?.hostId === hostId
          ? poolActionHarness.directoryEntry
          : null,
      onChange: (listener: () => void) => {
        poolActionHarness.directoryListeners.add(listener);
        return {
          dispose: () => poolActionHarness.directoryListeners.delete(listener),
        };
      },
    },
    openTransport: vi.fn(),
    openSettings: vi.fn(),
  };
});
vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: {
    readonly taskId: string;
    readonly sendDisabled: boolean | undefined;
    readonly topSlot: ReactNode;
    readonly onSubmitMessage: (input: ChatComposerSubmitInput) => boolean;
  }) => {
    composerProps.push({ sendDisabled: props.sendDisabled });
    const draft =
      useComposerDraftStore.getState().drafts[props.taskId]?.content;
    return (
      <div
        data-testid="composer-stub"
        data-draft={draft === undefined ? "" : JSON.stringify(draft)}
      >
        {props.topSlot}
        <button
          type="button"
          onClick={() =>
            props.onSubmitMessage({
              content: MESSAGE_CONTENT,
              contentText: "continue the review",
              attachments: [],
              settings: PICKED_SETTINGS,
              deliveryPolicy: "auto",
              restartConfirmed: false,
              restore: {
                content: MESSAGE_CONTENT,
                browserAnnotations: [],
              },
            })
          }
        >
          Send resting message
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/chat/composer/team-epic-personal-line", () => ({
  TeamEpicPersonalLine: () => null,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: () => undefined }),
}));
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicLiveArtifactTitle: () => null,
}));
vi.mock("@/components/chat/chat-lower-dock", () => ({
  ChatLowerDock: () => <div data-testid="dock-stub" />,
}));
vi.mock("@/components/chat/chat-stop-children-dialog", () => ({
  StopChildrenDialog: () => null,
}));
vi.mock("@/components/hosts/sandbox-confirm-dialogs", () => ({
  SandboxDestroyDialog: () => null,
}));
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));
vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({ mutate: () => undefined }),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/drafts/use-tab-draft-mirror", () => ({
  TabDraftMirrorMount: () => null,
}));
vi.mock("@/components/composer/pool-composer-actions", async (importOriginal) =>
  importOriginal<
    typeof import("@/components/composer/pool-composer-actions")
  >(),
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => ({
    auth: poolActionHarness.auth,
    directory: poolActionHarness.directory,
  }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: poolActionHarness.catalogue,
    isError: false,
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaultsLookup: () => () => null,
}));
vi.mock("@/hooks/sandboxes/use-team-bundle-balances", () => ({
  useTeamBundleBalances: () => () => 0,
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useMakeActiveHost: () => ({
    makeActiveWithWakeNotice: poolActionHarness.activate,
  }),
}));
vi.mock("@/hooks/epic/use-epic-attach-environment-mutation", () => ({
  useEpicAttachEnvironment: () => ({
    mutateAsync: () => Promise.resolve({ environmentId: "team-env" }),
  }),
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => poolActionHarness.openTransport,
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: poolActionHarness.openSettings,
  }),
}));

import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
  type ChatLowerAccessState,
  type ChatLowerInterviewState,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { readinessCatalogue } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const EMPTY_BACKGROUND_STOP_TASK_IDS: ReadonlySet<string> = new Set();
const RESTING_CHAT: RestingChatSandbox = {
  kind: "resting",
  sandbox: sandboxSummaryFixture({
    id: "sbx-resting",
    hostId: "owner-computer",
    state: "suspended",
  }),
  configuration: { kind: "personal" },
};
const EDIT_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};
const EDITING_ITEM: OpenChatQueuedPromptItem = {
  kind: "prompt",
  queueItemId: "queue-editing",
  messageId: "message-editing",
  message: {
    kind: "user",
    content: { type: "doc", content: [] },
    browserAnnotations: [],
  },
  sender: { type: "user", userId: "owner-1" },
  settings: EDIT_SETTINGS,
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

const RESTORE_CONTEXT: ChatRestoreContextValue = {
  accessRole: "owner",
  activeHostId: "host-1",
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

function render(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return testingRender(
    <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
      <QueryClientProvider client={queryClient}>
        <TabHostProvider hostId="host-1">
          <TooltipProvider delayDuration={0}>
            <LazyMotion features={domAnimation}>{ui}</LazyMotion>
          </TooltipProvider>
        </TabHostProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

function props(
  access: ChatLowerAccessState,
): ChatLowerInteractionSurfacesProps {
  const interview = interviewState();
  return {
    epicId: "epic-1",
    viewTabId: "tab-1",
    chatId: "chat-1",
    hostId: "host-1",
    runtime: { snapshotLoaded: true },
    access,
    turn: {
      activeTurnStatus: null,
      steerCapable: false,
      steerProtocolSupported: true,
      autoPermissionModeProtocolSupported: null,
      ultracodeProtocolSupported: false,
      getDraftBlobBridgeSupported: () => false,
      getActiveTurnForSteer: () => null,
      // Unused by this suite - it covers the send gate, not Stop.
      getStopConfirmationTarget: () => ({
        turnId: null,
        revision: 0,
        connectionEpoch: 0,
      }),
      stopDisabled: true,
      onStopTurn: () => null,
    },
    interview,
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
      nodeId: "chat-1",
      isActive: true,
      mentionRoots: [],
      runWorkingDirectory: null,
      fallbackToGlobalMentionRoots: true,
      currentEpicId: "epic-1",
      onSubmitMessage: () => false,
      onSideChat: () => false,
      onSettingsChange: null,
      workspaceControls: <div data-testid="host-workspace-selector" />,
      workspaceAvailability: WORKSPACE_COMPOSER_READY,
      onClone: () => undefined,
      onContinueOnTeamHosts: () => undefined,
      suggestedPrompt: undefined,
    },
    todo: null,
    restoreContext: RESTORE_CONTEXT,
    providerFallback: NO_PROVIDER_FALLBACK,
    backgroundItems: undefined,
    backgroundStopPendingTaskIds: EMPTY_BACKGROUND_STOP_TASK_IDS,
    backgroundStopAllPending: false,
    backgroundSessionStopPending: false,
    onBackgroundItemClick: () => undefined,
    subagentView: null,
  };
}

function interviewState(): ChatLowerInterviewState {
  return {
    pending: null,
    isBusy: false,
    unanswerable: [],
    unanswerableBusy: false,
    onAnswer: () => null,
    onSkip: () => null,
    onFork: null,
    highlightedBlockId: null,
  };
}

const VIEWER_CANNOT_ACT = {
  isViewer: true,
  isCopy: false,
  canAct: false,
  readOnlyNotice: null,
} as const;

function evictedAccess(parksEvictedSend: boolean) {
  return { ...VIEWER_CANNOT_ACT, parksEvictedSend };
}

const SLOT_STATE_CASES: ReadonlyArray<{
  readonly name: string;
  readonly state: ChatSandboxState;
}> = [
  { name: "pending", state: { kind: "pending", name: "pending sandbox" } },
  {
    name: "moving",
    state: {
      kind: "moving",
      sandbox: sandboxSummaryFixture({ state: "resuming" }),
      state: "resuming",
    },
  },
  {
    name: "released",
    state: {
      kind: "released",
      sandbox: sandboxSummaryFixture({ state: "suspended" }),
    },
  },
  {
    name: "unconfigured resting",
    state: {
      kind: "resting",
      sandbox: sandboxSummaryFixture({ state: "suspended" }),
      configuration: null,
    },
  },
  {
    name: "failed",
    state: {
      kind: "failed",
      sandbox: sandboxSummaryFixture({ state: "failed" }),
    },
  },
  {
    name: "destroyed",
    state: {
      kind: "destroyed",
      ended: {
        name: "ended sandbox",
        end: {
          state: "destroyed",
          destroyedAt: new Date(2026, 9, 28, 1, 27).getTime(),
          cause: "verb",
          actor: "you",
          idleMinutes: null,
        },
      },
    },
  },
];

beforeEach(() => {
  window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  poolActionHarness.directoryEntry = null;
  poolActionHarness.directoryListeners.clear();
  poolActionHarness.auth.createSandbox.mockReset();
  poolActionHarness.activate.mockReset();
  poolActionHarness.activate.mockResolvedValue("saved");
  poolActionHarness.catalogue = readinessCatalogue({
    warm: 0,
    coldCreateMeasuredMs: 60_000,
  });
  useEpicCanvasStore.getState().openEpicTabWithId("tab-1", "epic-1", "Task");
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
});

function publishSandbox(entry: HostDirectoryEntry): void {
  poolActionHarness.directoryEntry = entry;
  poolActionHarness.directoryListeners.forEach((listener) => listener());
}

afterEach(() => {
  cleanup();
  composerProps.length = 0;
  useSelectionAuthorityStore.getState().reset();
  useSurfaceHostSelectionStore.getState().resetForTests();
  usePendingSandboxSendStore.setState({ sends: {} });
  useStagedSandboxStore.setState({ bySurface: {} });
  poolActionHarness.directoryEntry = null;
  poolActionHarness.directoryListeners.clear();
  useComposerDraftStore.setState({
    drafts: useComposerDraftStore.getInitialState().drafts,
  });
  window.localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  useEpicCanvasStore.getState().discardTabState("tab-1");
});

describe("the composer of an evicted chat the pool serves", () => {
  it.each([
    {
      name: "the task owner",
      access: {
        ownerHostId: "owner-computer",
        isViewer: false,
        isCopy: false,
        canAct: false,
        readOnlyNotice: "This computer is offline.",
        parksEvictedSend: false,
      },
    },
    {
      name: "a role-only viewer",
      access: { ...evictedAccess(false), ownerHostId: "owner-computer" },
    },
    {
      name: "a foreign copy viewer",
      access: {
        ...evictedAccess(false),
        isCopy: true,
        ownerHostId: "owner-computer",
      },
    },
  ])(
    "shows only the real pool controls for $name while the owner computer is cold",
    ({ access }) => {
      useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
      render(<ChatLowerInteractionSurfaces {...props(access)} />);

      if (access.isViewer || access.isCopy) {
        expect(screen.queryByText("Read-only viewer.")).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Clone agent" }),
        ).toBeNull();
        expect(screen.queryByTestId("host-workspace-selector")).toBeNull();
      }
      expect(
        screen.getByRole("button", { name: "Start a sandbox" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Connect a computer" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Host: none selected" }),
      ).toBeTruthy();
      expect(screen.queryByTestId("composer-stub")).toBeNull();
    },
  );

  it("preserves the archived chat's state line actions on the pool", () => {
    useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
    render(
      <ChatStateLineContext
        value={{
          kind: "destroyed",
          line: "This sandbox was destroyed.",
          actions: <button type="button">Continue on another host</button>,
        }}
      >
        <ChatLowerInteractionSurfaces {...props(evictedAccess(false))} />
      </ChatStateLineContext>,
    );

    expect(
      screen.queryByRole("button", { name: "Use team sandbox" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue on another host" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("composer-stub")).toBeNull();
  });

  it.each(SLOT_STATE_CASES)(
    "keeps the resolver's $name line and actions, then puts pool controls below",
    ({ state }) => {
      useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
      const view = resolveChatSandbox(state, {
        reachable: false,
        ownedByViewer: true,
        environmentOwned: false,
      });
      const stateLine = chatSandboxStateLine(
        view.line,
        <button type="button">Continue on another host</button>,
      );
      if (stateLine === null) throw new Error("expected a sandbox slot line");

      render(
        <ChatStateLineContext value={stateLine}>
          <ChatLowerInteractionSurfaces
            {...props({
              ...evictedAccess(false),
              ownerHostId: "owner-computer",
            })}
          />
        </ChatStateLineContext>,
      );

      const line = screen.getByText(stateLine.line);
      const start = screen.getByRole("button", { name: "Start a sandbox" });
      expect(
        line.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(
        screen.getByRole("button", { name: "Host: none selected" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
      expect(screen.queryByTestId("host-workspace-selector")).toBeNull();
      expect(screen.queryByTestId("composer-stub")).toBeNull();
      if (state.kind === "failed") {
        expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
      }
      if (state.kind === "destroyed") {
        expect(
          screen.getByRole("button", { name: "Continue on another host" }),
        ).toBeTruthy();
      }
    },
  );

  it("keeps the real chat box when its source computer is ready while the pool serves", () => {
    useSelectionAuthorityStore.setState({
      servingPeer: { kind: "pool" },
      leases: [{ hostId: "owner-computer", status: "ready", dead: null }],
    });
    render(
      <ChatLowerInteractionSurfaces
        {...props({
          ownerHostId: "owner-computer",
          isViewer: false,
          isCopy: false,
          canAct: true,
          readOnlyNotice: null,
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Use team sandbox" }),
    ).toBeNull();
    expect(screen.getByTestId("composer-stub")).toBeTruthy();
  });

  it("keeps the offline copy's draft while the real pool controls replace its composer slot", () => {
    useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
    const base = props({
      ...VIEWER_CANNOT_ACT,
      isCopy: true,
      ownerHostId: "owner-computer",
    });
    const draftStore = useComposerDraftStore.getState();
    draftStore.setSnapshot(
      base.chatId,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "saved draft" }],
          },
        ],
      },
      null,
    );
    const previousDraft = useComposerDraftStore.getState().drafts[base.chatId];
    render(<ChatLowerInteractionSurfaces {...base} />);

    expect(
      screen.getByRole("button", { name: "Start a sandbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host: none selected" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(useComposerDraftStore.getState().drafts[base.chatId]).toBe(
      previousDraft,
    );

    act(() =>
      useSelectionAuthorityStore.setState({
        servingPeer: { kind: "computer", hostId: "owner-computer" },
        leases: [{ hostId: "owner-computer", status: "ready", dead: null }],
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Host: none selected" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    expect(useComposerDraftStore.getState().drafts[base.chatId]).toBe(
      previousDraft,
    );
  });

  it("rehydrates a chat draft into a fresh store while pool controls stay visible, then restores it when the owner serves", async () => {
    useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
    const owner = props({
      ownerHostId: "owner-computer",
      isViewer: false,
      isCopy: false,
      canAct: false,
      readOnlyNotice: "This computer is offline.",
    });
    const content = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "reload draft" }],
        },
      ],
    };
    useComposerDraftStore.getState().setSnapshot(owner.chatId, content, null);
    const persistedBytes = window.localStorage.getItem(
      COMPOSER_DRAFT_STORAGE_KEY,
    );
    if (persistedBytes === null) throw new Error("draft was not persisted");

    render(<ChatLowerInteractionSurfaces {...owner} />);
    expect(
      screen.getByRole("button", { name: "Start a sandbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host: none selected" }),
    ).toBeTruthy();

    useComposerDraftStore.setState({ drafts: {} });
    window.localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, persistedBytes);
    vi.resetModules();
    const freshDraftStoreModule =
      await import("@/stores/composer/composer-draft-store");
    expect(freshDraftStoreModule.useComposerDraftStore).not.toBe(
      useComposerDraftStore,
    );
    expect(
      freshDraftStoreModule.useComposerDraftStore.getState().drafts[
        owner.chatId
      ]?.content,
    ).toEqual(content);

    expect(
      screen.getByRole("button", { name: "Start a sandbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host: none selected" }),
    ).toBeTruthy();

    await act(async () => {
      await useComposerDraftStore.persist.rehydrate();
    });

    expect(
      screen.getByRole("button", { name: "Start a sandbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host: none selected" }),
    ).toBeTruthy();
    expect(
      useComposerDraftStore.getState().drafts[owner.chatId]?.content,
    ).toEqual(content);

    act(() =>
      useSelectionAuthorityStore.setState({
        servingPeer: { kind: "computer", hostId: "owner-computer" },
        leases: [{ hostId: "owner-computer", status: "ready", dead: null }],
      }),
    );

    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.getByTestId("composer-stub").getAttribute("data-draft"),
    ).toContain("reload draft");
  });

  it("starts Personal from a cold read-only chat, then keeps the source read-only with its draft when Personal serves", async () => {
    useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
    const source = props({
      ownerHostId: "owner-computer",
      isViewer: true,
      isCopy: true,
      canAct: false,
      readOnlyNotice: "Read-only viewer.",
    });
    useComposerDraftStore.getState().setSnapshot(
      source.chatId,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "offline source draft" }],
          },
        ],
      },
      null,
    );
    const originalDraft =
      useComposerDraftStore.getState().drafts[source.chatId];
    poolActionHarness.auth.createSandbox.mockResolvedValueOnce({
      kind: "ok",
      accepted: {
        sandboxId: PERSONAL_SANDBOX_ID,
        hostId: PERSONAL_SANDBOX_HOST_ID,
        sandbox: sandboxSummaryFixture({
          id: PERSONAL_SANDBOX_ID,
          hostId: PERSONAL_SANDBOX_HOST_ID,
          state: "creating",
          wakeBudgetMs: 120_000,
        }),
      },
    });

    render(<ChatLowerInteractionSurfaces {...source} />);
    fireEvent.click(screen.getByRole("button", { name: "Start a sandbox" }));
    await waitFor(() =>
      expect(poolActionHarness.auth.createSandbox).toHaveBeenCalledTimes(1),
    );
    expect(
      poolActionHarness.auth.createSandbox.mock.calls[0]?.[0],
    ).toMatchObject({ environmentId: null });
    await waitFor(() =>
      expect(poolActionHarness.directoryListeners.size).toBeGreaterThan(0),
    );

    publishSandbox(sandboxHostEntry(PERSONAL_SANDBOX_HOST_ID, null));
    await waitFor(() =>
      expect(poolActionHarness.activate).toHaveBeenCalledTimes(1),
    );
    expect(poolActionHarness.activate.mock.calls[0]?.[0].hostId).toBe(
      PERSONAL_SANDBOX_HOST_ID,
    );

    act(() =>
      useSelectionAuthorityStore.setState({
        servingPeer: { kind: "computer", hostId: PERSONAL_SANDBOX_HOST_ID },
        leases: [
          {
            hostId: PERSONAL_SANDBOX_HOST_ID,
            status: "ready",
            dead: null,
          },
        ],
      }),
    );

    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Host: none selected" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(useComposerDraftStore.getState().drafts[source.chatId]).toBe(
      originalDraft,
    );
  });

  it("keeps a known resting sandbox's Send on the pool and stages that sandbox's own host", () => {
    useSelectionAuthorityStore.setState({ servingPeer: { kind: "pool" } });
    const view = resolveChatSandbox(RESTING_CHAT, {
      reachable: false,
      ownedByViewer: true,
      environmentOwned: false,
    });
    expect(view.line).toMatchObject({ place: "footer", state: RESTING_CHAT });
    const target = wakeOf(view);
    if (target === undefined)
      throw new Error("the known configuration did not permit wake");

    const BoundRestingComposer = () => {
      const onSubmitMessage = useBoundSandboxSend({
        epicId: "epic-1",
        chatId: "chat-1",
        target,
      });
      const lower = props({
        ownerHostId: target.sandbox.hostId,
        isViewer: false,
        isCopy: false,
        canAct: true,
        readOnlyNotice: null,
        restingSandbox: target,
      });
      return (
        <ChatLowerInteractionSurfaces
          {...lower}
          composer={{ ...lower.composer, onSubmitMessage }}
        />
      );
    };

    render(<BoundRestingComposer />);

    expect(screen.getByTestId("composer-stub")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send resting message" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Host: none selected" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Send resting message" }),
    );

    const send = Object.values(usePendingSandboxSendStore.getState().sends)[0];
    expect(send).toMatchObject({
      request: { kind: "message", chatId: "chat-1", hostId: "owner-computer" },
      delivery: null,
    });
    expect(
      Object.values(useStagedSandboxStore.getState().bySurface)[0]?.target,
    ).toMatchObject({
      kind: "existing",
      hostId: "owner-computer",
      sandboxId: "sbx-resting",
      verb: "resume",
    });
  });

  it("keeps a parked chat read-only for a viewer and offers Clone agent", () => {
    const onClone = vi.fn();
    const interactionProps = props(evictedAccess(true));
    render(
      <ChatLowerInteractionSurfaces
        {...interactionProps}
        composer={{ ...interactionProps.composer, onClone }}
      />,
    );

    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(composerProps).toEqual([]);
    expect(screen.getByText("Read-only viewer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clone agent" }));
    expect(onClone).toHaveBeenCalledTimes(1);
  });

  it("keeps send enabled while a message is parked and the session cannot act", () => {
    render(
      <ChatLowerInteractionSurfaces
        {...props({
          isViewer: false,
          isCopy: false,
          canAct: false,
          readOnlyNotice: null,
          parksEvictedSend: true,
        })}
      />,
    );

    expect(composerProps.at(-1)).toEqual({ sendDisabled: false });
  });

  it("disables send while editing a queued item, even when a send is parked", () => {
    const base = props({
      isViewer: false,
      isCopy: false,
      canAct: false,
      readOnlyNotice: null,
      parksEvictedSend: true,
    });
    render(
      <ChatLowerInteractionSurfaces
        {...base}
        queue={{ ...base.queue, editingItem: EDITING_ITEM }}
      />,
    );

    expect(composerProps.at(-1)).toEqual({ sendDisabled: true });
  });

  it("keeps a viewer's read-only surface when no message is parked", () => {
    render(<ChatLowerInteractionSurfaces {...props(evictedAccess(false))} />);

    expect(screen.queryByTestId("composer-stub")).toBeNull();
    expect(screen.getByText("Read-only viewer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
  });
});
