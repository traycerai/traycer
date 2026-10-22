import { useState, type ReactElement } from "react";
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
import type {
  Chat,
  ChatEvent,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatActiveTurn,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  ChatComposer,
  type ChatComposerSubmitInput,
} from "@/components/chat/composer/chat-composer";
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
import { ChatDockCompactStripProvider } from "@/components/chat/chat-dock-compact-strip";
import { ChatDiffTargetContext } from "@/components/chat/chat-diff-target";
import { ChatLowerDock } from "@/components/chat/chat-lower-dock";
import { queueWithoutPersistedPrompts } from "@/components/chat/chat-queue-utils";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  ChatSessionMessagesSurface,
  type ChatSessionMessagesSurfaceProps,
} from "@/components/epic-canvas/renderers/chat-tile";
import { useChatDockChrome } from "@/components/epic-canvas/renderers/use-chat-dock-chrome";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import {
  SAMPLE_NO_PENDING_STOPS,
  SAMPLE_RESTORE,
  sampleNoop,
  sampleNoopAction,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import {
  createChatSessionStore,
  projectQueueWithPendingCancellations,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { queueWithDrainingPrompts } from "@/stores/chats/chat-send-state";
import { useRenderedMessages } from "@/stores/chats/rendered-messages";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * A SEND INTO A CHAT, end to end: the real chat session store, fed scripted
 * host frames, over the real `useRenderedMessages` and the tile's own
 * `ChatSessionMessagesSurface` (verb latch + `ChatMessages` list) and the real
 * `ChatLowerDock`. Nothing here decides where a prompt goes or how a working
 * row looks; the fixture only plays the host and reads.
 *
 * `window.__send` is the driver. `host.*` are the frames the host sends;
 * `send` is the person pressing Enter. `browser-tests/chat-send-owns-turn.spec.ts`
 * drives it and measures the DOM.
 */

const EPIC_ID = "epic-send";
const CHAT_ID = "chat-send";
const OWNER_ID = "owner-send";
const HOST_ID = "host-send";

const SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "claude-sonnet-4-5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

type ScenarioKind = "idle" | "background-only" | "activating" | "running";

interface SendOptions {
  readonly image: boolean;
}

interface SendDriver {
  open: (kind: ScenarioKind) => void;
  send: (text: string, options: SendOptions) => string;
  host: {
    accept: (messageId: string) => void;
    turnStarted: (messageId: string) => void;
    queueAdded: (messageId: string) => void;
    queueRemoved: () => void;
    earlierTurnEnded: () => void;
    setupCreating: (messageId: string) => void;
  };
  /** The message id of the last send the composer made, or `null`. */
  lastMessageId: () => string | null;
  ready: boolean;
}

interface ProbeWindow extends Window {
  __send?: SendDriver;
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

function liveCallbacks(): ChatStreamCallbacks {
  if (callbacks === null) throw new Error("the store has no stream yet");
  return callbacks;
}

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function promptContent(text: string, image: boolean): JsonContent {
  const paragraph: JsonContent = {
    type: "paragraph",
    content: [{ type: "text", text }],
  };
  if (!image) return { type: "doc", content: [paragraph] };
  return {
    type: "doc",
    content: [
      paragraph,
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "probe-image",
              fileName: "probe.png",
              b64content: PNG_1X1,
              hash: null,
              mimeType: "image/png",
              size: 68,
            },
          },
        ],
      },
    ],
  };
}

function earlierTurn(kind: "starting" | "running"): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId: "turn-earlier",
    status: kind,
    harnessId: "claude",
    model: "claude-sonnet-4-5",
    profileId: null,
    userMessageId: "message-earlier",
    startedAt: 100,
    updatedAt: 100,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function chatRecord(withEarlier: boolean): Chat {
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
    messages: withEarlier
      ? [
          {
            role: "user",
            messageId: "message-earlier",
            sender: { type: "user", userId: OWNER_ID },
            message: {
              kind: "user",
              content: promptContent("An earlier prompt", false),
              browserAnnotations: [],
            },
            timestamp: 50,
            sessionAnchor: null,
          },
        ]
      : [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function open(kind: ScenarioKind): void {
  const busy = kind === "activating" || kind === "running";
  let activeTurn: ChatActiveTurn | null = null;
  if (kind === "activating") activeTurn = earlierTurn("starting");
  if (kind === "running") activeTurn = earlierTurn("running");
  const cb = liveCallbacks();
  cb.onConnectionStatus("open", null, null);
  cb.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: chatRecord(busy),
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: kind === "idle" ? "idle" : "running",
      turnInProgress: busy,
      sendWouldQueue: busy,
      activeTurn,
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

function turnFor(messageId: string): ChatActiveTurn {
  return {
    ...earlierTurn("running"),
    turnId: "turn-send",
    userMessageId: messageId,
    startedAt: 251,
  };
}

function queuedItem(messageId: string, text: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: `queue-${messageId}`,
    messageId,
    message: {
      kind: "user",
      content: promptContent(text, false),
      browserAnnotations: [],
    },
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

const sentTexts = new Map<string, string>();
let lastSentMessageId: string | null = null;
let queued: ChatQueuedPromptItem[] = [];

function emitQueue(): void {
  liveCallbacks().onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: queued.length > 0 ? "running" : "idle", items: queued },
  });
}

function setupCreatingEvent(messageId: string): ChatEvent {
  return {
    eventId: "event-setup-creating",
    type: "setup.creating",
    timestamp: 300,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: {
      workspacePath: "/repo",
      branch: "feature",
      triggeringMessageId: messageId,
    },
  };
}

const driver: SendDriver = {
  ready: false,
  lastMessageId: () => lastSentMessageId,
  open,
  send: (text, options) => {
    const sent = handle.store.getState().sendMessage({
      content: promptContent(text, options.image),
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: [],
      deliveryPolicy: "auto",
      restore: {
        content: promptContent(text, options.image),
        browserAnnotations: [],
      },
    });
    if (sent === null) throw new Error("the send was refused");
    sentTexts.set(sent.messageId, text);
    return sent.messageId;
  },
  host: {
    accept: (messageId) => {
      liveCallbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: {
          role: "user",
          messageId,
          sender: { type: "user", userId: OWNER_ID },
          message: {
            kind: "user",
            content: promptContent(sentTexts.get(messageId) ?? "", false),
            browserAnnotations: [],
          },
          timestamp: 250,
          sessionAnchor: null,
        },
      });
    },
    turnStarted: (messageId) => {
      liveCallbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        runStatus: "running",
        activeTurn: turnFor(messageId),
        turnInProgress: true,
        sendWouldQueue: false,
      });
    },
    queueAdded: (messageId) => {
      queued = [
        ...queued,
        queuedItem(messageId, sentTexts.get(messageId) ?? ""),
      ];
      emitQueue();
    },
    queueRemoved: () => {
      queued = [];
      emitQueue();
    },
    earlierTurnEnded: () => {
      liveCallbacks().onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        runStatus: "running",
        activeTurn: null,
        turnInProgress: false,
        sendWouldQueue: false,
      });
    },
    setupCreating: (messageId) => {
      liveCallbacks().onEventAppended({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: setupCreatingEvent(messageId),
      });
    },
  },
};
probeWindow.__send = driver;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

/**
 * What the tile's `dispatchUserSend` does once the composer has built its
 * submit input: put it in the store as the person's own send.
 */
function submitFromComposer(input: ChatComposerSubmitInput): boolean {
  const sent = handle.store.getState().sendMessage({
    content: input.content,
    sender: { type: "user", userId: OWNER_ID },
    settings: input.settings,
    attachments: input.attachments,
    deliveryPolicy: input.deliveryPolicy,
    restore: input.restore,
  });
  if (sent === null) return false;
  sentTexts.set(sent.messageId, input.contentText);
  lastSentMessageId = sent.messageId;
  return true;
}

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
    requestId: () => `chat-send-owns-turn-${String(++requestCounter)}`,
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

/** The epic the composer reads its title and attachments from. */
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

const NO_BACKGROUND_STOPS = SAMPLE_NO_PENDING_STOPS;
const RESTORE: ChatRestoreContextValue = {
  ...SAMPLE_RESTORE,
  activeHostId: HOST_ID,
  accumulatedFileChanges: [],
};
const EMPTY_SET: ReadonlySet<string> = new Set();

export function Fixture(): ReactElement {
  const state = useStore(handle.store);
  const drillIn = useSubagentDrillIn(state.snapshotLoaded);
  const [scroll] =
    useState<ChatSessionMessagesSurfaceProps["scrollRequest"]>(null);
  const turnStatus = composerTurnStatus(state.runStatus);
  const composerStatus = resolvedTurnStatus(state, turnStatus);
  // The working row never rides the queue-drain continuity, only the composer.
  const workingRowStatus = resolvedTurnStatus(
    { ...state, queueTurnContinuity: false },
    turnStatus,
  );
  const queue = queueWithoutPersistedPrompts(
    projectQueueWithPendingCancellations(
      queueWithDrainingPrompts(state),
      state.pendingActions,
      state.acceptedActions,
    ),
    state.messages,
  );
  const queuedPromptIds = new Set(
    queueWithDrainingPrompts(state).items.flatMap((item) =>
      item.kind === "prompt" ? [item.messageId] : [],
    ),
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
      queuedPromptMessageIds: queuedPromptIds,
      withdrawnMessageId: null,
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      runStatus: workingRowStatus ?? "idle",
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
  const chrome = useChatDockChrome({
    snapshotLoaded: state.snapshotLoaded,
    chatId: CHAT_ID,
    restore: RESTORE,
    selfAgent: null,
    activeAgents: [],
    activeAgentsVisible: false,
    backgroundVisible: false,
    backgroundItems: [],
    runningManagedCommands: [],
    heldManagedCommands: [],
    backgroundFailureToken: null,
    portForwardCount: 0,
    queue,
    todo: null,
  });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas text-foreground">
      <div data-testid="probe-run-state" className="sr-only">
        {composerStatus ?? "none"}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
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
          node={{ id: CHAT_ID, instanceId: "probe-instance", name: "Chat" }}
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
          scrollRequest={scroll}
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
          composerOverlayHeight={0}
          subagentDrillIn={drillIn}
        />
      </div>
      <TabHostContext.Provider value={HOST_ID}>
        <ChatDiffTargetContext.Provider value={null}>
          <ChatDockCompactStripProvider value={chrome.strip}>
            <ChatLowerDock
              snapshotLoaded={state.snapshotLoaded}
              epicId={EPIC_ID}
              chatId={CHAT_ID}
              viewTabId="view-tab"
              selfAgent={null}
              activeAgents={[]}
              todo={null}
              restore={RESTORE}
              queue={queue}
              folded={chrome.folded}
              dockOrder={chrome.dockOrder}
              hotspots={chrome.hotspots}
              backgroundItems={[]}
              runningManagedCommandCount={0}
              heldManagedCommandCount={0}
              portForwardCount={0}
              backgroundStopPendingTaskIds={NO_BACKGROUND_STOPS}
              backgroundStopAllPending={false}
              backgroundSessionStopPending={false}
              activeTurnStatus={composerStatus}
              canAct
              queueResumeRequested={false}
              queueKeepPausedRequested={false}
              readOnly={false}
              editingQueueItemId={null}
              topSpacing="normal"
              scrollRegionMaxHeightClass="max-h-[min(24dvh,12rem)]"
              onQueuePause={() => null}
              onQueueResume={() => null}
              onQueueEdit={sampleNoop}
              onQueueCancel={sampleNoop}
              onQueueAbortSteer={sampleNoop}
              onQueueReorder={sampleNoop}
              onQueueSteerNow={sampleNoop}
              onBackgroundItemClick={sampleNoop}
              onBackgroundItemStop={sampleNoopAction}
              onBackgroundItemsStopAll={sampleNoopAction}
              onBackgroundSessionStop={sampleNoopAction}
            />
            <ChatComposer
              taskId={CHAT_ID}
              isActive
              sendDisabled={false}
              sendDisabledHint={null}
              mentionRoots={[]}
              fallbackToGlobalMentionRoots={false}
              currentEpicId={EPIC_ID}
              viewTabId="view-tab"
              settingsSeed={SETTINGS}
              fallbackSettingsSeed={SETTINGS}
              providerFallback={NO_PROVIDER_FALLBACK}
              onSubmitMessage={submitFromComposer}
              onSideChat={null}
              onSettingsChange={null}
              activeTurnStatus={composerStatus}
              steerCapable={false}
              steerProtocolSupported={false}
              autoPermissionModeProtocolSupported={null}
              getDraftBlobBridgeSupported={() => false}
              getActiveTurnForSteer={() => null}
              editingQueueItemId={null}
              onCancelQueueEdit={null}
              hasPendingApprovals={false}
              stopDisabled={false}
              onStopTurn={() => {
                handle.store.getState().stopTurn();
              }}
              workspaceControls={null}
              workspaceAvailability={{ status: "ready", disabledHint: null }}
              topSpacing="normal"
              topSlot={null}
              suggestedPrompt={undefined}
            />
          </ChatDockCompactStripProvider>
        </ChatDiffTargetContext.Provider>
      </TabHostContext.Provider>
    </div>
  );
}

driver.ready = true;
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
