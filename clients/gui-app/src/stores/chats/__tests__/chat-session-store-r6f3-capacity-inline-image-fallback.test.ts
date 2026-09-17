/**
 * R6F3 (P1): the save-failure fallback used a null resolver to try to induce
 * the "strip images" path - which does not work for an INLINE (`b64content`)
 * image, because `resolveImageSource` reads `attrs.b64content` before it
 * ever consults the resolver. So the null-resolver rebuild put the same
 * oversized bytes right back in, `save` was refused again with
 * `PromptStashCapacityExceededError`, and the whole handoff (text included)
 * was lost.
 *
 * The fix calls `buildTextOnlyPromptHandoff({ cause: "capacity" })`, which
 * strips every image unconditionally, regardless of inline/hash - and its
 * appended note names the "capacity" cause truthfully ("did not fit").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { PromptStashSnapshot } from "@/lib/composer/prompt-stash-codec";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { pngBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { PromptStashCapacityExceededError } from "@/lib/composer/prompt-stash-repository";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const promptStashMocks = vi.hoisted(() => ({
  save: vi.fn<(snapshot: PromptStashSnapshot) => Promise<void>>(),
}));
vi.mock("@/stores/composer/prompt-stash-store", () => ({
  usePromptStashStore: {
    getState: () => ({
      save: promptStashMocks.save,
      // The handoff calls `saveWhile`, not `save`. Routed through the same
      // mock so these assertions keep observing it - but HONOURING the
      // predicate, so a stale-generation write is skipped here exactly as the
      // real store skips it.
      saveWhile: (
        snapshot: PromptStashSnapshot,
        stillCurrent: () => boolean,
      ) =>
        stillCurrent()
          ? promptStashMocks.save(snapshot)
          : Promise.resolve(undefined),
    }),
  },
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
  promptStashMocks.save.mockReset();
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

describe("R6F3: a save refused for capacity falls back to a TEXT-ONLY handoff, even for an inline image", () => {
  it("the text survives and the note says the image did not fit, instead of repeating the capacity refusal forever (DRIVE RED)", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const TEXT = "inline-image prompt refused for capacity";
    const { clientActionId } = sendMessageWithContent(
      harness,
      inlineImageContent(TEXT, pngBytesOfSize(32)),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(clientActionId);

    // The FIRST save (carrying the image) is refused for capacity; anything
    // after that resolves normally, matching a real, one-shot budget refusal.
    promptStashMocks.save
      .mockRejectedValueOnce(new PromptStashCapacityExceededError())
      .mockResolvedValue(undefined);

    harness.handle.dispose();

    await vi.waitFor(() => {
      const stripped = promptStashMocks.save.mock.calls
        .map(([snapshot]) => snapshot)
        .find((snapshot) => {
          const text = JSON.stringify(snapshot.entry.content);
          return text.includes(TEXT) && text.includes("did not fit");
        });
      expect(stripped).toBeDefined();
      if (stripped === undefined) return;
      const text = JSON.stringify(stripped.entry.content);
      // The image is genuinely gone, not merely re-hashed - a null-resolver
      // rebuild kept `b64content` because it is read before any resolver is
      // ever consulted.
      expect(text).not.toContain("b64content");
      expect(stripped.entry.blobHashes).toEqual([]);
    });
  });

  it("a stash that refuses EVERY snapshot carrying an image still saves the words (DRIVE RED)", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const TEXT = "words that must outlive a stash with no room for pictures";
    const { clientActionId } = sendMessageWithContent(
      harness,
      // REAL PNG bytes. `[1,2,3,4,5]` fails the capture pipeline's magic-byte
      // sniff, so the very first build already goes text-only for
      // "unprepared" - the save then carries no image, the budget below
      // accepts it, and the capacity path this test exists for is never
      // reached. The test would still have gone green on the loose assertion.
      inlineImageContent(TEXT, pngBytesOfSize(32)),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");

    // The sharper version of the case above, and the one that actually
    // separates the two implementations. `mockRejectedValueOnce` lets a retry
    // succeed whatever it carries, so the old null-resolver fallback - which
    // rebuilds the SAME document, image included, because `b64content` is read
    // before any resolver - passes it. Here the budget refuses anything with
    // an image at all, which is what a stash genuinely out of room does. Only
    // a retry that really stripped the image gets in.
    promptStashMocks.save.mockImplementation(
      (snapshot: PromptStashSnapshot) => {
        const carriesImage =
          snapshot.entry.blobHashes.length > 0 ||
          JSON.stringify(snapshot.entry.content).includes("b64content");
        return carriesImage
          ? Promise.reject(new PromptStashCapacityExceededError())
          : Promise.resolve();
      },
    );

    harness.handle.dispose();

    await vi.waitFor(
      () => {
        const accepted = promptStashMocks.save.mock.calls
          .map(([snapshot]) => snapshot)
          .filter((snapshot) => snapshot.entry.blobHashes.length === 0)
          .find((snapshot) =>
            JSON.stringify(snapshot.entry.content).includes(TEXT),
          );
        expect(accepted).toBeDefined();
        if (accepted === undefined) return;
        const text = JSON.stringify(accepted.entry.content);
        expect(text).not.toContain("b64content");
        expect(text).toContain("did not fit");
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
  });
});
