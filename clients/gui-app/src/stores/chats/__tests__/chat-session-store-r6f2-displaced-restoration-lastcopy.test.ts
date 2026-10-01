/**
 * R6F2: `stateFailedSendRestoration` records the displaced prompt into
 * `lastCopyPrompts`.
 *
 * Before the fix, clearing a restoration slot because a newer draft
 * displaced it (the handoff driver's "restoreAndAckFailed" -> composer not
 * empty branch) appended a `displacedRestorationNotice` but recorded no
 * document behind it. The notice holds only rendered text, so a disposal an
 * hour later - `handOffUnrecordedPromptToStash` reads `lastCopyPrompts`, not
 * `errorNotices` - found nothing to hand off and the prompt was destroyed
 * with no trace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import {
  draftPlainText,
  handedOffDrafts,
  resetHandedOffDrafts,
} from "@/stores/chats/__tests__/handoff-draft-observer";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const EPIC_ID = "epic-r6f2";
const CHAT_ID = "chat-r6f2";
const OWNER_ID = "owner-r6f2";
const HOST_ID = "host-r6f2";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function plainContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
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

function sendMessageWithContent(
  harness: Harness,
  content: JsonContent,
): { readonly clientActionId: string; readonly messageId: string } {
  const action = harness.handle.store.getState().sendMessage({
    content,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(content),
    deliveryPolicy: "auto",
    restore: { content, browserAnnotations: [] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  return action;
}

function rejectPlain(
  harness: Harness,
  clientActionId: string,
  reason: string,
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "send",
    status: "rejected",
    reason,
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

let harness: Harness | null = null;

beforeEach(() => {
  installFreshIndexedDb();
  resetHandedOffDrafts();
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("R6F2: stateFailedSendRestoration records the displaced prompt into lastCopyPrompts", () => {
  it("a restoration displaced via stateFailedSendRestoration (newer draft in composer) reaches the prompt stash at dispose (DRIVE RED)", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const TEXT = "restoration displaced by a newer draft";
    const { clientActionId } = sendMessageWithContent(
      harness,
      plainContent(TEXT),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(clientActionId);
    expect(
      Object.hasOwn(
        harness.handle.store.getState().lastCopyPrompts,
        clientActionId,
      ),
    ).toBe(false);

    // The driver calls this when the composer already holds a newer draft:
    // the restoration must not overwrite it, so it is stated instead.
    harness.handle.store.getState().stateFailedSendRestoration(clientActionId);

    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    const notice = harness.handle.store
      .getState()
      .errorNotices.find(
        (candidate) => candidate.clientActionId === clientActionId,
      );
    expect(notice).toBeDefined();
    // THE fix under test: a document now backs the notice.
    expect(
      Object.hasOwn(
        harness.handle.store.getState().lastCopyPrompts,
        clientActionId,
      ),
    ).toBe(true);
    expect(
      JSON.stringify(
        harness.handle.store.getState().lastCopyPrompts[clientActionId]
          ?.content,
      ),
    ).toContain(TEXT);

    harness.handle.dispose();

    await vi.waitFor(
      () => {
        expect(
          handedOffDrafts().some((draft) =>
            draftPlainText(draft.content).includes(TEXT),
          ),
        ).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
  });
});
