/**
 * A separate file from `chat-session-store.test.ts` (another agent's file at
 * time of writing) so both can land without touching the same lines. Covers
 * T3's byte-custody roots: `pendingActions[*].restore.content`,
 * `pendingUserMessages[*].restore.content` and `failedSendRestoration.content`
 * keep an image hash live in `landingLiveImageRootHashes()` for as long as the
 * send is outstanding or its restoration is what the composer will get back.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";

const EPIC_ID = "epic-roots";
const CHAT_ID = "chat-roots";
const OWNER_ID = "owner-roots";
const IMAGE_HASH = "a".repeat(64);

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

describe("chat session store restore-content image roots", () => {
  it("keeps a fresh send's image hash live via pendingActions AND pendingUserMessages", () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const action = harness.handle.store.getState().sendMessage({
      content: IMAGE_CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: buildAttachmentsFromJSONContent(IMAGE_CONTENT),
      deliveryPolicy: "auto",
      restore: { content: IMAGE_CONTENT, browserAnnotations: [] },
    });
    expect(action).not.toBeNull();

    const state = harness.handle.store.getState();
    expect(Object.keys(state.pendingActions)).not.toHaveLength(0);
    expect(state.pendingUserMessages).not.toHaveLength(0);
    expect(landingLiveImageRootHashes().has(IMAGE_HASH)).toBe(true);
  });

  it("keeps the hash live in failedSendRestoration once the host rejects the send", () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const action = harness.handle.store.getState().sendMessage({
      content: IMAGE_CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: buildAttachmentsFromJSONContent(IMAGE_CONTENT),
      deliveryPolicy: "auto",
      restore: { content: IMAGE_CONTENT, browserAnnotations: [] },
    });
    expect(action).not.toBeNull();
    if (action === null) return;

    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: action.clientActionId,
      action: "send",
      status: "rejected",
      reason: "Host refused the send.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.content).toEqual(IMAGE_CONTENT);
    expect(landingLiveImageRootHashes().has(IMAGE_HASH)).toBe(true);
  });
});
