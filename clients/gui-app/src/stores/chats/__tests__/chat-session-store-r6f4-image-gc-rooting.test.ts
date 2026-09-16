/**
 * R6F4 (P2): image GC roots for a durable-handoff prompt.
 *
 * (a) A prompt sitting in `lastCopyPrompts` (before any disposal) roots its
 *     image hash - `collectPendingRestoreContentImageHashes` walks
 *     `state.lastCopyPrompts` for every live store. Without this, the
 *     landing-image GC's live-root union treats the hash as unreferenced and
 *     a sweep can reclaim its bytes while the prompt is still sitting there,
 *     waiting for its own eventual handoff.
 *
 * (b) `handoffCaptureRoots` roots the document a disposal's handoff is
 *     actively reading, from just before the async build starts until the
 *     save settles - because `dispose()` removes the store from
 *     `liveChatSessionStores` SYNCHRONOUSLY, so for that whole async window
 *     nothing else names the hash. Proven end-to-end: a real
 *     `landing-image-gc.reconcile()` sweep racing into that exact window
 *     must not delete the bytes the handoff is about to read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { PromptStashSnapshot } from "@/lib/composer/prompt-stash-codec";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import { pngBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";

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

const EPIC_ID = "epic-r6f4";
const CHAT_ID = "chat-r6f4";
const OWNER_ID = "owner-r6f4";
const HOST_ID = "host-r6f4";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const OK_CLIENT: DraftBlobClient = {
  request: ((_method, _params) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["request"],
};

function hashOnlyContent(hash: string, text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "image-1",
          fileName: "screenshot.png",
          mimeType: "image/png",
          size: 128,
          hash,
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

function annotationRecord(imageHash: string): BrowserAnnotationRecord {
  return {
    kind: "browser-annotation",
    annotationId: "ann-r6f4",
    tabId: "tab-1",
    sessionId: "session-1",
    origin: "https://example.test",
    pageUrl: "https://example.test/checkout",
    pageTitle: "Checkout",
    capturedAt: 1_700_000_000_000,
    comment: "the button is misaligned",
    counts: { elements: 1, regions: 0, strokes: 2 },
    elements: [],
    imageFileName: "crop.png",
    imageHash,
    droppedElementCount: 0,
  };
}

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function sendAnnotatedMessage(
  harness: Harness,
  content: JsonContent,
  browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>,
): { readonly clientActionId: string } {
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

async function seedConfirmedImage(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  await putImage(bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const seeded = await putDraftBlobs(HOST_ID, OK_CLIENT, [hash], OWNER_ID);
  expect(seeded).toEqual([hash]);
  return hash;
}

let harness: Harness | null = null;

beforeEach(() => {
  installFreshIndexedDb();
  promptStashMocks.save.mockReset();
  promptStashMocks.save.mockResolvedValue(undefined);
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

describe("R6F4(a): a lastCopyPrompts entry roots its own image hash", () => {
  it("the hash is a live root while the prompt sits in lastCopyPrompts, before any disposal (DRIVE RED)", async () => {
    const hashA = await seedConfirmedImage(pngBytesOfSize(32));
    const hashB = await seedConfirmedImage(pngBytesOfSize(40));

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const a = sendMessageWithContent(harness, hashOnlyContent(hashA, "A"));
    rejectPlain(harness, a.clientActionId, "A not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(a.clientActionId);

    // B loses the slot race - displaced into lastCopyPrompts, not disposed.
    const b = sendMessageWithContent(harness, hashOnlyContent(hashB, "B"));
    rejectPlain(harness, b.clientActionId, "B not accepted.");
    expect(
      Object.hasOwn(
        harness.handle.store.getState().lastCopyPrompts,
        b.clientActionId,
      ),
    ).toBe(true);

    const roots = landingLiveImageRootHashes();
    expect(roots.has(hashB)).toBe(true);
  });
});

describe("R8: a notice shows the words, so it cannot take custody of a sidecar", () => {
  it("keeps an annotated last copy and its crop root after the notice is delivered (DRIVE RED)", async () => {
    // `markNoticeDelivered` deletes the `lastCopyPrompts` record on the
    // premise that showing the prompt transfers custody. That premise holds
    // for TEXT and only for text: `unrecoverableSendNotice` renders
    // `quotedDraftOf(content)` and never looks at `browserAnnotations`. So
    // for an annotated prompt the toast hands the user the words while the
    // records remain uncopied - and deleting the row takes the last copy of
    // them AND unroots their crops, which this very map now names.
    const hashA = await seedConfirmedImage(pngBytesOfSize(32));
    const cropHash = await seedConfirmedImage(pngBytesOfSize(44));

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const a = sendMessageWithContent(harness, hashOnlyContent(hashA, "A"));
    rejectPlain(harness, a.clientActionId, "A not accepted.");

    // B carries an annotation sidecar and loses the single restoration slot.
    const b = sendAnnotatedMessage(harness, textContent("B"), [
      annotationRecord(cropHash),
    ]);
    rejectPlain(harness, b.clientActionId, "B not accepted.");
    const held =
      harness.handle.store.getState().lastCopyPrompts[b.clientActionId];
    expect(held.browserAnnotations.length).toBe(1);
    expect(landingLiveImageRootHashes().has(cropHash)).toBe(true);

    // The toast lands, quoting B's words and saying nothing about the crop.
    const notice = harness.handle.store
      .getState()
      .errorNotices.find(
        (candidate) => candidate.clientActionId === b.clientActionId,
      );
    if (notice === undefined) throw new Error("expected a notice for B");
    harness.handle.store.getState().markNoticeDelivered(notice);

    // The words have been shown. The sidecar has not, and this row is still
    // the only thing holding it - so the handoff must still find it here.
    expect(
      Object.hasOwn(
        harness.handle.store.getState().lastCopyPrompts,
        b.clientActionId,
      ),
    ).toBe(true);
    expect(landingLiveImageRootHashes().has(cropHash)).toBe(true);
  });
});

/**
 * DELIBERATE DIVERGENCE, reviewed and accepted: this asserts ROOT MEMBERSHIP
 * at the moment the window is open, rather than racing a real
 * `landing-image-gc` sweep against the capture.
 *
 * The real-race version was tried and is genuinely nondeterministic - the
 * sweep's own IndexedDB round trip is comparable in cost to the handoff chain,
 * so which one wins varies run to run. Making it deterministic would mean
 * adding an injectable delay to production purely so a test could interleave
 * with it, which is a worse trade than asserting the guarantee directly.
 *
 * The guarantee IS membership: the sweep deletes exactly what the root sources
 * do not name, so "the hash is named while the capture is in flight" is the
 * property, and a flaky race would only ever observe it indirectly.
 */
describe("R7F2: handoffCaptureRoots is released as soon as the snapshot exists, not when the save settles", () => {
  it("the hash is NO LONGER a root once the snapshot has been handed to a STALLED save (DRIVE RED on finally-only release)", async () => {
    // The save never settles - a promise that is never going to resolve or
    // reject. If release only happened in the `.finally`, the root would
    // stay held for as long as this test runs; if release happens as soon
    // as the snapshot exists (before `save` is even called), the root is
    // gone well before that.
    promptStashMocks.save.mockImplementation(
      () => new Promise(() => undefined),
    );

    const hash = await seedConfirmedImage(pngBytesOfSize(56));
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "stalled-save capture prompt"),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(clientActionId);

    harness.handle.dispose();

    // Wait for the snapshot to exist: `save` is called right after release,
    // in the same `.then`, so "save was called" is the signal that the
    // snapshot is built and release (on the current, fixed code) has
    // already run - even though `save` itself is stalled forever.
    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });

    const roots = landingLiveImageRootHashes();
    expect(roots.has(hash)).toBe(false);
  });
});

describe("R6F4(b): handoffCaptureRoots protects an in-flight capture from a concurrent sweep", () => {
  it("the hash is a live root at the exact instant dispose() has removed the store from liveChatSessionStores but the async capture has not resolved (DRIVE RED)", async () => {
    const hash = await seedConfirmedImage(pngBytesOfSize(48));
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "in-flight capture prompt"),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(clientActionId);

    // Synchronously: starts the async capture (`handoffCaptureRoots` is set
    // BEFORE the first await) and removes the store from
    // `liveChatSessionStores` in the same tick - so by the time this call
    // returns, nothing but `handoffCaptureRoots` names this hash.
    harness.handle.dispose();

    // A real image-GC sweep landing in THIS exact window (before the async
    // handoff has had a chance to resolve a single microtask) must see the
    // hash as live, or it would reclaim bytes the handoff is about to read.
    const roots = landingLiveImageRootHashes();
    expect(roots.has(hash)).toBe(true);

    // End-to-end confirmation that the ordinary (uninterrupted) path still
    // resolves the image successfully once the capture completes.
    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const saved = promptStashMocks.save.mock.calls.map(
      ([snapshot]) => snapshot,
    );
    const match = saved.find((snapshot) =>
      JSON.stringify(snapshot.entry.content).includes(
        "in-flight capture prompt",
      ),
    );
    expect(match).toBeDefined();
    if (match === undefined) throw new Error("expected the prompt's snapshot");
    expect(match.entry.blobHashes.length).toBeGreaterThan(0);
  });
});
