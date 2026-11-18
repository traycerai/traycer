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
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
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
const REMOVED_PROFILE_REASON =
  "That profile no longer exists. Choose a profile.";

const ANNOTATION: BrowserAnnotationRecord = {
  kind: "browser-annotation",
  annotationId: "annotation-r6f2",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.test",
  pageUrl: "https://example.test/page",
  pageTitle: "Example",
  source: {
    kind: "browser",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/page",
    pageTitle: "Example",
  },
  capturedAt: 1,
  comment: "the marked button",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop.png",
  imageHash: "c".repeat(64),
  droppedElementCount: 0,
};

const SETTINGS: ChatRunSettings = {
  ultracode: false,
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

function imageContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text },
          {
            type: "imageAttachment",
            attrs: {
              id: "image-r6f2",
              fileName: "screenshot.png",
              mimeType: "image/png",
              size: 128,
              hash: "e".repeat(64),
            },
          },
        ],
      },
    ],
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
  callbacks.onConnectionStatus("open", null, null, null);
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
  browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>,
): { readonly clientActionId: string; readonly messageId: string } {
  const action = harness.handle.store.getState().sendMessage({
    content,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(content),
    deliveryPolicy: "auto",
    restore: { content, browserAnnotations },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  return action;
}

async function expectHandedOffLastParagraph(
  marker: string,
  expected: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      const draft = handedOffDrafts().find((entry) =>
        draftPlainText(entry.content).includes(marker),
      );
      expect(draft).toBeDefined();
      if (draft === undefined) throw new Error("expected the handed-off draft");
      expect(draft.content.content?.at(-1)?.content?.[0]?.text).toBe(expected);
    },
    { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
  );
}

interface HandoffCodeCase {
  readonly code: "removed-by-person" | "RPC_ERROR";
  readonly reasonIsRemovedProfile: boolean;
  readonly expectedLastParagraph: string;
}

const ANNOTATION_HANDOFF_CASES: ReadonlyArray<HandoffCodeCase> = [
  {
    code: "removed-by-person",
    reasonIsRemovedProfile: true,
    expectedLastParagraph:
      "Unsent — Was removed\nA browser annotation was not saved with it.",
  },
  {
    code: "RPC_ERROR",
    reasonIsRemovedProfile: false,
    expectedLastParagraph:
      "Unsent — Was removed A browser annotation was not saved with it.",
  },
];

const DISPLACED_SEND_CASES: ReadonlyArray<HandoffCodeCase> = [
  {
    code: "removed-by-person",
    reasonIsRemovedProfile: true,
    expectedLastParagraph:
      "Unsent — A message was not accepted (Was removed). A browser annotation was not saved with it.",
  },
  {
    code: "RPC_ERROR",
    reasonIsRemovedProfile: false,
    expectedLastParagraph:
      "Unsent — A message was not accepted (That profile no longer exists. Choose a profile). A browser annotation was not saved with it.",
  },
];

function rejectPlain(
  harness: Harness,
  clientActionId: string,
  reason: string,
): void {
  rejectPlainWithCode(harness, clientActionId, reason, null);
}

function rejectPlainWithCode(
  harness: Harness,
  clientActionId: string,
  reason: string | null,
  code: string | null,
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
    code,
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
      [],
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

  it.each(ANNOTATION_HANDOFF_CASES)(
    "records the removed-profile flag and stashes an annotation after displacement for $code",
    async ({ code, reasonIsRemovedProfile, expectedLastParagraph }) => {
      harness = createHarness();
      emitOwnerSnapshot(harness.callbacks());
      const text = "displaced annotation prompt";
      const { clientActionId } = sendMessageWithContent(
        harness,
        plainContent(text),
        [ANNOTATION],
      );
      rejectPlainWithCode(
        harness,
        clientActionId,
        code === "removed-by-person" ? REMOVED_PROFILE_REASON : "Was removed",
        code,
      );

      expect(
        harness.handle.store.getState().failedSendRestoration?.clientActionId,
      ).toBe(clientActionId);
      harness.handle.store
        .getState()
        .stateFailedSendRestoration(clientActionId);

      const lastCopy =
        harness.handle.store.getState().lastCopyPrompts[clientActionId];
      expect(lastCopy.reason).toBe("Was removed");
      expect(lastCopy.reasonIsRemovedProfile).toBe(reasonIsRemovedProfile);

      harness.handle.dispose();
      await expectHandedOffLastParagraph(text, expectedLastParagraph);
    },
  );

  it("keeps the removed-profile flag when a displaced send loses its image", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const text = "displaced image prompt";
    const { clientActionId } = sendMessageWithContent(
      harness,
      imageContent(text),
      [],
    );
    rejectPlainWithCode(
      harness,
      clientActionId,
      REMOVED_PROFILE_REASON,
      "removed-by-person",
    );
    harness.handle.store.getState().stateFailedSendRestoration(clientActionId);

    const lastCopy =
      harness.handle.store.getState().lastCopyPrompts[clientActionId];
    expect(lastCopy.reason).toBe("Was removed");
    expect(lastCopy.reasonIsRemovedProfile).toBe(true);

    harness.handle.dispose();
    await expectHandedOffLastParagraph(
      text,
      "Unsent — Was removed\nAn image was not saved with it: the bytes are no longer on this device.",
    );
  });

  it.each(DISPLACED_SEND_CASES)(
    "records the removed-profile flag and stashed annotation for a displaced send under $code",
    async ({ code, reasonIsRemovedProfile, expectedLastParagraph }) => {
      harness = createHarness();
      emitOwnerSnapshot(harness.callbacks());
      const occupantText = "first refused send holds the restoration slot";
      const occupant = sendMessageWithContent(
        harness,
        plainContent(occupantText),
        [],
      );
      rejectPlainWithCode(
        harness,
        occupant.clientActionId,
        "The host refused this send.",
        "SEND_REFUSED",
      );

      const text = "displaced send with annotation";
      const { clientActionId } = sendMessageWithContent(
        harness,
        plainContent(text),
        [ANNOTATION],
      );
      rejectPlainWithCode(
        harness,
        clientActionId,
        REMOVED_PROFILE_REASON,
        code,
      );

      expect(
        harness.handle.store.getState().failedSendRestoration?.clientActionId,
      ).toBe(occupant.clientActionId);
      const lastCopy =
        harness.handle.store.getState().lastCopyPrompts[clientActionId];
      expect(lastCopy.reasonIsRemovedProfile).toBe(reasonIsRemovedProfile);

      harness.handle.dispose();
      await expectHandedOffLastParagraph(text, expectedLastParagraph);
    },
  );
});
