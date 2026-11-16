import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { useStore } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { ChatComposer } from "@/components/chat/composer/chat-composer";
import { ComposerDropPane } from "@/components/chat/composer/composer-drop-pane";
import { NO_PROVIDER_FALLBACK } from "@/components/chat/fallback/fallback-state";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useMeasuredElementHeight } from "@/hooks/ui/use-measured-element-height";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { ChatSessionMessagesSurface } from "@/components/epic-canvas/renderers/chat-tile";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import {
  SAMPLE_RESTORE,
  sampleNoop,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useRenderedMessages } from "@/stores/chats/rendered-messages";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A CHAT PANE with a neighbour beside it. The pane is the production
 * `ComposerDropPane` the chat tile renders, with the tile's own attribute and
 * classes: the transcript is the real `ChatSessionMessagesSurface` over the
 * real chat session store, and the real `ChatComposer` sits in the absolutely
 * positioned lower-surfaces layer over it. The fixture stands in for what needs
 * a live epic and host (the tile's view model); it decides nothing about drops.
 *
 * `window.__paneDrop` is the driver; `browser-tests/chat-pane-file-drop.spec.ts`
 * sends real drag events at the page and reads the DOM.
 */

const EPIC_ID = "epic-drop";
const CHAT_ID = "chat-drop";
const OWNER_ID = "owner-drop";
const HOST_ID = "host-drop";

const SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

interface PaneDropDriver {
  /** Delivers the chat's first snapshot, which mounts the transcript and the composer. */
  open: () => void;
  /** `display: none` on the pane's host, as a one-tile layout does when another pane opens. */
  setPaneHidden: (hidden: boolean) => void;
  /** Drops the neighbour's own handler has taken. */
  neighbourDrops: () => number;
  ready: boolean;
}

interface ProbeWindow extends Window {
  __paneDrop?: PaneDropDriver;
}
const probeWindow: ProbeWindow = window;

let callbacks: ChatStreamCallbacks | null = null;
const handle = createChatSessionStore({
  environment: CHAT_STORE_TEST_ENVIRONMENT,
  hostId: HOST_ID,
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  userId: OWNER_ID,
  onAuthError: null,
  onProviderAuthError: null,
  wakeTransport: null,
  streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
  streamClientFactory: (_epicId, _chatId, next) => {
    callbacks = next;
    return {
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => false,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    };
  },
});

function promptContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const PROMPT_COUNT = 14;

function chatRecord(): Chat {
  return {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: HOST_ID,
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: Array.from({ length: PROMPT_COUNT }, (_, index) => ({
      role: "user" as const,
      messageId: `message-${String(index)}`,
      sender: { type: "user" as const, userId: OWNER_ID },
      message: {
        kind: "user" as const,
        content: promptContent(`Earlier prompt number ${String(index + 1)}`),
        browserAnnotations: [],
      },
      timestamp: 50 + index,
      sessionAnchor: null,
    })),
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function openSnapshot(): void {
  if (callbacks === null) throw new Error("the store has no stream yet");
  callbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: chatRecord(),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      turnInProgress: false,
      sendWouldQueue: false,
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
    },
  });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});
let requestCounter = 0;
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `chat-pane-file-drop-${String(++requestCounter)}`,
    handlers: {},
  });

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const EPIC_SESSION = openStoreForTest({
  epicId: EPIC_ID,
  userId: null,
  factories: {
    streamClientFactory: noopEpicStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});
getOpenEpicRegistry().acquire(EPIC_ID, () => EPIC_SESSION);

const RESTORE: ChatRestoreContextValue = {
  ...SAMPLE_RESTORE,
  activeHostId: HOST_ID,
  accumulatedFileChanges: [],
};
const EMPTY_SET: ReadonlySet<string> = new Set();

let setHiddenState: ((hidden: boolean) => void) | null = null;
let neighbourDropCount = 0;

export function Fixture(): ReactElement {
  const [hidden, setHidden] = useState(false);
  const [drops, setDrops] = useState(0);
  useEffect(() => {
    setHiddenState = setHidden;
  }, []);
  const state = useStore(handle.store);
  const drillIn = useSubagentDrillIn(state.snapshotLoaded);
  const { setElement: setLowerSurfacesElement, height: lowerSurfacesHeight } =
    useMeasuredElementHeight();
  const composerStatus = resolvedTurnStatus(
    state,
    composerTurnStatus(state.runStatus),
  );
  const rendered = useRenderedMessages(
    {
      messages: state.messages,
      events: state.events,
      rowContext: state.transcriptRowContext,
      setupCardWindows: state.transcriptDerived?.setupCardWindows ?? [],
      pendingUserMessages: state.pendingUserMessages,
      pendingTurn: state.pendingTurn,
      turnObservedAt: state.turnObservedAt,
      queuedPromptMessageIds: EMPTY_SET,
      withdrawnMessageId: null,
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      runStatus: composerStatus ?? "idle",
      chatWorking: state.runStatus !== "idle",
      epicId: EPIC_ID,
      ownerId: CHAT_ID,
      ownerKind: "chat",
      viewTabId: "view-tab",
    },
    {
      resolveUserSenderLabel: () => "You",
      resolveUserSenderAvatarUrl: () => null,
      resolveAgentSenderDisplay: () => ({
        senderLabel: "Claude",
        providerLabel: "Claude Code",
        modelLabel: "Sonnet",
      }),
      resolveAgentReasoningLabel: () => null,
      resolveAgentServiceTierLabel: () => null,
      contentBlocksPreview: () => "",
    },
  );
  return (
    <>
      <div
        data-testid="pane-host"
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas text-foreground"
        style={{ display: hidden ? "none" : undefined }}
      >
        <ComposerDropPane
          data-chat-pane=""
          className="relative flex min-h-0 flex-1 flex-col [container-type:size]"
        >
          <>
            <ChatSessionMessagesSurface
              snapshotLoaded={state.snapshotLoaded}
              thinkingTokensSource={handle.store}
              connectionStatus="open"
              fatalClose={null}
              preSnapshotRetries={null}
              preSnapshotReloadStartedAt={null}
              onRetry={sampleNoop}
              preContent={null}
              restoreContext={RESTORE}
              node={{
                id: CHAT_ID,
                instanceId: "probe-instance",
                name: "Chat",
              }}
              taskTitle="Chat"
              epicId={EPIC_ID}
              viewTabId="view-tab"
              tabHostId={HOST_ID}
              workspaceRoots={[]}
              messages={rendered}
              activeTurnId={state.activeTurn?.turnId ?? null}
              transcriptWindow={null}
              onVisibleOrdinalRangeChange={sampleNoop}
              onFindReadOrdinalChange={sampleNoop}
              baselineEpoch={state.transcriptBaselineEpoch}
              hydrationSequence={state.transcriptHydrationSequence}
              coldRewrittenMessageIds={EMPTY_SET}
              backgroundItems={state.backgroundItems}
              scrollRequest={null}
              onScrollRequestSettled={sampleNoop}
              surfaceVisible
              systemOverlayActive={false}
              getMessageActions={() => null}
              nextStepActions={{ canSend: false, onSend: () => false }}
              planActions={{
                epicId: EPIC_ID,
                chatId: CHAT_ID,
                canSend: false,
                pending: false,
                onImplement: () => false,
              }}
              composerOverlayHeight={lowerSurfacesHeight}
              subagentDrillIn={drillIn}
            />
            {state.snapshotLoaded ? (
              <div
                ref={setLowerSurfacesElement}
                className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
                data-chat-lower-surfaces-overlay=""
              >
                <div className="pointer-events-none">
                  <ChatComposer
                    taskId={CHAT_ID}
                    isActive
                    sendDisabled={false}
                    sendDisabledHint={null}
                    mentionRoots={[]}
                    runWorkingDirectory={null}
                    fallbackToGlobalMentionRoots={false}
                    currentEpicId={EPIC_ID}
                    viewTabId="view-tab"
                    settingsSeed={SETTINGS}
                    fallbackSettingsSeed={SETTINGS}
                    providerFallback={NO_PROVIDER_FALLBACK}
                    onSubmitMessage={() => false}
                    onSideChat={null}
                    onSettingsChange={null}
                    activeTurnStatus={composerStatus}
                    steerCapable={false}
                    steerProtocolSupported={false}
                    autoPermissionModeProtocolSupported={null}
                    ultracodeProtocolSupported={false}
                    getDraftBlobBridgeSupported={() => false}
                    getActiveTurnForSteer={() => null}
                    editingQueueItemId={null}
                    onCancelQueueEdit={null}
                    hasPendingApprovals={false}
                    stopDisabled={false}
                    onStopTurn={sampleNoop}
                    workspaceControls={null}
                    workspaceAvailability={{
                      status: "ready",
                      disabledHint: null,
                    }}
                    topSpacing="normal"
                    topSlot={null}
                    suggestedPrompt={undefined}
                    restingSandbox={null}
                  />
                </div>
              </div>
            ) : null}
          </>
        </ComposerDropPane>
      </div>
      {/* A neighbouring pane with drop handling of its own, as the terminal tile has. */}
      <div
        data-testid="neighbour-drop"
        data-drops={drops}
        className="flex w-1/4 shrink-0 items-center justify-center border-l border-border bg-card text-ui-sm"
        onDragEnter={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          neighbourDropCount += 1;
          setDrops(neighbourDropCount);
        }}
      >
        Neighbour
      </div>
    </>
  );
}

const driver: PaneDropDriver = {
  ready: false,
  open: openSnapshot,
  setPaneHidden: (hidden) => {
    if (setHiddenState === null) throw new Error("the fixture is not mounted");
    setHiddenState(hidden);
  },
  neighbourDrops: () => neighbourDropCount,
};
probeWindow.__paneDrop = driver;

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              <EpicSessionContext value={EPIC_SESSION}>
                <TabHostContext.Provider value={HOST_ID}>
                  <Fixture />
                </TabHostContext.Provider>
              </EpicSessionContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => null,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(container).render(<RouterProvider router={router} />);
driver.ready = true;
