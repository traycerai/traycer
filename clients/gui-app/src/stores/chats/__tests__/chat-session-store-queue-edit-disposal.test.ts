import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { chatCapHasActiveWork } from "@/stores/chats/session-registry";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  handedOffDrafts,
  resetHandedOffDrafts,
  waitForHandedOffDraft,
} from "@/stores/chats/__tests__/handoff-draft-observer";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

/**
 * Finding 1: an edited queued prompt in custody is held by this store alone
 * from the moment the composer clears. Disposal must hand it off, eviction
 * must wait for it, and a text already handed back must not be handed off a
 * second time.
 */

const EPIC_ID = "epic-queue-edit-disposal";
const CHAT_ID = "chat-queue-edit-disposal";
const OWNER_ID = "owner-queue-edit-disposal";
const HOST_ID = "host-a";
const QUEUE_ITEM_ID = "queue-item-1";
const MESSAGE_ID = "queued-message-1";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const ORIGINAL = textDoc("original queued text");
const EDITED_TEXT = "the corrected text that must survive disposal";
const EDITED = textDoc(EDITED_TEXT);

const ANNOTATION: BrowserAnnotationRecord = {
  kind: "browser-annotation",
  annotationId: "annotation-1",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.test",
  pageUrl: "https://example.test/page",
  pageTitle: "Example",
  capturedAt: 1,
  comment: "this button",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop.png",
  imageHash: "c".repeat(64),
  droppedElementCount: 0,
};

function queuedRow(content: JsonContent): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: QUEUE_ITEM_ID,
    messageId: MESSAGE_ID,
    message: { kind: "user", content, browserAnnotations: [] },
    sender: { type: "user", userId: OWNER_ID },
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

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
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
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
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

function emitSnapshot(
  harness: Harness,
  items: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  harness.callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: HOST_ID,
        title: "Host Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [...items] },
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
      portForwards: [],
    },
  });
}

function openWithQueuedRow(): Harness {
  const harness = createHarness();
  harness.callbacks().onConnectionStatus("open", null, null);
  emitSnapshot(harness, [queuedRow(ORIGINAL)]);
  return harness;
}

function submitEdit(harness: Harness): {
  readonly editActionId: string;
  readonly followUpActionId: string;
} {
  const editActionId = harness.handle.store.getState().submitQueueEdit({
    queueItemId: QUEUE_ITEM_ID,
    content: EDITED,
    restore: { content: EDITED, browserAnnotations: [ANNOTATION] },
    settings: SETTINGS,
    intent: "save",
  });
  if (editActionId === null) throw new Error("expected the edit to dispatch");
  const followUp = harness.sent.at(-1);
  if (followUp?.kind !== "queueSettingsUpdate") {
    throw new Error("expected a queueSettingsUpdate frame");
  }
  return { editActionId, followUpActionId: followUp.clientActionId };
}

function ackAccepted(
  harness: Harness,
  clientActionId: string,
  action: "queueEdit" | "queueSettingsUpdate",
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action,
    status: "accepted",
    reason: null,
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

const HANDOFF_WAIT_MS = HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000;

let harness: Harness | null = null;

beforeEach(() => {
  installFreshIndexedDb();
  resetHandedOffDrafts();
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
});

describe("an edited queued prompt in custody at disposal (finding 1)", () => {
  it("hands the edited text and its annotation to the draft handoff, with the 'closed before the host confirmed your edit' reason", async () => {
    harness = openWithQueuedRow();
    submitEdit(harness);

    harness.handle.dispose();

    const installed = await waitForHandedOffDraft(EDITED_TEXT, HANDOFF_WAIT_MS);
    expect(installed).toContain(
      "closed before the host confirmed your edit to a queued message",
    );
    // The annotation reached the handoff: a landing draft owns no sidecar, so
    // it says the record was dropped rather than silently lacking it.
    expect(installed).toContain("A browser annotation was not saved with it.");
  });

  it("does not hand the text off a second time once it was already returned to the user", async () => {
    harness = openWithQueuedRow();
    const { editActionId } = submitEdit(harness);
    // The connection dies with the edit unanswered; the reconnect snapshot
    // still shows the original, so the text is handed back and the record is
    // retained to watch for the host.
    harness.callbacks().onConnectionStatus("closed", null, null);
    harness.callbacks().onConnectionStatus("open", null, null);
    emitSnapshot(harness, [queuedRow(ORIGINAL)]);
    const state = harness.handle.store.getState();
    expect(state.queueEditRecords[editActionId]?.contentReturned).toBe(true);
    expect(state.failedSendRestoration?.content).toEqual(EDITED);

    // The composer takes the restoration: from here the text is the user's,
    // and the retained record is NOT a second holder of it.
    harness.handle.store.getState().ackFailedSendRestoration(editActionId);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(
      harness.handle.store.getState().queueEditRecords[editActionId],
    ).toBeDefined();

    harness.handle.dispose();
    // Let any (wrongly) started handoff install before reading the store.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(handedOffDrafts()).toEqual([]);
  });
});

describe("eviction waits for an edited queued prompt held only by this store (finding 1)", () => {
  it("holds the session while the record is the only copy, and releases it once the host accepted both frames", () => {
    harness = openWithQueuedRow();
    expect(chatCapHasActiveWork(harness.handle, null)).toBe(false);

    const { editActionId, followUpActionId } = submitEdit(harness);
    expect(chatCapHasActiveWork(harness.handle, null)).toBe(true);

    ackAccepted(harness, editActionId, "queueEdit");
    ackAccepted(harness, followUpActionId, "queueSettingsUpdate");
    expect(harness.handle.store.getState().queueEditRecords).toEqual({});
    expect(chatCapHasActiveWork(harness.handle, null)).toBe(false);
  });

  it("does not hold the session for a record whose text was already returned and taken", () => {
    harness = openWithQueuedRow();
    const { editActionId } = submitEdit(harness);
    harness.callbacks().onConnectionStatus("closed", null, null);
    harness.callbacks().onConnectionStatus("open", null, null);
    emitSnapshot(harness, [queuedRow(ORIGINAL)]);
    // The returned text sits in the restoration slot: that, not the record, is
    // what holds the session now.
    expect(chatCapHasActiveWork(harness.handle, null)).toBe(true);

    harness.handle.store.getState().ackFailedSendRestoration(editActionId);

    expect(
      harness.handle.store.getState().queueEditRecords[editActionId]
        ?.contentReturned,
    ).toBe(true);
    expect(chatCapHasActiveWork(harness.handle, null)).toBe(false);
  });
});
