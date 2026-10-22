/**
 * Image roots for a queued prompt that leaves the host queue for activation:
 * until its saved row lands, only the dock's draining carry names its image
 * bytes and its annotation crops, so both collectors must root them.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";

const EPIC_ID = "epic-draining-roots";
const CHAT_ID = "chat-draining-roots";
const OWNER_ID = "owner-draining-roots";
const IMAGE_HASH = "a".repeat(64);
const CROP_HASH = "annotation-crop-hash-draining";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const IMAGE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "imageAttachment",
      attrs: {
        id: "image-1",
        fileName: "screenshot.png",
        mimeType: "image/png",
        size: 128,
        hash: IMAGE_HASH,
      },
    },
    { type: "paragraph", content: [{ type: "text", text: "look at this" }] },
  ],
};

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
    hostId: "host-a",
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

/** A minimal open, owned, idle snapshot - just enough for `sendMessage` to accept. */
function emitOwnerSnapshot(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null, null);
  const chat: Chat = {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: "test-host",
    title: "Host Chat",
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
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat,
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      sendWouldQueue: true,
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

let harness: Harness | null = null;

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
});

const ANNOTATION: BrowserAnnotationRecord = {
  kind: "browser-annotation",
  annotationId: "ann-draining",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example",
  source: {
    kind: "browser",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.com",
    pageUrl: "https://example.com/",
    pageTitle: "Example",
  },
  capturedAt: 1_700_000_000_000,
  comment: "make it pop",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop-draining.png",
  imageHash: CROP_HASH,
  droppedElementCount: 0,
};

function drainConfirmedQueuedSend(): { readonly messageId: string } {
  harness = createHarness();
  emitOwnerSnapshot(harness.callbacks());
  const action = harness.handle.store.getState().sendMessage({
    content: IMAGE_CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(IMAGE_CONTENT),
    deliveryPolicy: "auto",
    restore: { content: IMAGE_CONTENT, browserAnnotations: [ANNOTATION] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  const callbacks = harness.callbacks();
  const queued = {
    kind: "prompt" as const,
    queueItemId: "queue-draining-image",
    messageId: action.messageId,
    message: {
      kind: "user" as const,
      content: IMAGE_CONTENT,
      browserAnnotations: [ANNOTATION],
    },
    sender: { type: "user" as const, userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    sentFromHostId: null,
    delivery: "next_turn" as const,
    status: "pending" as const,
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
  callbacks.onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: action.clientActionId,
    action: "send",
    status: "accepted",
    reason: null,
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
  callbacks.onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: "running", items: [queued] },
  });
  expect(landingLiveImageRootHashes().has(IMAGE_HASH)).toBe(true);
  expect(landingLiveImageRootHashes().has(CROP_HASH)).toBe(true);

  callbacks.onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: "idle", items: [] },
  });
  const state = harness.handle.store.getState();
  expect(state.drainingQueueItems?.map((item) => item.messageId)).toEqual([
    action.messageId,
  ]);
  expect(Object.keys(state.pendingActions)).toEqual([]);
  return { messageId: action.messageId };
}

describe("image roots of a confirmed queued send that is draining", () => {
  it("roots the attachment hash while only the carry holds the prompt", () => {
    drainConfirmedQueuedSend();

    expect(landingLiveImageRootHashes().has(IMAGE_HASH)).toBe(true);
  });

  it("roots the annotation crop hash while only the carry holds the prompt", () => {
    drainConfirmedQueuedSend();

    expect(landingLiveImageRootHashes().has(CROP_HASH)).toBe(true);
  });

  it("releases the carry's roots once the saved row replaces it", () => {
    const { messageId } = drainConfirmedQueuedSend();
    expect(harness).not.toBeNull();
    harness?.callbacks().onMessageAccepted({
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
          content: IMAGE_CONTENT,
          browserAnnotations: [ANNOTATION],
        },
        timestamp: 10,
        sessionAnchor: null,
      },
    });

    const state = harness?.handle.store.getState();
    expect(state?.drainingQueueItems ?? []).toEqual([]);
    expect(state?.messages.some((m) => m.messageId === messageId)).toBe(true);
    const roots = landingLiveImageRootHashes();
    expect(roots.has(IMAGE_HASH)).toBe(false);
    expect(roots.has(CROP_HASH)).toBe(false);
  });
});
