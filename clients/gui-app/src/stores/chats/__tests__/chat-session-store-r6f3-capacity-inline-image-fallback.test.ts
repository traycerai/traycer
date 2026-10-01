/**
 * R6F3 (P1): the image-failure fallback used a null resolver to try to induce
 * the "strip images" path - which does not work for an INLINE (`b64content`)
 * image, whose bytes ride in the node and are never asked of a resolver at
 * all. So the null-resolver rebuild put the same oversized bytes right back
 * in, the import was refused again, and the whole handoff (text included) was
 * lost.
 *
 * The fix calls `buildTextOnlyPromptHandoff({ cause: "capacity" })`, which
 * strips every image unconditionally, regardless of inline/hash - and its
 * appended note names the "capacity" cause truthfully ("did not fit").
 *
 * The refusal is now the LANDING image budget rather than the retired prompt
 * stash's, so the budget is what this drives: `importImagesIntoLanding`
 * answers `null` for a document it will not admit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
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
import { pngBytesOfSize } from "@/lib/composer/__tests__/image-fixtures";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  draftPlainText,
  handedOffDrafts,
  resetHandedOffDrafts,
} from "@/stores/chats/__tests__/handoff-draft-observer";

// The landing image budget, refusing anything with an image in it - which is
// what a partition genuinely out of room does. `mockRejectedValueOnce`'s
// successor would let a retry in whatever it carried, so the old
// null-resolver fallback - which rebuilds the SAME document, `b64content`
// included - would have passed. Only a retry that really stripped the image
// gets in here.
const landingImportMocks = vi.hoisted(() => ({
  refuseImages: vi.fn<() => boolean>(() => false),
}));
vi.mock("@/lib/composer/landing-image-import", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/landing-image-import")
    >();
  return {
    ...actual,
    importImagesIntoLanding: (
      input: Parameters<typeof actual.importImagesIntoLanding>[0],
    ) =>
      landingImportMocks.refuseImages()
        ? Promise.resolve(null)
        : actual.importImagesIntoLanding(input),
  };
});

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const originalCreateImageBitmap = globalThis.createImageBitmap;

const EPIC_ID = "epic-r6f3";
const CHAT_ID = "chat-r6f3";
const OWNER_ID = "owner-r6f3";
const HOST_ID = "host-r6f3";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function inlineImageContent(text: string, bytes: Uint8Array): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "image-1",
          fileName: "screenshot.png",
          mimeType: "image/png",
          size: bytes.length,
          b64content: bytesToBase64(bytes),
        },
      },
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
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
        sendAction: () => undefined,
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
): { readonly clientActionId: string } {
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
  landingImportMocks.refuseImages.mockReturnValue(false);
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: vi.fn(() =>
      Promise.resolve({ width: 16, height: 16, close: () => undefined }),
    ),
  });
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
});

describe("R6F3: an image refused for capacity falls back to a TEXT-ONLY handoff, even for an inline image", () => {
  it("the text survives and the note says the image did not fit, instead of repeating the capacity refusal forever (DRIVE RED)", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const TEXT = "words that must outlive a window with no room for pictures";
    const { clientActionId } = sendMessageWithContent(
      harness,
      // REAL PNG bytes. `[1,2,3,4,5]` fails the magic-byte sniff, so the very
      // first build already goes text-only for "unprepared" - the capacity
      // path this test exists for is never reached, and the test would still
      // have gone green on the loose assertion.
      inlineImageContent(TEXT, pngBytesOfSize(32)),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(clientActionId);

    landingImportMocks.refuseImages.mockReturnValue(true);

    harness.handle.dispose();

    await vi.waitFor(
      () => {
        const installed = handedOffDrafts().find((draft) =>
          draftPlainText(draft.content).includes(TEXT),
        );
        expect(installed).toBeDefined();
        if (installed === undefined) return;
        // The image is genuinely gone, not merely re-hashed - a null-resolver
        // rebuild kept `b64content` because it rides in the node and no
        // resolver is ever consulted for it.
        expect(JSON.stringify(installed.content)).not.toContain("b64content");
        expect(JSON.stringify(installed.content)).not.toContain(
          "imageAttachment",
        );
        expect(draftPlainText(installed.content)).toContain("did not fit");
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
  });
});
