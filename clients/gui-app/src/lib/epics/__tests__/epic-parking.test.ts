import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import {
  __resetCrossWindowEpicVisibilityForTests,
  installCrossWindowEpicVisibility,
} from "@/lib/epics/cross-window-epic-visibility";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
  __setHostAgentActivityHealthForTests,
} from "@/stores/agent-activity-store";
import { __resetEpicDraftGuardForTests } from "@/lib/epics/epic-draft-guard";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type PendingChatAction,
  type SentChatMessageAction,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  ChatQueuedPromptItem,
  ChatQueueState,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  Chat,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  getTileSurfaceEnvironment,
  publishTileSurfaceEnvironment,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import {
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import type { EpicCanvasState, EpicNodeRef } from "@/stores/epics/canvas/types";
import type {
  DesktopEpicVisibilityEntry,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

// ── Shared test helpers ─────────────────────────────────────────────────────
//
// Parking's `entries` map is keyed off the epic's OPEN TAB in the canvas
// store (`useEpicCanvasStore`'s `openTabOrder`), not off a mounted surface -
// see the doc comment atop `epic-parking.ts` for why the key changed. Every
// test below registers an epic with parking by opening a real tab for it and
// forgets it by closing that tab, mirroring production exactly instead of
// standing in for it.

function resetCanvasStore(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function openEpicTab(tabId: string, epicId: string): void {
  useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, epicId);
  // `epic-parking-open-tabs.ts`'s module-scope `useEpicCanvasStore.subscribe`
  // re-derives parking's entries synchronously on every `setState`, so this
  // call is usually redundant. It is made explicit here anyway, matching the
  // test seam's stated purpose, and is a guaranteed no-op when the
  // subscription has already done the work.
  __syncEpicParkingOpenTabsForTests();
}

function closeEpicTab(tabId: string): void {
  useEpicCanvasStore.getState().closeTab(tabId);
  __syncEpicParkingOpenTabsForTests();
}

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildParkableEpicHandle(epicId: string, dirty: boolean) {
  const base = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopEpicStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  let disposed = false;
  const realDispose = base.dispose.bind(base);
  if (dirty) {
    base.store.setState({ isDirty: true });
  }
  return {
    handle: {
      ...base,
      get doc() {
        return base.doc;
      },
      get awareness() {
        return base.awareness;
      },
      get store() {
        return base.store;
      },
      dispose: () => {
        disposed = true;
        realDispose();
      },
      hotArtifactRoomIdsForTests: () => [],
      ...INERT_ROOT_STATE_PORT,
    },
    get disposed() {
      return disposed;
    },
  };
}

function markAgentWorking(epicId: string, agentId: string): void {
  publishAgentActivity([
    {
      hostId: "host-parking-tests",
      byEpic: { [epicId]: { working: [agentId], turn: [agentId] } },
    },
  ]);
}

// ── Chat-plane fixtures for the canPark/park chat-gating pins ──────────────
//
// `unsettledWorkForEpic` is exercised through the REAL production wiring
// here (`chat-session-registry.ts`'s module-scope `setEpicChatWorkProbe` +
// `registry.subscribe(() => retryDeferredEpicParks())`), not a fake probe -
// this file already imports that module for `__getChatSessionRegistryForTests`
// / `disposeAllChatSessions`, which is what installs it at import time.

function noopChatStreamClientFactory() {
  return {
    sendAction: () => undefined,
    sameTurnSteeringProtocolSupported: () => true,
    requestTranscriptRange: () => undefined,
    requestResnapshot: () => undefined,
    close: () => undefined,
  };
}

function buildTestChatHandle(epicId: string, chatId: string, hostId: string) {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId,
    epicId,
    chatId,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    // Required since #1815's syncing bar; this fixture never redials.
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: noopChatStreamClientFactory,
  });
}

/** Minimal valid `PendingChatAction`, matching `chat-queue-reconciler.test.ts`'s own fixture. */
function pendingChatActionFixture(clientActionId: string): PendingChatAction {
  return {
    clientActionId,
    action: "send",
    queueItemId: null,
    checkpointId: null,
    interviewBlockId: null,
    interviewDeliveryRetry: null,
    messageId: "msg-1",
    restore: {
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        ],
      },
      browserAnnotations: [],
    },
    sender: { type: "user", userId: "user-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5-codex",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "epic",
      profileId: null,
    },
    restoreWorktreeIntent: null,
    displayWorktreeIntent: null,
    messageConfirmedByHost: false,
    accountContext: null,
    deliveryPolicy: null,
    createdAt: 1000,
    connectionEpoch: 0,
  };
}

/** The `activeTurn` shape `hasActiveChatWork` reads, matching the chats' own fixture. */
function markChatActiveTurn(handle: ChatSessionStoreHandle): void {
  handle.store.setState({
    runStatus: "running",
    activeTurn: {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 1,
      updatedAt: 1,
      reasoningEffort: null,
      serviceTier: null,
    },
  });
}

// ── Chat-plane fixtures for the finer-grained `hasUnsettledChatWork` states ─
//
// Pins 6-9 below (transcript-record-fingerprint-memo) drive the REAL chat
// session store through the same host-frame callbacks a live
// `chat.subscribe` connection would deliver - `onActionAck`, `onMessageAccepted`,
// `onRestoreStarted`/`onRestoreCompleted` - rather than poking store fields
// directly, so each state is reached exactly as `hasUnsettledChatWork` sees it
// reached in production.

const SEND_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const SEND_SENDER: UserMessageSender = { type: "user", userId: "user-1" };

const SEND_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

/**
 * Like {@link buildTestChatHandle}, but captures the outbound frames and the
 * host callbacks so a test can drive real `actionAck` / `messageAccepted` /
 * `restoreStarted` / `restoreCompleted` frames back at the store.
 */
function buildTestChatHandleWithFrames(
  epicId: string,
  chatId: string,
  hostId: string,
): {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  readonly callbacks: () => ChatStreamCallbacks;
} {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId,
    epicId,
    chatId,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

/**
 * `sendMessage` refuses to dispatch (`canSendAction`) until a snapshot has
 * reported an OPEN connection and owner `canAct` access - the same gate a
 * real `chat.subscribe` reconnect clears before the composer can send.
 */
function emitOwnerChatSnapshot(
  callbacks: () => ChatStreamCallbacks,
  epicId: string,
  chatId: string,
  hostId: string,
): void {
  callbacks().onConnectionStatus("open", null);
  const chat: Chat = {
    id: chatId,
    parentId: null,
    userId: "user-1",
    hostId,
    title: "Test Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
  callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId,
    chatId,
    snapshot: {
      chat,
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
    },
  });
}

function sendChatTestMessage(
  handle: ChatSessionStoreHandle,
): SentChatMessageAction {
  const sent = handle.store.getState().sendMessage({
    content: SEND_CONTENT,
    sender: SEND_SENDER,
    settings: SEND_SETTINGS,
    attachments: buildAttachmentsFromJSONContent(SEND_CONTENT),
    deliveryPolicy: "auto",
    restore: { content: SEND_CONTENT, browserAnnotations: [] },
  });
  if (sent === null) throw new Error("Expected a sent action");
  return sent;
}

function lastOwnerActionFrame(
  frames: readonly ChatSubscribeClientFrame[],
): Exclude<ChatSubscribeClientFrame, { readonly kind: "ping" }> {
  const frame = frames.at(-1);
  if (frame === undefined || frame.kind === "ping") {
    throw new Error("Expected an owner action frame");
  }
  return frame;
}

/**
 * The two ack helpers take an options object rather than a positional list.
 * `rejectLastChatAction` needs one field more than `acceptLastChatAction` and
 * tripped `max-params` at five; giving only that one a bag would leave two
 * sibling helpers with different call shapes, which reads as an accident.
 */
interface LastChatActionAck {
  readonly frames: readonly ChatSubscribeClientFrame[];
  readonly callbacks: () => ChatStreamCallbacks;
  readonly epicId: string;
  readonly chatId: string;
}

function rejectLastChatAction(
  ack: LastChatActionAck & { readonly reason: string },
): string {
  const { frames, callbacks, epicId, chatId, reason } = ack;
  const frame = lastOwnerActionFrame(frames);
  callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId,
    chatId,
    clientActionId: frame.clientActionId,
    action: frame.kind,
    status: "rejected",
    reason,
    code: null,
    backgroundStopTaskIds: [],
  });
  return frame.clientActionId;
}

function acceptLastChatAction(ack: LastChatActionAck): string {
  const { frames, callbacks, epicId, chatId } = ack;
  const frame = lastOwnerActionFrame(frames);
  callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId,
    chatId,
    clientActionId: frame.clientActionId,
    action: frame.kind,
    status: "accepted",
    reason: null,
    code: null,
    backgroundStopTaskIds: [],
  });
  return frame.clientActionId;
}

function confirmChatMessageAccepted(
  callbacks: () => ChatStreamCallbacks,
  epicId: string,
  chatId: string,
  messageId: string,
): void {
  callbacks().onMessageAccepted({
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId,
    chatId,
    message: {
      role: "user",
      messageId,
      sender: SEND_SENDER,
      message: {
        kind: "user",
        content: SEND_CONTENT,
        browserAnnotations: [],
      },
      timestamp: 4,
      sessionAnchor: null,
    },
  });
}

function startChatRestore(
  callbacks: () => ChatStreamCallbacks,
  epicId: string,
  chatId: string,
  checkpointId: string,
): void {
  callbacks().onRestoreStarted({
    kind: "restoreStarted",
    hasBinaryPayload: false,
    epicId,
    chatId,
    checkpointId,
    restoringUserId: "user-1",
    restoringHostId: "host-1",
    startedAt: 2,
  });
}

function completeChatRestore(
  callbacks: () => ChatStreamCallbacks,
  epicId: string,
  chatId: string,
  checkpointId: string,
): void {
  callbacks().onRestoreCompleted({
    kind: "restoreCompleted",
    hasBinaryPayload: false,
    epicId,
    chatId,
    checkpointId,
    finishedAt: 3,
    results: [],
  });
}

// ── Chat-plane fixtures for the P1/P2 regression pins (transcript-record-
// fingerprint-memo) ─────────────────────────────────────────────────────────
//
// These drive `pruneAcceptedActions`, `acceptedActionIsUnsettled` and the
// queue reconciler's own queueCancel retirement through the same real host
// frames as pins 6-9 above - a live `queueChanged`, a reconnect `snapshot`
// with a caller-chosen queue, and the real `pauseQueue`/`queueCancel`/
// `restoreCheckpoint` action creators - never a `setState` poke.

/**
 * Like {@link emitOwnerChatSnapshot}, but lets the caller choose the
 * snapshot's `queue` - used to settle an accepted `queueCancel` through the
 * RECONNECT door instead of a live `queueChanged`, which is the door a
 * cancel accepted just before a reconnect used to never reach.
 */
interface ReconnectChatSnapshotWithQueue {
  readonly callbacks: () => ChatStreamCallbacks;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly queue: ChatQueueState;
}

function emitOwnerChatSnapshotWithQueue(
  input: ReconnectChatSnapshotWithQueue,
): void {
  const { callbacks, epicId, chatId, hostId, queue } = input;
  callbacks().onConnectionStatus("open", null);
  const chat: Chat = {
    id: chatId,
    parentId: null,
    userId: "user-1",
    hostId,
    title: "Test Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    messages: [],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
  callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId,
    chatId,
    snapshot: {
      chat,
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue,
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
    },
  });
}

/** A live `queueChanged` frame carrying an arbitrary authoritative queue. */
function emitChatQueueChanged(
  callbacks: () => ChatStreamCallbacks,
  epicId: string,
  chatId: string,
  queue: ChatQueueState,
): void {
  callbacks().onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId,
    chatId,
    queue,
  });
}

/** A queued prompt row, standing in for a `queueCancel` accepted action's target. */
function queuedPromptItemFixture(
  queueItemId: string,
  messageId: string,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId,
    message: { kind: "user", content: SEND_CONTENT, browserAnnotations: [] },
    sender: SEND_SENDER,
    settings: SEND_SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

/**
 * Send, accept and transcript-confirm a filler message - a settled `send`
 * accepted action with nothing left for P1/P2 to hold. Used only to push the
 * 64-record cap past its limit with same-rank (`send`) competition, so
 * eviction has to choose by recency rather than by kind.
 */
function sendAndConfirmFillerMessage(
  chat: {
    readonly handle: ChatSessionStoreHandle;
    readonly sent: ChatSubscribeClientFrame[];
    readonly callbacks: () => ChatStreamCallbacks;
  },
  epicId: string,
  chatId: string,
): void {
  const filler = sendChatTestMessage(chat.handle);
  acceptLastChatAction({
    frames: chat.sent,
    callbacks: chat.callbacks,
    epicId,
    chatId,
  });
  confirmChatMessageAccepted(chat.callbacks, epicId, chatId, filler.messageId);
}

describe("epic-parking - visibility roll-up (C6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("never parks an epic that is visible in a second window", () => {
    const EPIC = "epic-park-second-window-a";
    const TAB = "tab-park-second-window-a";
    const viewA = "view-a";
    const viewB = "view-b";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, viewA, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      setEpicSurfaceVisibility(EPIC, viewB, true);
      vi.advanceTimersByTime(60_000 + PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      setEpicSurfaceVisibility(EPIC, viewB, false);
      setEpicSurfaceVisibility(EPIC, viewA, true);
      setEpicSurfaceVisibility(EPIC, viewB, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("re-bases the window on a backward clock step instead of restarting it forever", () => {
    const EPIC = "epic-park-backward-clock";
    const TAB = "tab-park-backward-clock";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-clock", false);
      vi.advanceTimersByTime(60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      vi.setSystemTime(Date.now() - 60 * 60_000);

      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("parks once the LAST visible window of the epic goes hidden", () => {
    const EPIC = "epic-park-second-window-b";
    const TAB = "tab-park-second-window-b";
    const viewA = "view-a-last";
    const viewB = "view-b-last";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, viewA, true);
      setEpicSurfaceVisibility(EPIC, viewB, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      setEpicSurfaceVisibility(EPIC, viewA, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1);
      expect(isEpicParked(EPIC)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

describe("epic-parking - eligibility (C1, prune's own gates)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAgentActivity();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("does not park a tab with unsynced edits", () => {
    const EPIC = "epic-park-dirty";
    const TAB = "tab-park-dirty";
    const dirty = buildParkableEpicHandle(EPIC, true);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => dirty.handle);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-dirty", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(dirty.disposed).toBe(false);
      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("does not park a tab with an active agent turn", () => {
    const EPIC = "epic-park-busy";
    const TAB = "tab-park-busy";
    const busy = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => busy.handle);
    markAgentWorking(EPIC, "agent-1");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-busy", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(busy.disposed).toBe(false);
      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("parks a formerly-dirty tab once its edits settle, without a fresh hidden window", () => {
    const EPIC = "epic-park-settles";
    const TAB = "tab-park-settles";
    const th = buildParkableEpicHandle(EPIC, true);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => th.handle);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-settles", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      th.handle.store.setState({
        ...th.handle.store.getState(),
        isDirty: false,
      });

      expect(isEpicParked(EPIC)).toBe(true);
      expect(th.disposed).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

// ── B1: the retention-pool / warm-session key ───────────────────────────────
//
// The fixup's whole reason to exist: a tab pushed out of the retention pool
// (`TopLevelTabHost`'s `retainedTopLevelSurfaces` cap) is hidden by
// definition, and its provider's `releaseMounted` drops demand to zero while
// its session stays WARM with `epic.subscribe` still open. The old
// mounted-surface key had no entry for that population at all. These pins
// build that exact shape - `acquireMounted` then `releaseMounted`, with the
// canvas tab left open throughout - and prove the OPEN-TAB key reaches it.

function chatRef(instanceId: string): EpicNodeRef {
  return {
    id: instanceId,
    instanceId,
    type: "chat",
    name: `Chat ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function canvasWithChat(instanceId: string, paneId: string): EpicCanvasState {
  return {
    root: pane(paneId, [instanceId]),
    activePaneId: paneId,
    tilesByInstanceId: { [instanceId]: chatRef(instanceId) },
    sizesByGroupId: {},
  };
}

function seedSingleTabStrip(
  refs: ReadonlyArray<TabRef>,
  activeRef: TabRef,
): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    })),
    activeItemId: `tab:${activeRef.kind}:${activeRef.id}`,
    stripOrder: refs,
  }));
}

function resetTabsStore(): void {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

describe("epic-parking - B1: retention-pool / warm-session key", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    resetTileSurfaceMembershipForTesting();
    resetTabsStore();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("parks a warm (unmounted, undisposed) session: releases the epic session, its chat lease and its hosted-surface membership", () => {
    const EPIC = "epic-warm-park-positive";
    const TAB = "tab-warm-park-positive";
    const CHAT_ID = "chat-warm-park-positive";
    const HOST_ID = "host-warm-park-positive";
    const INSTANCE_ID = "chat-inst-warm-park-positive";

    // Canvas + tab-strip setup so the epic also holds a hosted-surface
    // membership record to release.
    useEpicCanvasStore.setState({
      tabsById: { [TAB]: { tabId: TAB, epicId: EPIC, name: "Warm park" } },
      canvasByTabId: { [TAB]: canvasWithChat(INSTANCE_ID, "p1") },
      openTabOrder: [TAB],
      activeTabId: TAB,
    });
    seedSingleTabStrip([{ kind: "epic", id: TAB }], { kind: "epic", id: TAB });
    __syncEpicParkingOpenTabsForTests();
    expect(getTileSurfaceMembership().has(INSTANCE_ID)).toBe(true);
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment(INSTANCE_ID, {}),
    );
    expect(getTileSurfaceEnvironment(INSTANCE_ID)).not.toBeNull();

    // Mounted, then unmounted: the surface went away (retention-pool
    // eviction) but the session stays warm - `acquireMounted` +
    // `releaseMounted`, never `release`.
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );
    __getOpenEpicRegistryForTests().releaseMounted(EPIC);

    // Positive pre-assertion: the warm state genuinely exists before the
    // clock advances at all, so a park succeeding below is evidence of a
    // release rather than of `park()`'s "no entry -> true" default.
    expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);

    const chatHandle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: HOST_ID,
      epicId: EPIC,
      chatId: CHAT_ID,
      userId: null,
      onAuthError: null,
      onProviderAuthError: null,
      // Required since #1815's syncing bar; this fixture never redials.
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      }),
    });
    const chatRegistry = __getChatSessionRegistryForTests();
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "warm-park-scope",
      },
      () => chatHandle,
    );
    expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();

    vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);

    expect(isEpicParked(EPIC)).toBe(true);
    // The session is released: disposed, and gone from the registry.
    expect(epicHandle.disposed).toBe(true);
    expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();
    // The chat lease is gone - `chat-session-registry.ts`'s module-scope
    // `subscribeEpicParking` listener called `disposeForEpic`.
    expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    // The hosted-surface membership record is dropped, not merely
    // unpresented.
    expect(getTileSurfaceMembership().has(INSTANCE_ID)).toBe(false);
    expect(getTileSurfaceEnvironment(INSTANCE_ID)).toBeNull();
  });

  it("at 4:59 the warm session is untouched, and a remount reuses the SAME handle", () => {
    const EPIC = "epic-warm-park-negative";
    const TAB = "tab-warm-park-negative";
    openEpicTab(TAB, EPIC);
    try {
      const epicHandle = buildParkableEpicHandle(EPIC, false);
      __getOpenEpicRegistryForTests().acquireMounted(
        EPIC,
        () => epicHandle.handle,
      );
      __getOpenEpicRegistryForTests().releaseMounted(EPIC);

      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);

      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);

      // Synchronous, right after advancing - not behind an await.
      expect(isEpicParked(EPIC)).toBe(false);
      const otherHandle = buildParkableEpicHandle(`${EPIC}-other`, false);
      const remounted = __getOpenEpicRegistryForTests().acquireMounted(
        EPIC,
        () => otherHandle.handle,
      );
      expect(remounted).toBe(epicHandle.handle);
      // The factory that would have built a different handle was never
      // adopted - proof this was the warm handle, not a rebuild.
      expect(otherHandle.disposed).toBe(false);
      expect(epicHandle.disposed).toBe(false);
    } finally {
      __getOpenEpicRegistryForTests().releaseMounted(EPIC);
      closeEpicTab(TAB);
    }
  });
});

// ── B2: cross-window visibility ─────────────────────────────────────────────
//
// `epicVisibility` carries a THIRD method, `snapshot()`, alongside `report`
// and `onChange`: main replays its per-window map on the SYNC `windowId`
// read the preload performs while constructing the bridge, which has already
// happened by the time `installCrossWindowEpicVisibility` runs and subscribes
// via `onChange` - so the install effect seeds itself from an explicit
// `snapshot()` call instead, discarded if a live `onChange` fan-out has
// already landed by the time it resolves (`lifecycle.fanOutSeen`).
//
// Every test's `snapshot()` resolves as a real Promise, so every test body is
// `async` and flushes it with `await vi.advanceTimersByTimeAsync(0)` right
// after install, before driving `onChange` or advancing the park window - the
// same reason production reads `snapshot()` as a Promise in the first place.

function fakeEpicVisibilityChannel(
  snapshotEntries: readonly DesktopEpicVisibilityEntry[] = [],
): {
  readonly channel: NonNullable<DesktopWindowsBridge["epicVisibility"]>;
  readonly emit: (entries: readonly DesktopEpicVisibilityEntry[]) => void;
  /** Every roll-up this window pushed to main, in order. */
  readonly reports: ReadonlyArray<readonly string[]>;
} {
  let handler:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  const reports: Array<readonly string[]> = [];
  return {
    reports,
    channel: {
      report: (epicIds) => {
        reports.push([...epicIds].sort());
        return Promise.resolve();
      },
      snapshot: () => Promise.resolve(snapshotEntries),
      onChange: (nextHandler) => {
        handler = nextHandler;
        return {
          dispose: () => {
            handler = null;
          },
        };
      },
    },
    emit: (entries) => handler?.(entries),
  };
}

/**
 * A channel whose `snapshot()` only resolves when `resolveSnapshot` is
 * called - for the "a live `onChange` pre-empts a slower `snapshot`" race,
 * driven explicitly rather than hoping real timing falls out right.
 */
function deferredEpicVisibilityChannel(): {
  readonly channel: NonNullable<DesktopWindowsBridge["epicVisibility"]>;
  readonly emit: (entries: readonly DesktopEpicVisibilityEntry[]) => void;
  readonly resolveSnapshot: (
    entries: readonly DesktopEpicVisibilityEntry[],
  ) => void;
} {
  let handler:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  let resolveDeferred:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  const snapshotPromise = new Promise<readonly DesktopEpicVisibilityEntry[]>(
    (resolve) => {
      resolveDeferred = resolve;
    },
  );
  return {
    channel: {
      report: () => Promise.resolve(),
      snapshot: () => snapshotPromise,
      onChange: (nextHandler) => {
        handler = nextHandler;
        return {
          dispose: () => {
            handler = null;
          },
        };
      },
    },
    emit: (entries) => handler?.(entries),
    resolveSnapshot: (entries) => resolveDeferred?.(entries),
  };
}

function fakeDesktopWindowsBridge(
  windowId: string,
  epicVisibility: DesktopWindowsBridge["epicVisibility"],
): DesktopWindowsBridge {
  return {
    windowId,
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({ result: "moved" as const, windowId: "window-other" }),
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    epicVisibility,
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve({ outcome: "accepted" as const }),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

describe("epic-parking - B2: cross-window visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("does not park an epic another window is showing", async () => {
    const EPIC = "epic-cross-window-visible-elsewhere";
    const TAB = "tab-cross-window-visible-elsewhere";
    const { channel, emit } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // A foreign window (not "window-a") reports this epic visible.
      emit([{ windowId: "window-b", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  // Single-process bound, stated plainly: this exercises window A's own read
  // of an EMPTY foreign-visibility map - the only shape a real second window
  // reporting itself hidden can actually produce over this channel, since a
  // hidden window reports no epics at all rather than a negative entry.
  it("parks an epic that is hidden everywhere the cross-window map can prove", async () => {
    const EPIC = "epic-cross-window-hidden-both";
    const TAB = "tab-cross-window-hidden-both";
    const { channel } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // No entries reported for this epic from anywhere.
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  // The OUTBOUND leg. Everything else in this describe drives the channel's
  // inbound half, so cutting `subscribeEpicSurfaceVisibility(report)` out of
  // `installCrossWindowEpicVisibility` reddened nothing - and that cut is
  // exactly what makes every OTHER window blind to this one, which is the
  // failure the channel exists to prevent. Nobody can pin it from the far
  // side, because there is only one renderer in a test.
  it("pushes this window's own roll-up at install and on every local visibility edge", async () => {
    const EPIC_A = "epic-cross-window-report-a";
    const EPIC_B = "epic-cross-window-report-b";
    const { channel, reports } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      // The install-time push: a restored window mounts its surfaces before
      // this runs, so the set it is already showing arrives on no edge.
      // Asserted by COUNT, and the epics by membership below, because
      // `surface-host-opened-tab.ts`'s visible-view map is module state with
      // no reset - an earlier test in this file can leave a view behind.
      expect(reports).toHaveLength(1);
      expect(reports.at(-1)).not.toContain(EPIC_A);

      setEpicSurfaceVisibility(EPIC_A, "view-report-a", true);
      expect(reports).toHaveLength(2);
      expect(reports.at(-1)).toContain(EPIC_A);

      setEpicSurfaceVisibility(EPIC_B, "view-report-b", true);
      expect(reports).toHaveLength(3);
      expect(reports.at(-1)).toContain(EPIC_A);
      expect(reports.at(-1)).toContain(EPIC_B);

      // Hiding is an edge like any other - main must be told the set SHRANK,
      // or the other windows keep reading this epic as shown here for ever.
      setEpicSurfaceVisibility(EPIC_A, "view-report-a", false);
      expect(reports).toHaveLength(4);
      expect(reports.at(-1)).not.toContain(EPIC_A);
      expect(reports.at(-1)).toContain(EPIC_B);
    } finally {
      setEpicSurfaceVisibility(EPIC_B, "view-report-b", false);
      uninstall();
    }
  });

  it("does not count window A's own reported row as foreign visibility", async () => {
    const EPIC = "epic-cross-window-own-row";
    const TAB = "tab-cross-window-own-row";
    const { channel, emit } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // Only window A's OWN id names the epic - `foreignVisibleEpics` must
      // exclude it, so this must NOT suppress the park.
      emit([{ windowId: "window-a", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  it("degrades gracefully with no epicVisibility channel (older preload / browser): parking still runs off local visibility alone", async () => {
    const EPIC = "epic-cross-window-no-channel";
    const TAB = "tab-cross-window-no-channel";
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", undefined),
    );
    openEpicTab(TAB, EPIC);
    try {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  it("seeds the cross-window answer from snapshot() before any onChange fan-out arrives", async () => {
    const EPIC = "epic-cross-window-snapshot-seed";
    const TAB = "tab-cross-window-snapshot-seed";
    // snapshot() resolves immediately, naming a foreign window already
    // showing this epic - no onChange call ever fires in this test.
    const { channel } = fakeEpicVisibilityChannel([
      { windowId: "window-b", epicIds: [EPIC] },
    ]);
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    // Flush the snapshot's `.then` before opening the tab (hidden-from-birth
    // arms immediately), so the seeded answer is in place from the start.
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  it("discards a snapshot() that resolves after a live onChange has already landed", async () => {
    const EPIC = "epic-cross-window-stale-snapshot";
    const TAB = "tab-cross-window-stale-snapshot";
    const { channel, emit, resolveSnapshot } = deferredEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    openEpicTab(TAB, EPIC);
    try {
      // The live fan-out lands FIRST, with no window showing the epic.
      emit([]);
      // The slower snapshot resolves AFTER it, with a STALE map that would
      // otherwise regress the answer back to "visible elsewhere".
      resolveSnapshot([{ windowId: "window-b", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(0);

      // The live answer must win: the epic is not visible anywhere, so it
      // still parks on schedule.
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });
});

// ── transcript-record-fingerprint-memo Fix 2: window (document) visibility
// joins the parking signal ───────────────────────────────────────────────────
//
// `isEpicVisibleAnywhere` (`lib/epics/epic-parking.ts`) now reads
// `isDocumentVisible() && isEpicSurfaceVisible(epicId)` for THIS window's arm,
// ORed with the cross-window arm unchanged. Before this, a minimized window or
// a backgrounded browser tab left its front pane reporting itself visible
// forever - `activity.visible` is pane PLACEMENT and cannot see the window -
// so the park clock never started. These pins drive the real
// `document.visibilityState` + a real `visibilitychange` dispatch
// (`lib/dom/document-visibility.ts` is not mocked), exactly the path
// production takes.

function setDocumentVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("epic-parking - document (window) visibility (transcript-record-fingerprint-memo Fix 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    resetCanvasStore();
    vi.useRealTimers();
    setDocumentVisibilityState("visible");
  });

  it("a pane placed but the document hidden parks after PARK_HIDDEN_EPIC_AFTER_MS", () => {
    const EPIC = "epic-park-document-hidden";
    const TAB = "tab-park-document-hidden";
    setDocumentVisibilityState("hidden");
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-doc-hidden", true);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("does not park while both the pane and the document are visible", () => {
    const EPIC = "epic-no-park-document-visible";
    const TAB = "tab-no-park-document-visible";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-doc-visible", true);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("hiding the document then showing it again before the mark cancels the park, and the clock restarts cleanly on the next hide", () => {
    const EPIC = "epic-park-document-cancel-restart";
    const TAB = "tab-park-document-cancel-restart";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-doc-cancel", true);

      setDocumentVisibilityState("hidden");
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);
      expect(isEpicParked(EPIC)).toBe(false);

      // Visible again before the mark - must cancel the pending window, not
      // merely pause it.
      setDocumentVisibilityState("visible");
      vi.advanceTimersByTime(60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      // The next hide starts a FRESH window. If the cancel above had not
      // actually happened (only paused), this would already be past the
      // original deadline and park on the very next tick instead of needing
      // the full window again.
      setDocumentVisibilityState("hidden");
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);
      expect(isEpicParked(EPIC)).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

describe("epic-parking - document hidden but the epic is visible in another window (C6 preservation)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
    resetCanvasStore();
    vi.useRealTimers();
    setDocumentVisibilityState("visible");
  });

  // The failure message states the regression by name: `isEpicVisibleAnywhere`
  // ORs the cross-window arm with `isDocumentVisible() && isEpicSurfaceVisible`
  // rather than gating the whole expression on this window's document, exactly
  // so a hidden window cannot un-surface an epic a SECOND window is showing.
  it("does not park an epic another window is showing, even though this window's document is hidden (folding documentVisible across the whole OR would park a still-visible-elsewhere epic)", async () => {
    const EPIC = "epic-doc-hidden-visible-elsewhere";
    const TAB = "tab-doc-hidden-visible-elsewhere";
    setDocumentVisibilityState("hidden");
    const { channel, emit } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // A foreign window reports this epic visible, while THIS window's own
      // document is hidden and it has placed no pane of its own.
      emit([{ windowId: "window-b", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });
});

// ── Codex review pins 1-4: canPark/park now consult the chat plane, and a
// missing OpenEpicSessionRegistry entry no longer short-circuits to "yes" ──
//
// Before this fix, `canPark` read only the epic store (`holdsNothingToLose`)
// and the agent-activity plane (`epicIsBusy`); `park`/`canPark` both answered
// `true` the instant an epic had no live open-epic session, skipping every
// gate. Parking then force-disposes every chat under the epic through
// `ChatSessionRegistry.disposeForEpic`, so either gap destroyed a chat
// holding unacknowledged work. These pins drive the REAL production wiring
// (`setEpicChatWorkProbe` / `unsettledWorkForEpic`, installed at import time
// by `lib/registries/chat-session-registry.ts`, which this file already
// imports for `__getChatSessionRegistryForTests`), not a fake probe.
describe("epic-parking - chat plane gating & missing-entry safeguard (Codex review pins 1-4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
    // These pins are about the CHAT plane's gate specifically; a stray held
    // draft from another suite (or a future third `canPark` gate ahead of the
    // chat check) must not be what refuses the park here.
    __resetEpicDraftGuardForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    __resetEpicDraftGuardForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  // Pin 1, positive arm: a chat's `pendingActions` entry blocks the park.
  // THE ARM THAT MATTERS is the chat surviving - the bug destroyed it via
  // `disposeForEpic` before this line was ever consulted.
  it("does not park while a chat holds a pending action, and the chat survives (pin 1)", () => {
    const EPIC = "epic-park-chat-pending-action-pin1";
    const TAB = "tab-park-chat-pending-action-pin1";
    const CHAT_ID = "chat-pending-action-pin1";
    const HOST_ID = "test-host";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "pin1-scope",
      },
      () => chatHandle,
    );
    chatHandle.store.setState({
      pendingActions: { "action-1": pendingChatActionFixture("action-1") },
    });

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin1", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 1, control arm: the same shape with NO pending action parks
  // normally, proving the refusal above is about the pending action and not
  // some unrelated property of the fixture.
  it("parks normally once a chat has no pending action (pin 1 control)", () => {
    const EPIC = "epic-park-chat-no-pending-action-pin1";
    const TAB = "tab-park-chat-no-pending-action-pin1";
    const CHAT_ID = "chat-no-pending-action-pin1";
    const HOST_ID = "test-host";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "pin1-control-scope",
      },
      () => chatHandle,
    );

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin1-control", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 2: `hasActiveChatWork` states (activeTurn / runStatus / pendingApprovals
  // / pendingFileEditApprovals / pendingInterviews) gate the park too, not only
  // `pendingActions` - pinning that `unsettledWorkForEpic` covers this axis of
  // `hasUnsettledChatWork` too, alongside `pendingActions`,
  // `failedSendRestoration` and an unconfirmed accepted send or unfinished
  // checkpoint restore (pins 6-8 below).
  it("does not park while a chat has an active turn (hasActiveChatWork), not only a pending action (pin 2)", () => {
    const EPIC = "epic-park-chat-active-turn-pin2";
    const TAB = "tab-park-chat-active-turn-pin2";
    const CHAT_ID = "chat-active-turn-pin2";
    const HOST_ID = "test-host";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "pin2-scope",
      },
      () => chatHandle,
    );
    markChatActiveTurn(chatHandle);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin2", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 3a: a missing OpenEpicSessionRegistry entry used to answer `true`
  // immediately, skipping the chat check wholesale. A live chat holding work
  // must still refuse the park, and survive, with NO epic session at all.
  it("refuses a park with no epic session entry while a chat still holds work, and the chat survives (pin 3a)", () => {
    const EPIC = "epic-park-missing-entry-chat-pin3a";
    const TAB = "tab-park-missing-entry-chat-pin3a";
    const CHAT_ID = "chat-missing-entry-pin3a";
    const HOST_ID = "host-missing-entry-pin3a";
    const chatRegistry = __getChatSessionRegistryForTests();

    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "pin3a-scope",
      },
      () => chatHandle,
    );
    chatHandle.store.setState({
      pendingActions: { "action-1": pendingChatActionFixture("action-1") },
    });

    openEpicTab(TAB, EPIC);
    try {
      // Sanity: genuinely no open-epic session for this epic.
      expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();

      setEpicSurfaceVisibility(EPIC, "view-pin3a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 3b: the SAME missing-entry shape, but the chat itself has already
  // settled - the refusal here has to come from the activity plane failing
  // CLOSED (`epicIsBusyAcrossHosts` reading `agentActivityPlaneAnswers()` as
  // false) over the chat's own host, which only reaches the verdict through
  // `hostIds` because there is no session to supply one.
  it("refuses a park with no epic session entry while the activity plane cannot vouch, even though the chat has settled (pin 3b)", () => {
    __resetAgentActivityStoreForTests();
    const EPIC = "epic-park-missing-entry-blind-plane-pin3b";
    const TAB = "tab-park-missing-entry-blind-plane-pin3b";
    const CHAT_ID = "chat-missing-entry-blind-plane-pin3b";
    const HOST_ID = "host-missing-entry-blind-plane-pin3b";
    const chatRegistry = __getChatSessionRegistryForTests();

    // Settled by construction - no pending action, no active turn.
    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "pin3b-scope",
      },
      () => chatHandle,
    );

    openEpicTab(TAB, EPIC);
    try {
      expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();

      setEpicSurfaceVisibility(EPIC, "view-pin3b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 3d: pin 3b's refusal has to LIFT when the plane recovers.
  //
  // The activity plane is the third input to `canPark` that settles on its own,
  // and the only one with no other route back into the decider:
  // `waitForEligibility` watches the open-epic registry, whose eligibility key
  // is emitted per SESSION, so an epic with no session entry has nothing that
  // would ever announce the plane reopening. Failing closed while the plane is
  // blind is deliberate; staying deferred forever afterwards is the bug.
  //
  // Falsified by cutting `subscribeAgentActivity(...)` in `epic-parking.ts`:
  // before this pin existed that cut reddened NOTHING across 538 tests.
  it("retries a park deferred by a blind activity plane once the plane answers again, with no visibility edge and no timer (pin 3d)", () => {
    __resetAgentActivityStoreForTests();
    const EPIC = "epic-park-plane-recovers-pin3d";
    const TAB = "tab-park-plane-recovers-pin3d";
    const CHAT_ID = "chat-plane-recovers-pin3d";
    const HOST_ID = "host-plane-recovers-pin3d";
    const chatRegistry = __getChatSessionRegistryForTests();

    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin3d" },
      () => chatHandle,
    );

    openEpicTab(TAB, EPIC);
    try {
      expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();

      setEpicSurfaceVisibility(EPIC, "view-pin3d", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      // Refused, and the window has already elapsed - no timer will fire again.
      expect(isEpicParked(EPIC)).toBe(false);

      // The plane comes back. Not a visibility edge, not a fresh timer, and
      // not a chat-registry membership change.
      __setAgentActivityPlaneAnsweringForTests();

      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 3c: with NEITHER a session NOR any chats, there is genuinely nothing
  // to lose or release - the one case that still short-circuits. This is the
  // arm that would catch a guard broad enough to never let anything park
  // again (e.g. deleting the `hostIds.size === 0` branch entirely).
  it("parks with no session and no chats at all (pin 3c)", () => {
    const EPIC = "epic-park-missing-entry-empty-pin3c";
    const TAB = "tab-park-missing-entry-empty-pin3c";

    openEpicTab(TAB, EPIC);
    try {
      expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();

      setEpicSurfaceVisibility(EPIC, "view-pin3c", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 4: a chat served from a host OUTSIDE the activity plane's narrow
  // union blocks the park even though the epic's OWN session host is
  // covered - the reason `unsettledWorkForEpic` returns `hostIds` at all,
  // and the case a per-session-only coverage check would miss entirely.
  it("blocks a park when a chat's host lies outside the activity plane's narrow union, even though the epic's own session host is covered (pin 4)", () => {
    __resetAgentActivityStoreForTests();
    // Narrow union: covers ONLY the epic session's own host ("test-host",
    // `openStoreForTest`'s fixed default), not the chat's host below.
    __setHostAgentActivityHealthForTests("test-host", {
      connectionStatus: "open",
      servedBy: "local",
      stateFrameSeenThisEpoch: true,
      cloudSyncStatus: null,
    });
    const EPIC = "epic-park-cross-host-pin4";
    const TAB = "tab-park-cross-host-pin4";
    const CHAT_ID = "chat-cross-host-pin4";
    const CHAT_HOST = "host-chat-uncovered-pin4";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    // Settled: only the HOST is the point of this pin, not chat work.
    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, CHAT_HOST);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: CHAT_HOST,
        scopeKey: "pin4-scope",
      },
      () => chatHandle,
    );

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin4", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, CHAT_HOST)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });
});

// ── Codex review pin 5: the deferred-park retry actually fires ─────────────
//
// `waitForEligibility`'s watch listens to the OPEN-EPIC registry, which is
// silent for an epic with no session entry - exactly the population whose
// park was refused for CHAT work. `retryDeferredEpicParks`, wired from
// `lib/registries/chat-session-registry.ts`'s `registry.subscribe(() => ...)`,
// is the only thing that ever re-attempts that park. Falsify by cutting that
// one wiring line; predicted result: this test reddens, because nothing then
// calls `retryDeferredEpicParks` when the chat plane changes and the epic
// stays parked=false forever.
describe("epic-parking - retryDeferredEpicParks wiring (Codex review pin 5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
    __resetEpicDraftGuardForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    __resetEpicDraftGuardForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("retries and succeeds once the chat settles, driven by the chat registry's own emission - no session, no new hide edge, no timer (pin 5)", () => {
    const EPIC = "epic-park-retry-pin5";
    const TAB = "tab-park-retry-pin5";
    const CHAT_ID = "chat-park-retry-pin5";
    const HOST_ID = "host-park-retry-pin5";
    const chatRegistry = __getChatSessionRegistryForTests();

    const chatHandle = buildTestChatHandle(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "pin5-scope",
      },
      () => chatHandle,
    );
    chatHandle.store.setState({
      pendingActions: { "action-1": pendingChatActionFixture("action-1") },
    });

    openEpicTab(TAB, EPIC);
    try {
      // No session entry at all - the exact case `waitForEligibility`'s watch
      // on the open-epic registry can never see settle.
      expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();

      setEpicSurfaceVisibility(EPIC, "view-pin5", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);
      expect(isEpicParked(EPIC)).toBe(false);

      // The chat settles - a STORE write, not a visibility edge, not a fresh
      // timer, and not a membership change either.
      //
      // This is the whole pin. `registry.subscribe` relays only the shared
      // session registry's membership and demand events, so this write emits
      // nothing there; the park is re-attempted because
      // `chat-session-registry.ts` watches the live handles' STORES. An
      // earlier version of this test asserted the opposite - that settling
      // alone left the epic unparked until some unrelated acquire shook it
      // loose - which pinned the defect as if it were the contract.
      chatHandle.store.setState({ pendingActions: {} });

      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

// ── transcript-record-fingerprint-memo: `hasUnsettledChatWork` reads an
// ACKNOWLEDGEMENT as a SETTLEMENT ──────────────────────────────────────────
//
// Before this fix, `hasUnsettledChatWork` fell straight through to
// `pendingActions`, which empties the moment the host says it RECEIVED a
// frame - the start of the interesting part for a send, not the end. Three
// states were live but invisible to it:
//
//   1. `failedSendRestoration !== null` - a rejected send's prompt, the only
//      copy until a driver writes it into the composer draft store.
//   2. an accepted-but-unconfirmed send - `acceptedActions[id].confirmedByHost
//      === false`, its restore content still only local.
//   3. an unfinished checkpoint restore - `restore.kind === "in-flight" |
//      "progressing"`.
//
// Each pin below asserts the CORRECT contract - work of this shape blocks a
// park, and settling it (never merely acknowledging it) lifts the block -
// never the defect it replaced. Falsifying by reverting
// `hasUnsettledChatWork` to the pre-fix two-line body (`hasActiveChatWork` +
// a bare `pendingActions` length check) should redden every POSITIVE arm
// (6a, 7a, 8a) - none of the three states touches `pendingActions`, so the
// old predicate reads all of them as settled - while every NEGATIVE arm (6b,
// 7b, 8b) stays green, since the old predicate already allowed parking once
// `pendingActions` was empty.
describe("epic-parking - fine-grained chat settlement states (pins 6-9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
    __resetEpicDraftGuardForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    __resetEpicDraftGuardForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  // Pin 6a, positive: a rejected send leaves its prompt in
  // `failedSendRestoration`, driven through a real `actionAck({status:
  // "rejected"})` frame - the same frame a live host sends. The chat must
  // survive the refused park.
  it("does not park while a chat holds a failed-send restoration slot, and the chat survives (pin 6a)", () => {
    const EPIC = "epic-park-chat-failed-send-restoration-pin6a";
    const TAB = "tab-park-chat-failed-send-restoration-pin6a";
    const CHAT_ID = "chat-failed-send-restoration-pin6a";
    const HOST_ID = "host-failed-send-restoration-pin6a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin6a" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    sendChatTestMessage(chat.handle);
    rejectLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
      reason: "Message was not accepted.",
    });
    expect(chat.handle.store.getState().failedSendRestoration).not.toBeNull();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin6a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 6b, negative: the SAME slot, consumed through the real
  // `ackFailedSendRestoration` action (what a mounted
  // `useInitialChatHandoffDriver` calls once the prompt lands in the
  // composer). This is the arm that proves the fix is not a blanket "never
  // park a chat epic": settling the state, not merely observing it once, is
  // what lifts the refusal.
  it("parks once the failed-send restoration slot is consumed (pin 6b)", () => {
    const EPIC = "epic-park-chat-failed-send-settled-pin6b";
    const TAB = "tab-park-chat-failed-send-settled-pin6b";
    const CHAT_ID = "chat-failed-send-settled-pin6b";
    const HOST_ID = "host-failed-send-settled-pin6b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin6b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    sendChatTestMessage(chat.handle);
    const clientActionId = rejectLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
      reason: "Message was not accepted.",
    });
    expect(chat.handle.store.getState().failedSendRestoration).not.toBeNull();
    chat.handle.store.getState().ackFailedSendRestoration(clientActionId);
    // Synchronous, right after the ack - the slot is settled before any
    // clock advances.
    expect(chat.handle.store.getState().failedSendRestoration).toBeNull();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin6b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 7a, positive: the host ACKED the send (`actionAck({status:
  // "accepted"})`) but has not yet confirmed it landed in the transcript or
  // queue - `confirmedByHost` is still `false`. The ack alone must not read
  // as settlement.
  it("does not park while a chat holds an accepted-but-unconfirmed send, and the chat survives (pin 7a)", () => {
    const EPIC = "epic-park-chat-unconfirmed-send-pin7a";
    const TAB = "tab-park-chat-unconfirmed-send-pin7a";
    const CHAT_ID = "chat-unconfirmed-send-pin7a";
    const HOST_ID = "host-unconfirmed-send-pin7a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin7a" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    sendChatTestMessage(chat.handle);
    const clientActionId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(false);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin7a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 7b, negative: the host then reports the message in the transcript
  // (`messageAccepted`), which is what actually flips `confirmedByHost`.
  // `withoutSettledAcceptedActions` retains CONFIRMED entries as history, so
  // this is also the arm proving the fix scoped its `acceptedActions` loop to
  // unconfirmed entries only - an epic that ever sent a message must still be
  // parkable afterwards.
  it("parks once the accepted send is confirmed by the host (pin 7b)", () => {
    const EPIC = "epic-park-chat-confirmed-send-pin7b";
    const TAB = "tab-park-chat-confirmed-send-pin7b";
    const CHAT_ID = "chat-confirmed-send-pin7b";
    const HOST_ID = "host-confirmed-send-pin7b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin7b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    const sent = sendChatTestMessage(chat.handle);
    const clientActionId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(false);
    confirmChatMessageAccepted(chat.callbacks, EPIC, CHAT_ID, sent.messageId);
    // Synchronous, right after the frame - no await needed.
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(true);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin7b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 8a, positive: a checkpoint restore still running
  // (`restore.kind === "in-flight"`), driven by a real `restoreStarted` frame.
  it("does not park while a chat has an unfinished checkpoint restore, and the chat survives (pin 8a)", () => {
    const EPIC = "epic-park-chat-restore-in-flight-pin8a";
    const TAB = "tab-park-chat-restore-in-flight-pin8a";
    const CHAT_ID = "chat-restore-in-flight-pin8a";
    const HOST_ID = "host-restore-in-flight-pin8a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin8a" },
      () => chat.handle,
    );
    startChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8a");
    expect(chat.handle.store.getState().restore?.kind).toBe("in-flight");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin8a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 8b, negative: the restore reaches `completed`, driven by a real
  // `restoreCompleted` frame. `completed` persists in the slot for toast/dialog
  // consumers, so it must read as finished, not merely "an entry exists".
  //
  // Extended (transcript-record-fingerprint-memo, P2): the original version of
  // this pin only drove `restoreStarted`/`restoreCompleted` frames - it never
  // dispatched a real `restoreCheckpoint` action, so it never had the
  // ACCEPTED record `acceptedActionIsUnsettled`'s `restoreCheckpoint` arm is
  // about. Now it does: the action is dispatched and ACKed first (an accepted
  // record with `confirmedByHost: false` forever, since that field is a
  // send-only fact), which must hold the park on its own before the restore
  // even starts, and the record is still retained - not pruned away - when
  // completion finally parks despite it.
  it("parks once the checkpoint restore completes (pin 8b)", () => {
    const EPIC = "epic-park-chat-restore-completed-pin8b";
    const TAB = "tab-park-chat-restore-completed-pin8b";
    const CHAT_ID = "chat-restore-completed-pin8b";
    const HOST_ID = "host-restore-completed-pin8b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin8b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);

    // A REAL `restoreCheckpoint` action, dispatched and ACKed - the accepted
    // record P2 is about.
    const restoreClientActionId = chat.handle.store
      .getState()
      .restoreCheckpoint("checkpoint-pin8b", false);
    if (restoreClientActionId === null) {
      throw new Error("Expected a restoreCheckpoint action");
    }
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(acceptedId).toBe(restoreClientActionId);
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId]?.action,
    ).toBe("restoreCheckpoint");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin8b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);
      // Accepted, but the restore slot is still `null` -
      // `acceptedActionIsUnsettled`'s `restoreCheckpoint` arm holds until the
      // restore actually starts.
      expect(isEpicParked(EPIC)).toBe(false);

      startChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8b");
      expect(chat.handle.store.getState().restore?.kind).toBe("in-flight");
      // The accepted record retires the moment the restore STARTS: from here
      // on the slot is the authority for this checkpoint, and a record left
      // behind would read unsettled again once a later restore's slot
      // replaced this one (pin 8c). Retired by `restoreStarted`, not by the
      // retention window.
      expect(
        chat.handle.store.getState().acceptedActions[acceptedId],
      ).toBeUndefined();
      // The in-flight slot holds on its own (`hasUnsettledChatWork`).
      expect(isEpicParked(EPIC)).toBe(false);
      completeChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8b");
      // Synchronous, right after the frame.
      expect(chat.handle.store.getState().restore?.kind).toBe("completed");

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 8c (CodeRabbit on 343f6cc0b9): a `completed` slot PERSISTS for toast
  // and dialog consumers, so with checkpoint A completed, a restore of B
  // accepted afterwards used to read A's slot as its own settlement and park
  // before B's `restoreStarted` arrived. The arm now matches the slot's
  // checkpoint id against the action's. Both arms in one instance: B's ack
  // holds against A's completed slot; B's own completion releases.
  it("holds a restore of checkpoint B accepted after checkpoint A completed, until B's own restore starts and completes (pin 8c)", () => {
    const EPIC = "epic-park-chat-restore-second-checkpoint-pin8c";
    const TAB = "tab-park-chat-restore-second-checkpoint-pin8c";
    const CHAT_ID = "chat-restore-second-checkpoint-pin8c";
    const HOST_ID = "host-restore-second-checkpoint-pin8c";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );
    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin8c" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);

    // Checkpoint A: dispatched, accepted, started, completed. Its slot stays.
    const restoreA = chat.handle.store
      .getState()
      .restoreCheckpoint("checkpoint-pin8c-a", false);
    if (restoreA === null) throw new Error("Expected restore A");
    acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    startChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8c-a");
    completeChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8c-a");
    expect(chat.handle.store.getState().restore).toMatchObject({
      kind: "completed",
      checkpointId: "checkpoint-pin8c-a",
    });

    // Checkpoint B: dispatched and accepted while A's completed slot persists.
    const restoreB = chat.handle.store
      .getState()
      .restoreCheckpoint("checkpoint-pin8c-b", false);
    if (restoreB === null) throw new Error("Expected restore B");
    const acceptedB = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(acceptedB).toBe(restoreB);
    expect(
      chat.handle.store.getState().acceptedActions[acceptedB]?.checkpointId,
    ).toBe("checkpoint-pin8c-b");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin8c", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      // A's completed slot is not B's settlement.
      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);

      startChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8c-b");
      expect(isEpicParked(EPIC)).toBe(false);
      completeChatRestore(chat.callbacks, EPIC, CHAT_ID, "checkpoint-pin8c-b");
      expect(chat.handle.store.getState().restore).toMatchObject({
        kind: "completed",
        checkpointId: "checkpoint-pin8c-b",
      });
      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 9, integrated: the settlement of a NON-`pendingActions` state also
  // RETRIES the deferred park - the same wiring pin 5 pins for
  // `pendingActions`, exercised here for `failedSendRestoration` with no epic
  // session entry at all, so the only route back to `canPark` is
  // `chat-session-registry.ts`'s store-watcher calling
  // `retryDeferredEpicParks()` on the settling write.
  it("retries and succeeds once a failed-send restoration slot settles, driven by the chat registry's own emission - no session, no new hide edge, no timer (pin 9)", () => {
    const EPIC = "epic-park-retry-failed-send-pin9";
    const TAB = "tab-park-retry-failed-send-pin9";
    const CHAT_ID = "chat-park-retry-failed-send-pin9";
    const HOST_ID = "host-park-retry-failed-send-pin9";
    const chatRegistry = __getChatSessionRegistryForTests();

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin9" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    sendChatTestMessage(chat.handle);
    const clientActionId = rejectLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
      reason: "Message was not accepted.",
    });
    expect(chat.handle.store.getState().failedSendRestoration).not.toBeNull();

    openEpicTab(TAB, EPIC);
    try {
      // No epic session entry at all - the exact case `waitForEligibility`'s
      // watch on the open-epic registry can never see settle.
      expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();

      setEpicSurfaceVisibility(EPIC, "view-pin9", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);
      expect(isEpicParked(EPIC)).toBe(false);

      // The slot settles through the real store action - not a visibility
      // edge, not a fresh timer, and not a chat-registry membership change.
      chat.handle.store.getState().ackFailedSendRestoration(clientActionId);

      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

describe("epic-parking - P1/P2 regression pins: history pruning is not settlement, and confirmedByHost is a send-only fact (transcript-record-fingerprint-memo)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
    __resetEpicDraftGuardForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    __resetEpicDraftGuardForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  // Pin 10a, positive (P1 - age eviction). An unconfirmed accepted send
  // survives past the 5-minute retention window once a frame actually RUNS
  // pruning - an empty same-connection `queueChanged`, the reviewer's exact
  // repro. `acceptedActionHoldsUnrecoveredSend` is what keeps it out of the
  // prunable set; without it the record would be gone and nothing would hold
  // the park.
  it("does not evict an unconfirmed accepted send by AGE alone, and the chat survives (pin 10a / P1 age)", () => {
    const EPIC = "epic-park-chat-send-age-retention-pin10a";
    const TAB = "tab-park-chat-send-age-retention-pin10a";
    const CHAT_ID = "chat-send-age-retention-pin10a";
    const HOST_ID = "host-send-age-retention-pin10a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin10a" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    sendChatTestMessage(chat.handle);
    const clientActionId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(false);

    // Past the 5-minute retention window `pruneAcceptedActions` reads, then a
    // frame that actually runs pruning.
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "idle",
      items: [],
    });
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId],
    ).not.toBeUndefined();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin10a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 10b, negative: the SAME age pressure, but the send is confirmed
  // first. Proves the fix is not "never prune, never park" - once the host
  // confirms, the record is no longer lifecycle-locked and the epic parks
  // exactly as it did before this record ever existed.
  it("parks once the previously-retained send is confirmed, under the same age pressure (pin 10b)", () => {
    const EPIC = "epic-park-chat-send-age-confirmed-pin10b";
    const TAB = "tab-park-chat-send-age-confirmed-pin10b";
    const CHAT_ID = "chat-send-age-confirmed-pin10b";
    const HOST_ID = "host-send-age-confirmed-pin10b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin10b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    const sent = sendChatTestMessage(chat.handle);
    const clientActionId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(false);

    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    confirmChatMessageAccepted(chat.callbacks, EPIC, CHAT_ID, sent.messageId);
    // Synchronous, right after the frame.
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(true);
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "idle",
      items: [],
    });

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin10b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 11a, positive (P1 - count eviction). Push more than the 64-record cap
  // through with same-rank ("send"), strictly more recent, CONFIRMED filler
  // actions - an unlocked scan would sort the unconfirmed target out as the
  // oldest same-rank entry, so its survival here is the lock, not luck of the
  // sort.
  it("does not evict an unconfirmed accepted send by the 64-record CAP, and the chat survives (pin 11a / P1 cap)", () => {
    const EPIC = "epic-park-chat-send-cap-retention-pin11a";
    const TAB = "tab-park-chat-send-cap-retention-pin11a";
    const CHAT_ID = "chat-send-cap-retention-pin11a";
    const HOST_ID = "host-send-cap-retention-pin11a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin11a" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    sendChatTestMessage(chat.handle);
    const clientActionId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(false);

    for (let i = 0; i < 70; i += 1) {
      vi.advanceTimersByTime(1);
      sendAndConfirmFillerMessage(chat, EPIC, CHAT_ID);
    }
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId],
    ).not.toBeUndefined();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin11a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 11b, negative: the SAME cap pressure, but the send is confirmed
  // first - proves the lock lifts on confirmation even under heavy unrelated
  // traffic, not just when the chat is otherwise quiet.
  it("parks once the previously-retained send is confirmed, under the same cap pressure (pin 11b)", () => {
    const EPIC = "epic-park-chat-send-cap-confirmed-pin11b";
    const TAB = "tab-park-chat-send-cap-confirmed-pin11b";
    const CHAT_ID = "chat-send-cap-confirmed-pin11b";
    const HOST_ID = "host-send-cap-confirmed-pin11b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin11b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    const sent = sendChatTestMessage(chat.handle);
    const clientActionId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    confirmChatMessageAccepted(chat.callbacks, EPIC, CHAT_ID, sent.messageId);
    expect(
      chat.handle.store.getState().acceptedActions[clientActionId]
        ?.confirmedByHost,
    ).toBe(true);

    for (let i = 0; i < 70; i += 1) {
      vi.advanceTimersByTime(1);
      sendAndConfirmFillerMessage(chat, EPIC, CHAT_ID);
    }

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin11b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 12a, positive (P2 - pauseQueue is not a send fact). Accepted, but the
  // authoritative queue has not reached `paused` yet - `confirmedByHost` for
  // this record is `false` and never becomes anything else, so only reading
  // the LIVE queue can tell held from settled.
  it("does not park while a chat holds an accepted pauseQueue the authoritative queue has not caught up to, and the chat survives (pin 12a)", () => {
    const EPIC = "epic-park-chat-pause-queue-unsettled-pin12a";
    const TAB = "tab-park-chat-pause-queue-unsettled-pin12a";
    const CHAT_ID = "chat-pause-queue-unsettled-pin12a";
    const HOST_ID = "host-pause-queue-unsettled-pin12a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin12a" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    chat.handle.store.getState().pauseQueue();
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId]?.action,
    ).toBe("pauseQueue");
    expect(chat.handle.store.getState().queue.status).not.toBe("paused");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin12a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 12b, negative: a live `queueChanged` reports the queue actually
  // `paused`. The old `confirmedByHost` scan could never see this - a
  // `pauseQueue` record never gains that flag - so a session that ever paused
  // its queue would never park again.
  //
  // The settling frame fires BEFORE the hidden-window advance below, not
  // after: `pruneAcceptedActions`'s 5-minute retention window and
  // `PARK_HIDDEN_EPIC_AFTER_MS` are the same constant, so a `queueChanged`
  // dispatched only after that advance would age-evict this unlocked record
  // by the CAP/retention path and settle the test for the wrong reason -
  // indistinguishable from `acceptedActionIsUnsettled` ever running at all.
  // Settling first and then advancing with no further frame keeps the record
  // present and unpruned, so what actually parks it is legible.
  it("parks once a live queueChanged reports the queue actually paused (pin 12b)", () => {
    const EPIC = "epic-park-chat-pause-queue-settled-pin12b";
    const TAB = "tab-park-chat-pause-queue-settled-pin12b";
    const CHAT_ID = "chat-pause-queue-settled-pin12b";
    const HOST_ID = "host-pause-queue-settled-pin12b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin12b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    chat.handle.store.getState().pauseQueue();
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    // DELIBERATELY before `openEpicTab`/the hidden-window advance below - do
    // not move this after it. See the block comment above the `it(...)`: this
    // frame and that advance both cross the SAME five-minute mark
    // (`PARK_HIDDEN_EPIC_AFTER_MS` === the retention window
    // `pruneAcceptedActions` reads), so settling after the advance would
    // age-evict this unlocked record and park the epic for the wrong reason -
    // a test that passes whether or not `acceptedActionIsUnsettled` ever runs.
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "paused",
      items: [],
    });
    expect(chat.handle.store.getState().queue.status).toBe("paused");
    // The settling frame also RETIRES the record
    // (`withoutSettledAcceptedQueueStatusActions`): a pause that has landed
    // has nothing left to hold, and a record left behind would read unsettled
    // again the moment the queue was resumed by a later action (pin 12c).
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId],
    ).toBeUndefined();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin12b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 12c (CodeRabbit on 343f6cc0b9): a pause that SETTLED must not come
  // back as a veto when the queue is later resumed. Judged from live state
  // alone, a retained `pauseQueue` record reads unsettled again the moment
  // the status is no longer `paused`, which held the epic resident until the
  // retention window happened to prune it. The record now retires when the
  // pause lands, so the later resume finds nothing to hold on.
  it("parks after a settled pause is followed by the host resuming the queue - the retired pause record is not a veto (pin 12c)", () => {
    const EPIC = "epic-park-chat-pause-then-resumed-pin12c";
    const TAB = "tab-park-chat-pause-then-resumed-pin12c";
    const CHAT_ID = "chat-pause-then-resumed-pin12c";
    const HOST_ID = "host-pause-then-resumed-pin12c";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );
    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin12c" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    chat.handle.store.getState().pauseQueue();
    acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    // The pause lands, then the host resumes the queue (a resume from another
    // client, say). Both frames BEFORE the hidden-window advance, for the same
    // retention-window reason pin 12b spells out.
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "paused",
      items: [],
    });
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "running",
      items: [],
    });
    expect(chat.handle.store.getState().queue.status).toBe("running");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin12c", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 13a, positive (P2 - queueCancel is not a send fact either). Accepted,
  // and a live `queueChanged` still carries the target row - the cancel has
  // not actually landed yet.
  it("does not park while an accepted queueCancel's target row is still in the authoritative queue, and the chat survives (pin 13a)", () => {
    const EPIC = "epic-park-chat-queue-cancel-unsettled-pin13a";
    const TAB = "tab-park-chat-queue-cancel-unsettled-pin13a";
    const CHAT_ID = "chat-queue-cancel-unsettled-pin13a";
    const HOST_ID = "host-queue-cancel-unsettled-pin13a";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin13a" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    chat.handle.store.getState().queueCancel("queue-item-pin13a");
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId]?.queueItemId,
    ).toBe("queue-item-pin13a");
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "idle",
      items: [queuedPromptItemFixture("queue-item-pin13a", "msg-pin13a")],
    });
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId],
    ).not.toBeUndefined();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin13a", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(epicHandle.disposed).toBe(false);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 13b, negative: a later `queueChanged` reports the target row gone -
  // both the pre-existing `withoutResolvedAcceptedQueueCancellations` sweep
  // and `acceptedActionIsUnsettled`'s own `queueCancel` arm agree it is
  // settled, and the record is retired.
  it("parks once a live queueChanged shows the queueCancel target gone (pin 13b)", () => {
    const EPIC = "epic-park-chat-queue-cancel-settled-pin13b";
    const TAB = "tab-park-chat-queue-cancel-settled-pin13b";
    const CHAT_ID = "chat-queue-cancel-settled-pin13b";
    const HOST_ID = "host-queue-cancel-settled-pin13b";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin13b" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    chat.handle.store.getState().queueCancel("queue-item-pin13b");
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "idle",
      items: [queuedPromptItemFixture("queue-item-pin13b", "msg-pin13b")],
    });

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin13b", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);
      expect(isEpicParked(EPIC)).toBe(false);

      emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
        status: "idle",
        items: [],
      });
      expect(
        chat.handle.store.getState().acceptedActions[acceptedId],
      ).toBeUndefined();

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 14, both arms (P2 - the reconnect door): the same accepted
  // queueCancel, held while a live `queueChanged` still shows its target, then
  // settled by a RECONNECT SNAPSHOT - not a `queueChanged` - whose queue no
  // longer holds the row. Before this round's fix a cancel accepted just
  // before a reconnect survived every later snapshot, because the retirement
  // sweep ran only on `queueChanged` and the confirmedByHost scan could never
  // see a queueCancel settle either; this is the door that used to be
  // unreachable.
  it("does not park while an accepted queueCancel's target survives, then parks once a RECONNECT SNAPSHOT shows it gone (pin 14)", () => {
    const EPIC = "epic-park-chat-queue-cancel-snapshot-pin14";
    const TAB = "tab-park-chat-queue-cancel-snapshot-pin14";
    const CHAT_ID = "chat-queue-cancel-snapshot-pin14";
    const HOST_ID = "host-queue-cancel-snapshot-pin14";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin14" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    chat.handle.store.getState().queueCancel("queue-item-pin14");
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    emitChatQueueChanged(chat.callbacks, EPIC, CHAT_ID, {
      status: "idle",
      items: [queuedPromptItemFixture("queue-item-pin14", "msg-pin14")],
    });
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId],
    ).not.toBeUndefined();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin14", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);
      expect(isEpicParked(EPIC)).toBe(false);

      // Settle through a RECONNECT SNAPSHOT, not a live queueChanged.
      emitOwnerChatSnapshotWithQueue({
        callbacks: chat.callbacks,
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        queue: { status: "idle", items: [] },
      });
      expect(
        chat.handle.store.getState().acceptedActions[acceptedId],
      ).toBeUndefined();

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  // Pin 15 (P1 - consumed send restoration). An accepted send's content is
  // consumed by `takeSetupFailedRestoration` (what a setup-failed replay
  // calls once the composer takes the content back), nulling `restore` while
  // `confirmedByHost` stays `false` forever. This is the case
  // `acceptedActionHoldsUnrecoveredSend` reads `restore`, not the action kind,
  // for: a consumed restoration stops holding on its own, with no second flag
  // to keep in step.
  it("parks once an accepted send's content is consumed by takeSetupFailedRestoration, leaving confirmedByHost false (pin 15)", () => {
    const EPIC = "epic-park-chat-send-restoration-consumed-pin15";
    const TAB = "tab-park-chat-send-restoration-consumed-pin15";
    const CHAT_ID = "chat-send-restoration-consumed-pin15";
    const HOST_ID = "host-send-restoration-consumed-pin15";
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );

    const chat = buildTestChatHandleWithFrames(EPIC, CHAT_ID, HOST_ID);
    chatRegistry.acquire(
      { epicId: EPIC, chatId: CHAT_ID, hostId: HOST_ID, scopeKey: "pin15" },
      () => chat.handle,
    );
    emitOwnerChatSnapshot(chat.callbacks, EPIC, CHAT_ID, HOST_ID);
    const sent = sendChatTestMessage(chat.handle);
    const acceptedId = acceptLastChatAction({
      frames: chat.sent,
      callbacks: chat.callbacks,
      epicId: EPIC,
      chatId: CHAT_ID,
    });
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId]?.confirmedByHost,
    ).toBe(false);
    expect(
      chat.handle.store.getState().acceptedActions[acceptedId]?.restore,
    ).not.toBeNull();

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-pin15", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);
      expect(isEpicParked(EPIC)).toBe(false);

      const restored = chat.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId);
      expect(restored).not.toBeNull();
      // The two fields that distinguish "consumed" from "confirmed" - only
      // `restore` moved.
      expect(
        chat.handle.store.getState().acceptedActions[acceptedId]?.restore,
      ).toBeNull();
      expect(
        chat.handle.store.getState().acceptedActions[acceptedId]
          ?.confirmedByHost,
      ).toBe(false);

      expect(isEpicParked(EPIC)).toBe(true);
      expect(epicHandle.disposed).toBe(true);
      expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });
});
