/**
 * T5's refusal path: a `MISSING_ATTACHMENT_BYTES` rejection of a send whose
 * `restore.content` carries a hash-only image node forks in
 * `onActionAck` (`chat-session-store.ts`). Covers the silent `not-on-host`
 * retry, the loud `unsupported-format` mark, `too-large`, and the retry's
 * own carriage of the send's staged worktree intent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedManagedCommandItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatMessageDelivery } from "@traycer/protocol/host/agent/gui/message-delivery";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";

import {
  createChatSessionStore,
  POST_DISPATCH_NOTICE_SUPPRESSION_MS,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  SEND_NOT_RECORDED_NOTICE_CODE,
  deadSendAccountClauses,
  type DeadSendAccount,
} from "@/stores/chats/chat-queue-reconciler";
import type { RemovedWorktreeRefs } from "@/lib/worktree/removed-worktree-refs";
import { optimisticQueuedItemId } from "@/stores/chats/optimistic-queue";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  chatWholeSetSliceBytes,
  legacyTranscriptResidencyBytes,
} from "@/stores/replica-memory/chat-window-budget";
import {
  getProcessMemoryAccountant,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { putImage, releaseSession } from "@/lib/composer/landing-image-store";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  isDraftBlobConfirmed,
  isDraftBlobUnbridgeable,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { RECOVERY_INLINING_TIMEOUT_MS } from "@/lib/drafts/draft-image-retry-content";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import {
  readStagedWorktreeIntent,
  sessionSweptRefsForHost,
  stagedWorktreeIntentAwaitsDispatchFrom,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  ChatSessionRegistry,
  MAX_ACTIVE_CHAT_IDLE_DEFER_MS,
  type ChatSessionTarget,
} from "@/stores/chats/session-registry";
import {
  draftPlainText,
  handedOffDrafts,
  resetHandedOffDrafts,
} from "@/stores/chats/__tests__/handoff-draft-observer";

// `chat-session-store.ts` reaches `draft-mirror-coordinator.ts` (via
// `draft-image-retry-content.ts` -> `draft-image-byte-target.ts`), which pulls
// in a whole live subsystem this file never needs. This file's
// own code path never needs a real draft-mirror session
// (`draftMirrorClientForHost` only feeds a byte-resolution leg this suite's
// hash always resolves through the LOCAL landing store first), so the mock
// sidesteps the whole subsystem rather than fighting its timing.
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

// R4F1/R4F2: the durable-handoff tests assert on exactly what a disposing
// store hands to the prompt stash. Going through the REAL repository would
// hit the same permanently-poisoned `dbPromise` the comment above describes
// (its module-load-time `hydrate()` opens the DB before this file's
// `beforeEach` ever installs a fake `indexedDB`) - fire-and-forget calls never
// surfaced that, but a test that inspects what was saved would. Mocking the
// store itself sidesteps it and lets the assertions read the exact snapshot
// `handOffUnrecordedPromptToStash` built, not a value round-tripped through
// IndexedDB.

// RR7: a controllable stand-in for the LOCAL image-bytes leg
// (`resolveDraftImageBytes`'s first, cheapest leg - see
// `resolve-draft-image-bytes.ts`). Forwards to the real implementation by
// default, so every other test in this file is unaffected; only the RR7 test
// below installs a stalling implementation.
const localImageMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(),
  realGetImageBytes: null as
    | ((hash: string) => Promise<Uint8Array | undefined>)
    | null,
}));

// F2 (4b): the local host id the store stamps as `sentFromHostId`, made
// settable so a test can move it BETWEEN a send and its retry - which is what
// the desktop's directory does when the local host enrolls after the app has
// already been used (`null` -> id), or re-enrolls under a new id.
const localHostIdMock = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@/lib/host/local-host-id-snapshot", () => ({
  readLocalHostIdSnapshot: (): string | null => localHostIdMock.value,
}));

vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  localImageMocks.realGetImageBytes = actual.getImageBytes;
  localImageMocks.getImageBytes.mockImplementation(actual.getImageBytes);
  return { ...actual, getImageBytes: localImageMocks.getImageBytes };
});

const EPIC_ID = "epic-refusal";
const CHAT_ID = "chat-refusal";
const OWNER_ID = "owner-refusal";
const HOST_ID = "host-a";
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

/** `putImage` is content-addressed - the digest is a function of the bytes,
 * never a name this test can pick, so it is derived independently rather than
 * hard-coded. */
async function imageHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", IMAGE_BYTES);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

/**
 * The text every hash-only fixture carries, so a test can assert the PROMPT
 * survived rather than that a sentence about it was shown.
 */
const A_PROMPT_TEXT = "look at this";

function hashOnlyContent(hash: string): JsonContent {
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
      { type: "paragraph", content: [{ type: "text", text: A_PROMPT_TEXT }] },
    ],
  };
}

/** Like {@link hashOnlyContent}, but with caller-chosen prompt text - for
 * tests that must tell two independent recoveries' documents apart by
 * content rather than by hash. */
function hashOnlyContentWithText(hash: string, text: string): JsonContent {
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

/** Two independent hash-only image nodes in one document, for RRR2's
 * per-hash resolution test. */
function twoHashOnlyContent(hashA: string, hashB: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "image-a",
          fileName: "a.png",
          mimeType: "image/png",
          size: 128,
          hash: hashA,
        },
      },
      {
        type: "imageAttachment",
        attrs: {
          id: "image-b",
          fileName: "b.png",
          mimeType: "image/png",
          size: 128,
          hash: hashB,
        },
      },
      { type: "paragraph", content: [{ type: "text", text: A_PROMPT_TEXT }] },
    ],
  };
}

const OK_CLIENT: DraftBlobClient = {
  request: ((_method, _params) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["request"],
  // `drafts.putBlob` rides THIS member, never `request` above - a fake without
  // it is a fake no upload can reach. Options ignored: no case here turns on
  // the idempotency key or the upload budget.
  requestWithOptions: ((_method, _params) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["requestWithOptions"],
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

/**
 * A second, otherwise-idle chat session with a stub stream - the only kind of
 * session a warm-cap overflow can legitimately pick, used as the control
 * candidate in the RR1 eviction-matrix tests.
 */
function createIdleChatHandle(
  epicId: string,
  chatId: string,
  hostId: string,
): ChatSessionStoreHandle {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId,
    epicId,
    chatId,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
}

/**
 * A content-free chip so a send made while this stands non-empty takes the
 * QUEUED shape: `shouldRenderSendAsOptimisticQueuedItem` reads `queue.items.
 * length > 0`, and this item can never collide with (or be mistaken for) the
 * send under test.
 */
function seedManagedCommandItem(
  queueItemId: string,
): ChatQueuedManagedCommandItem {
  return {
    kind: "managed-command",
    queueItemId,
    commandId: `${queueItemId}-command`,
    description: "bun test --watch",
    monitoring: true,
    // `1.11` added the host a cross-host shell runs on; `null` is the chat's
    // own host, which is what this fixture models.
    hostId: null,
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function emitOwnerSnapshot(
  callbacks: ChatStreamCallbacks,
  queueItems: ReadonlyArray<ChatQueuedManagedCommandItem>,
): void {
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
      queue: {
        status: queueItems.length > 0 ? "running" : "idle",
        items: [...queueItems],
      },
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

/** Seeds a real, locally-stored image and a confirmed upload for it, and
 * returns its digest. */
async function seedConfirmedImage(): Promise<string> {
  await putImage(IMAGE_BYTES);
  const hash = await imageHash();
  const seeded = await putDraftBlobs(HOST_ID, OK_CLIENT, [hash], OWNER_ID);
  expect(seeded).toEqual([hash]);
  expect(isDraftBlobConfirmed(HOST_ID, hash, OWNER_ID)).toBe(true);
  return hash;
}

/** A second, distinct image so two independent hash-only sends never share a
 * digest (and so never collide in the once-per-host upload memo). */
async function seedSecondConfirmedImage(): Promise<string> {
  const bytes = new Uint8Array([9, 9, 9, 9, 9]);
  await putImage(bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const seeded = await putDraftBlobs(HOST_ID, OK_CLIENT, [hash], OWNER_ID);
  expect(seeded).toEqual([hash]);
  return hash;
}

/**
 * `hashOnlyContent(hash)` plus a SECOND `imageAttachment` atom that already
 * carries inline bytes - the shape submit produces after it appends an
 * annotation crop atom AFTER capturing `restore.content` (see
 * `use-chat-composer-submit.ts`). `restore.content` stays `hashOnlyContent`
 * only: the crop atom never existed when the hand-back document was frozen.
 */
function contentWithCropAtom(hash: string, cropB64: string): JsonContent {
  const base = hashOnlyContent(hash);
  return {
    ...base,
    content: [
      base.content?.at(0),
      {
        type: "imageAttachment",
        attrs: {
          id: "crop-1",
          fileName: "crop.png",
          mimeType: "image/png",
          size: 64,
          hash: null,
          b64content: cropB64,
        },
      },
      ...(base.content?.slice(1) ?? []),
    ].filter((node): node is JsonContent => node !== undefined),
  };
}

/** Sends `hashOnlyContent(hash)` and returns the accepted action's ids. */
function sendHashOnlyMessage(
  harness: Harness,
  hash: string,
): {
  readonly clientActionId: string;
  readonly messageId: string;
} {
  return sendMessageWithContent(
    harness,
    hashOnlyContent(hash),
    hashOnlyContent(hash),
  );
}

/** Sends `wireContent` while freezing `restoreContent` as the hand-back
 * document, mirroring how `use-chat-composer-submit.ts` can send content the
 * restore document never carried (T5's F3). */
function sendMessageWithContent(
  harness: Harness,
  wireContent: JsonContent,
  restoreContent: JsonContent,
): {
  readonly clientActionId: string;
  readonly messageId: string;
} {
  const action = harness.handle.store.getState().sendMessage({
    content: wireContent,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(wireContent),
    deliveryPolicy: "auto",
    restore: { content: restoreContent, browserAnnotations: [] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  return action;
}

function rejectMissingAttachmentBytes(
  harness: Harness,
  clientActionId: string,
  cause: "not-on-host" | "unsupported-format" | "too-large",
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "send",
    status: "rejected",
    reason: "Host does not hold this digest.",
    code: "MISSING_ATTACHMENT_BYTES",
    cause,
    backgroundStopTaskIds: [],
    token: null,
  });
}

let harness: Harness | null = null;

beforeEach(() => {
  installFreshIndexedDb();
  localHostIdMock.value = null;
  localImageMocks.getImageBytes.mockReset();
  if (localImageMocks.realGetImageBytes !== null) {
    localImageMocks.getImageBytes.mockImplementation(
      localImageMocks.realGetImageBytes,
    );
  }
  resetHandedOffDrafts();
});

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("chat session store - hash-only refusal (T5)", () => {
  it("a rejected hash-only send invalidates the memo and retries inline exactly once, silently", async () => {
    // Pre-T5: `onActionAck` had no hash-only fork at all, so a
    // `MISSING_ATTACHMENT_BYTES` rejection fell straight to the ordinary
    // rejection path - `errorNotices` gained an entry, `failedSendRestoration`
    // took the record, and nothing ever retried. Every assertion below is
    // false against that code.
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId, messageId } = sendHashOnlyMessage(harness, hash);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    // (a) The wrong confirmation is dropped immediately, synchronously with
    // the ack - before the retry's async re-inline even starts.
    expect(isDraftBlobConfirmed(HOST_ID, hash, OWNER_ID)).toBe(false);

    // (d) The first failure is silent: no notice, no restoration slot taken.
    const afterReject = harness.handle.store.getState();
    expect(afterReject.errorNotices).toHaveLength(0);
    expect(afterReject.failedSendRestoration).toBeNull();

    // (b) + (c): a second `send` goes out, carrying bytes inline, with the
    // SAME messageId and a DIFFERENT clientActionId.
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    expect(retryFrame.messageId).toBe(messageId);
    expect(retryFrame.clientActionId).not.toBe(clientActionId);
    const retriedNode = retryFrame.content.content?.at(0);
    expect(retriedNode?.attrs?.hash).toBeFalsy();
    expect(typeof retriedNode?.attrs?.b64content).toBe("string");
  });

  it("a rejected hash-only send neither retries nor surfaces while the delivery view names it - the identical rejection WOULD retry silently without the gate (see the case above)", async () => {
    const controlHash = await seedConfirmedImage();
    const gatedHash = await seedSecondConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);

    // Positive control, inline: an identical `not-on-host` rejection with no
    // delivery view retries inline exactly once, silently - the same
    // mechanism the case above already proves, repeated here so this test is
    // self-contained.
    const control = sendHashOnlyMessage(harness, controlHash);
    rejectMissingAttachmentBytes(
      harness,
      control.clientActionId,
      "not-on-host",
    );
    // Synchronous, before the async re-inline completes and the record is
    // retired: an identical rejection with no delivery view creates a
    // recovery record at once - the baseline the gated case's absence is
    // measured against.
    expect(
      Object.hasOwn(
        harness.handle.store.getState().hashOnlyRecoveries,
        control.clientActionId,
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const controlRetry = harness.sent[1];
    if (controlRetry.kind !== "send") {
      throw new Error("expected the control's retry send frame");
    }
    expect(controlRetry.messageId).toBe(control.messageId);

    // The gated send: the delivery view already names this exact message
    // before its rejection arrives.
    const gated = sendHashOnlyMessage(harness, gatedHash);
    const delivery: ChatMessageDelivery = {
      messageId: gated.messageId,
      revision: 1,
      state: { phase: "pending" },
    };
    harness.callbacks().onMessageDeliveryChanged({
      kind: "messageDeliveryChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      delivery,
    });
    const beforeGatedReject = harness.handle.store.getState();

    rejectMissingAttachmentBytes(harness, gated.clientActionId, "not-on-host");

    // `beginHashOnlyRecovery`'s own gate (`messageDeliveryNames`) declines
    // BEFORE it ever creates a recovery record - synchronous, unconditional
    // proof that no retry was even scheduled, not a timing-dependent absence.
    expect(
      Object.hasOwn(
        harness.handle.store.getState().hashOnlyRecoveries,
        gated.clientActionId,
      ),
    ).toBe(false);
    // The ordinary rejected-arm housekeeping still runs (the host's refusal
    // IS honoured) - only `rejectionSurfaces`' own notice/restoration are
    // gated silent.
    expect(
      harness.handle.store.getState().pendingActions[gated.clientActionId],
    ).toBeUndefined();
    expect(harness.handle.store.getState().errorNotices).toEqual(
      beforeGatedReject.errorNotices,
    );
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    // No third send frame ever follows the gated message's own initial one -
    // asserted after flushing microtasks, on top of (never instead of) the
    // synchronous mechanism proof above.
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.sent).toHaveLength(3);
  });

  it("the optimistic user message never flickers across the rejection and retry", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId, messageId } = sendHashOnlyMessage(harness, hash);
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    // Never empty, and never holding two rows for the same messageId - the
    // fork removes the settled `pendingActions` entry but deliberately does
    // NOT touch `pendingUserMessages` until the retry's own send re-registers
    // one under the SAME id in the same synchronous step.
    const afterReject = harness.handle.store.getState().pendingUserMessages;
    expect(afterReject.length).toBeGreaterThan(0);
    expect(
      afterReject.every((message) => message.messageId === messageId),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const finalState = harness.handle.store.getState().pendingUserMessages;
    const forThisMessage = finalState.filter(
      (message) => message.messageId === messageId,
    );
    expect(forThisMessage).toHaveLength(1);
  });

  it("a second failure is loud: the reason surfaces once and no third send goes out", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");

    // The retry's own record is marked `hashOnlyRetry`, so this second
    // rejection reaches the ordinary path, not another silent retry.
    rejectMissingAttachmentBytes(
      harness,
      retryFrame.clientActionId,
      "not-on-host",
    );

    const state = harness.handle.store.getState();
    expect(state.errorNotices).toHaveLength(1);
    expect(harness.sent).toHaveLength(2);
  });

  it("unsupported-format retries nothing, marks the hash, and the gate stops offering it", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    rejectMissingAttachmentBytes(harness, clientActionId, "unsupported-format");

    const state = harness.handle.store.getState();
    expect(state.errorNotices).toHaveLength(1);
    expect(harness.sent).toHaveLength(1);
    expect(isDraftBlobUnbridgeable(HOST_ID, hash)).toBe(true);

    // Asserting only the boolean tests a setter; the mark exists so the gate
    // stops offering this hash bare on a LATER send.
    const { submitHostHeldImageHashes } =
      await import("@/lib/composer/submit-host-held-image-hashes");
    const held = submitHostHeldImageHashes({
      surfaceKey: "gate-check",
      incarnation: null,
      content: hashOnlyContent(hash),
      hostId: HOST_ID,
      bridgeSupported: true,
      ownerUserId: OWNER_ID,
    });
    expect(held.has(hash)).toBe(false);
  });

  it("too-large surfaces with no retry and no unbridgeable mark", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    rejectMissingAttachmentBytes(harness, clientActionId, "too-large");

    const state = harness.handle.store.getState();
    expect(state.errorNotices).toHaveLength(1);
    expect(harness.sent).toHaveLength(1);
    expect(isDraftBlobUnbridgeable(HOST_ID, hash)).toBe(false);
  });

  it("the silent retry carries the original send's staged worktree intent", async () => {
    // The fork sits AFTER the worktree re-stage below it, not before: the
    // first send CONSUMES the chat's staged pick, and `sendMessage` reads it
    // from the staging store rather than from an argument. A retry that ran
    // before the pick was put back would silently bind to whatever this chat
    // was staging BEFORE this send - including nothing.
    const hash = await seedConfirmedImage();

    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intent);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    // Not null, and not some OTHER intent - the same one the first send
    // consumed.
    expect(retryFrame.worktreeIntent).toEqual(intent);
  });

  // ─── F1: custody through recovery ───────────────────────────────────────

  it("F1 (1): a QUEUED send's queue row, recovery record and image bytes all survive the await", async () => {
    // Pre-fix, the recovery record did not exist: `beginHashOnlyRecovery`
    // removed the settled action and rebuilt the retry from ambient state at
    // dispatch time, so for the whole of the byte-resolution await a QUEUED
    // send (no transcript echo) had NO trace anywhere in the store - no
    // pending action, no queue row, no restoration slot, and the GC root
    // collector (`collectPendingRestoreContentImageHashes`) had nothing to
    // walk either. Driven red separately by deleting that collector's
    // recovery branch.
    const hash = await seedConfirmedImage();
    // Strip the session root the seeding put(image) added, so ONLY the
    // recovery record's own root (or its absence) decides whether a GC sweep
    // can see these bytes.
    releaseSession(hash);

    harness = createHarness();
    // A non-empty queue forces this send onto the QUEUED shape: no optimistic
    // transcript echo, only an optimistic queue row.
    emitOwnerSnapshot(harness.callbacks(), [
      seedManagedCommandItem("queue-seed"),
    ]);
    const { clientActionId, messageId } = sendHashOnlyMessage(harness, hash);
    const queueItemId = optimisticQueuedItemId(clientActionId);
    const beforeReject = harness.handle.store.getState();
    expect(
      beforeReject.queue.items.some((item) => item.queueItemId === queueItemId),
    ).toBe(true);
    expect(beforeReject.pendingUserMessages).toHaveLength(0);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    // Read the LIVE root set in the same synchronous tick as the rejection -
    // before the retry's own async chain has had a chance to run its first
    // microtask and mint a new pending action of its own, which would root
    // the bytes through a completely different (and pre-existing) door and
    // mask exactly the regression this test exists to catch.
    const duringRecovery = harness.handle.store.getState();
    expect(
      duringRecovery.queue.items.some(
        (item) => item.queueItemId === queueItemId,
      ),
    ).toBe(true);
    expect(
      Object.hasOwn(duringRecovery.hashOnlyRecoveries, clientActionId),
    ).toBe(true);
    // The roots half is the point: a GC sweep run WHILE recovery is
    // outstanding, and before the retry has dispatched, must still see these
    // bytes as live.
    expect(landingLiveImageRootHashes().has(hash)).toBe(true);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });

    // And the row is REPLACED, not merely retired. `sendAction` does not paint
    // an optimistic queue row - `sendMessage` appends it separately - so a
    // retry that only removed the settled action's row left a queued send with
    // nothing visible at all until the host's next queue snapshot. For a
    // queued send that row is the only thing the user can see.
    const afterDispatch = harness.handle.store.getState();
    expect(
      afterDispatch.queue.items.some(
        (item) => item.queueItemId === queueItemId,
      ),
    ).toBe(false);
    // Exactly one prompt row for this message id - the retry's, painted in the
    // same step the settled one was removed.
    const retryRows = afterDispatch.queue.items.filter(
      (item) => item.kind === "prompt" && item.messageId === messageId,
    );
    expect(retryRows).toHaveLength(1);
    expect(retryRows[0]?.queueItemId).not.toBe(queueItemId);
  });

  it("F1 (2): a dispatch refused mid-recovery hands the prompt back loudly instead of losing it", async () => {
    // Pre-fix this produced NOTHING AT ALL: the retry's `sendAction` refusal
    // had no record to fall back to, because the only record was the async
    // closure's local variables. `abandonHashOnlyRecovery` is what turns a
    // refused dispatch into a stated, restorable failure.
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // The connection drops WHILE the byte resolution is in flight, so by the
    // time the retry's `sendAction` runs, `canSendAction` refuses it.
    harness.callbacks().onConnectionStatus("reconnecting", null, null);

    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });
    const state = harness.handle.store.getState();
    // The prompt is NOT lost: the hand-back slot took it, carrying the
    // host's own reason.
    expect(state.failedSendRestoration).not.toBeNull();
    expect(state.failedSendRestoration?.content).toEqual(hashOnlyContent(hash));
    expect(state.failedSendRestoration?.reason).toBe(
      "Host does not hold this digest.",
    );
    // The settled original's echo is retired with it.
    expect(state.pendingUserMessages).toHaveLength(0);
    // And the retry never actually reached the wire - `sendAction` refused
    // before calling into the stream client.
    expect(harness.sent).toHaveLength(1);
  });

  it("R2: two concurrent refusals BOTH recover, each with its own custody", async () => {
    // The single slot forced a choice with no good side. Keeping the first
    // meant demoting the second to the loud path - where it then occupied
    // `failedSendRestoration`, so if the first later failed to dispatch it had
    // nowhere to hand its prompt back to and was destroyed silently. Keeping
    // the second clobbered the first's record, roots and queue row while its
    // retry was still running. A map gives each refusal its own owner, which
    // is what "the recovery record is a first-class lifecycle citizen" has to
    // mean when there can be two of them.
    //
    // Concurrent refusals are not exotic here: a host that has lost its blob
    // store refuses every hash-only send it is given.
    const hashA = await seedConfirmedImage();
    const hashB = await seedSecondConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const first = sendHashOnlyMessage(harness, hashA);
    const second = sendHashOnlyMessage(harness, hashB);

    rejectMissingAttachmentBytes(harness, first.clientActionId, "not-on-host");
    rejectMissingAttachmentBytes(harness, second.clientActionId, "not-on-host");

    const duringRecovery = harness.handle.store.getState();
    // BOTH are recovering, each naming its own action and its own bytes.
    expect(Object.keys(duringRecovery.hashOnlyRecoveries)).toHaveLength(2);
    const hashesOf = (clientActionId: string): ReadonlyArray<string> =>
      collectImageAtoms(
        duringRecovery.hashOnlyRecoveries[clientActionId].wireContent,
      )
        .map((atom) => atom.hash)
        .filter((value): value is string => value !== null);
    expect(hashesOf(first.clientActionId)).toContain(hashA);
    expect(hashesOf(second.clientActionId)).toContain(hashB);
    // Neither took the loud path, so neither occupied the restoration slot
    // that the other might still need.
    expect(duringRecovery.errorNotices).toHaveLength(0);
    expect(duringRecovery.failedSendRestoration).toBeNull();
    // Both sets of bytes stay rooted for the length of both recoveries.
    expect(landingLiveImageRootHashes().has(hashA)).toBe(true);
    expect(landingLiveImageRootHashes().has(hashB)).toBe(true);

    // Two originals plus two retries, each reusing its OWN message id.
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(4);
    });
    const retryMessageIds = harness.sent
      .slice(2)
      .map((frame) => (frame.kind === "send" ? frame.messageId : null));
    expect(retryMessageIds).toContain(first.messageId);
    expect(retryMessageIds).toContain(second.messageId);
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);
  });

  // ─── F2: frozen execution context ───────────────────────────────────────

  it("F2 (3): the retry carries the ORIGINAL staged worktree pick, and a later stage during recovery is left untouched", async () => {
    const hash = await seedConfirmedImage();
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    const intentB: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-b",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intentA);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    // The worktree re-stage (which runs BEFORE the hash-only fork) has put A
    // back into the staging slot. Now, WHILE the byte resolution is still
    // outstanding, the user stages a DIFFERENT workspace wholesale - `setIntent`
    // is the replace primitive; `stageIntent` merges entries, which would leave
    // A's entry standing beside B's and defeat the point of this test.
    useWorktreeIntentStagingStore.getState().setIntent(stagingKey, intentB);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    // The retry carries A - the pick THIS send was made under, frozen on the
    // recovery record - never B.
    expect(retryFrame.worktreeIntent).toEqual(intentA);
    // And B is still staged: the retry consumed nothing, because it never
    // re-reads the staging store at all.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentB);
  });

  it("F2 (4): the retry carries the ORIGINAL account context, not one changed during recovery", async () => {
    const hash = await seedConfirmedImage();
    useAccountContextStore.setState({
      accountContext: { type: "PERSONAL" } satisfies AccountContext,
    });

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.accountContext).toEqual({ type: "PERSONAL" });

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    // The account context changes WHILE the byte resolution is outstanding.
    useAccountContextStore.setState({
      accountContext: {
        type: "TEAM",
        teamId: "team-x",
      } satisfies AccountContext,
    });

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    // The retry carries the ORIGINAL context - frozen on the recovery record,
    // never re-read from the ambient store at dispatch time.
    expect(retryFrame.accountContext).toEqual({ type: "PERSONAL" });
    // The live selection is unaffected by the retry - it still reflects the
    // change the user made mid-recovery.
    expect(useAccountContextStore.getState().accountContext).toEqual({
      type: "TEAM",
      teamId: "team-x",
    });
  });

  it("F2 (4b): the retry carries the ORIGINAL sentFromHostId, not the identity the directory resolved during recovery", async () => {
    const hash = await seedConfirmedImage();
    // Sent while this machine's host id was still unknown: the directory
    // seeds the local identity from `null` once the local host enrolls, so
    // a send made early in the app's life names no machine.
    localHostIdMock.value = null;

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.sentFromHostId).toBeNull();

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    // The local identity resolves WHILE the byte resolution is outstanding.
    localHostIdMock.value = "host-local-late";

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    // Frozen on the pending action at send time and carried by the recovery
    // record, exactly like the account context above: the retry is the same
    // logical send, and a re-read here would let the host place a routed
    // realm born on this turn by a machine the user never sent from.
    expect(retryFrame.sentFromHostId).toBeNull();

    // The mock is live, not a constant: a NEW send after the identity
    // resolved names it, so the `null` above is the frozen value and not the
    // reader's default.
    sendHashOnlyMessage(harness, hash);
    const laterFrame = harness.sent[2];
    if (laterFrame.kind !== "send") throw new Error("expected a send frame");
    expect(laterFrame.sentFromHostId).toBe("host-local-late");
  });

  // ─── F3: retry from the wire document ───────────────────────────────────

  it("F3 (5): the retry re-inlines from wireContent, keeping an annotation crop atom restore.content never carried", async () => {
    // Pre-fix, the retry rebuilt from `restore.content` - the hand-back
    // document captured BEFORE the composer appends annotation crop atoms -
    // so a retry silently dropped the crop image. `wireContent` is what
    // actually went on the wire and is what the retry must re-inline from.
    const hash = await seedConfirmedImage();
    const cropB64 = btoa("crop-bytes");
    const wireContent = contentWithCropAtom(hash, cropB64);
    const restoreContent = hashOnlyContent(hash);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendMessageWithContent(
      harness,
      wireContent,
      restoreContent,
    );

    // Positive control: the ORIGINAL send already carried both atoms - this
    // test is measuring a LOSS on retry, not a pre-existing absence.
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(collectImageAtoms(originalFrame.content)).toHaveLength(2);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    const atoms = collectImageAtoms(retryFrame.content);
    expect(atoms).toHaveLength(2);
    // The draft image re-inlined (hash resolved locally).
    const draftAtom = atoms.find((atom) => atom.id === "image-1");
    expect(draftAtom?.hash).toBeFalsy();
    expect(typeof draftAtom?.b64content).toBe("string");
    // The crop atom, which `restore.content` never carried, survived intact.
    const cropAtom = atoms.find((atom) => atom.id === "crop-1");
    expect(cropAtom?.b64content).toBe(cropB64);
  });

  // ─── F4: the host's follow-up errorNotice ───────────────────────────────

  it("F4 (6): the follow-up errorNotice for the action being recovered is suppressed, and the retry succeeds silently", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    // The real host sequence: the rejected ack, THEN a separate errorNotice
    // carrying the same clientActionId.
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code: "MISSING_ATTACHMENT_BYTES",
        message: "Host does not hold this digest.",
        severity: "warning",
        clientActionId,
      },
    });

    expect(harness.handle.store.getState().errorNotices).toHaveLength(0);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    expect(harness.handle.store.getState().errorNotices).toHaveLength(0);
  });

  it("F4 (7): the RETRY's own failure is loud - the suppression is scoped to the action being recovered", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    // The original's own follow-up notice is suppressed.
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code: "MISSING_ATTACHMENT_BYTES",
        message: "Host does not hold this digest.",
        severity: "warning",
        clientActionId,
      },
    });

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");

    // The retry's own new action id gets its OWN follow-up notice - not
    // suppressed, because the recovery slot has been retired by this point.
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code: "MISSING_ATTACHMENT_BYTES",
        message: "Host still does not hold this digest.",
        severity: "warning",
        clientActionId: retryFrame.clientActionId,
      },
    });

    expect(harness.handle.store.getState().errorNotices).toHaveLength(1);
  });

  // ─── R1: the recovery record is a first-class lifecycle citizen ─────────
  //
  // `hashOnlyRecoveries` moved from a single slot to
  // `Record<clientActionId, HashOnlyRecoveryState>`. Every lifecycle consumer
  // that reasons about pending work now has to be TOLD which action ids are
  // recovering, or it re-derives "stranded"/"gone" from `pendingActions`
  // alone - which a recovering send has already left, by design, for the
  // whole of its await.

  it("R1 (1): a settled turn-state frame arriving mid-recovery must not strand the recovering message (DRIVE RED)", async () => {
    // Pre-fix: `reconcileTurnSettled` had no `recoveringActionIds` input, so a
    // `turnStateChanged` frame reporting the turn idle read the recovering
    // optimistic message as STRANDED (its pending action is gone - the
    // settled ack removed it when it forked into recovery) and restored its
    // content to the composer right there, in the same synchronous `set()`.
    // The recovery's own retry then dispatched anyway on top of that: a
    // successful send AND the identical draft handed back to the user.
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // Still recovering: `runHashOnlyInlineRetry`'s own `await` has not
    // resolved yet, so this frame reconciles in the exact window the
    // recovery record exists to cover.
    harness.callbacks().onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
    });

    // Read in the SAME TICK the frame reconciled in, before the retry's own
    // continuation gets a microtask: once it dispatches, the message is no
    // longer stranded by ANY definition, and a later read would pass whether
    // or not the fix is present.
    const duringRecovery = harness.handle.store.getState();
    expect(duringRecovery.failedSendRestoration).toBeNull();
    expect(duringRecovery.pendingUserMessages).toHaveLength(1);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    // Exactly one retry went out - not a second, independent send
    // manufactured by a stray restoration also reaching the composer.
    expect(harness.sent).toHaveLength(2);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
  });

  it("R1 (2): an unrelated queueChanged frame during recovery retains the recovering send's optimistic queue row", async () => {
    // Pre-fix: the `queueChanged` handler's `mergeQueueWithOptimisticQueuedItems`
    // call retained rows only for ids in `pendingActions` - a recovering
    // send's action id is gone by design, so its row was dropped on the very
    // next unrelated queue frame. For a QUEUED send (no transcript echo) that
    // row is the only thing the user can see.
    const hash = await seedConfirmedImage();
    releaseSession(hash);

    harness = createHarness();
    const seed = seedManagedCommandItem("queue-seed-r1-2");
    emitOwnerSnapshot(harness.callbacks(), [seed]);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    const queueItemId = optimisticQueuedItemId(clientActionId);
    expect(
      harness.handle.store
        .getState()
        .queue.items.some((item) => item.queueItemId === queueItemId),
    ).toBe(true);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // An authoritative queue update about the SEEDED command, not this send,
    // arrives while the byte resolution is still outstanding.
    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: { status: "running", items: [seed] },
    });

    const duringRecovery = harness.handle.store.getState();
    expect(
      duringRecovery.queue.items.some(
        (item) => item.queueItemId === queueItemId,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
  });

  it("R1 (3): the chat epic parks only after the recovery settles", async () => {
    // `ChatSessionRegistry.unsettledWorkForEpic` (`session-registry.ts`) is the
    // predicate epic-parking gates a force-dispose on. Its private
    // `hasUnsettledChatWork` reads `state.hashOnlyRecoveries` directly - pre-fix
    // there was no such field to read (a single nullable slot lived alongside
    // `failedSendRestoration`, and before THAT existed at all a recovering send
    // was invisible to this predicate for the whole of its await), so an
    // otherwise-idle recovering chat read as settled and could be force-disposed
    // out from under its outstanding retry.
    const { ChatSessionRegistry } =
      await import("@/stores/chats/session-registry");
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 60 * 60 * 1_000,
      maxWarmSessions: 8,
    });
    const handle = harness.handle;
    registry.acquire(
      {
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "r1-3",
      },
      () => handle,
    );

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    // Otherwise-idle (no pending actions, no accepted actions, no
    // failed-send restoration) except for the outstanding recovery.
    expect(registry.unsettledWorkForEpic(EPIC_ID).unsettled).toBe(true);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);
    // The recovery itself has settled, but the retry it dispatched is now a
    // genuinely new outstanding send - carry IT through to settlement too
    // (accept, then confirm in the transcript) before the positive control
    // means what it claims to mean.
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: retryFrame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    harness.callbacks().onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: retryFrame.messageId,
        sender: retryFrame.sender,
        message: {
          kind: "user",
          content: retryFrame.content,
          browserAnnotations: retryFrame.browserAnnotations,
        },
        timestamp: 4,
        sessionAnchor: null,
      },
    });
    // Positive control: once the recovery AND its retry have both settled,
    // the same otherwise-idle chat reads as settled again.
    expect(registry.unsettledWorkForEpic(EPIC_ID).unsettled).toBe(false);
  });

  it("R1 (4): dispose while a recovery is outstanding hands the prompt back into the still-live store first (DRIVE RED)", async () => {
    // Pre-fix, `dispose()` never called `abandonHashOnlyRecovery`: it tore the
    // store down - unregistering it from `liveChatSessionStores` (the GC root
    // walk) and marking `disposed` - while the recovery record just sat there,
    // unresolved. `runHashOnlyInlineRetry`'s continuation would eventually
    // resume and either write into a store its own UI driver had already
    // unmounted, or (once `disposed` gates its `set()` calls) write nowhere at
    // all - either way the prompt was gone with no trace anywhere.
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // Dispose WHILE the byte resolution is still outstanding - before the
    // retry's own continuation has had a chance to run.
    harness.handle.dispose();

    // The hand-back must have landed SYNCHRONOUSLY, inside `dispose()`,
    // before the store left `liveChatSessionStores` - not by the retry's
    // continuation discovering disposal later.
    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).not.toBeNull();
    expect(state.failedSendRestoration?.content).toEqual(hashOnlyContent(hash));
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);

    // The retry's own continuation resumes later and must find the store
    // already disposed and do nothing further - no third send, no further
    // writes. `afterEach` calling `dispose()` again on an already-disposed
    // store must also stay a no-op.
    const sentBeforeSettle = harness.sent.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.sent).toHaveLength(sentBeforeSettle);
    harness = null; // afterEach must not double-dispose the harness above.
  });

  it("R2 (5): a dispatch refused mid-recovery while another prompt already occupies the restoration slot is stated, not silently destroyed (DRIVE RED)", async () => {
    // Pre-fix (the single-slot era's own bug, which the map's
    // `abandonHashOnlyRecovery` had to fix rather than merely preserve): when
    // the restoration slot was already occupied, the recovery being abandoned
    // was cleared - record, queue row and echo - with NO notice at all. The
    // prompt was destroyed and the user was never told.
    const hashA = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);

    // A: hash-only, recovers silently.
    const a = sendHashOnlyMessage(harness, hashA);
    rejectMissingAttachmentBytes(harness, a.clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    // B: an ordinary (non-hash-only) send, refused loudly - this is what
    // takes the restoration slot while A is still recovering.
    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const b = sendMessageWithContent(harness, plainContent, plainContent);
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: b.clientActionId,
      action: "send",
      status: "rejected",
      reason: "B was not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    const afterB = harness.handle.store.getState();
    expect(afterB.failedSendRestoration?.clientActionId).toBe(b.clientActionId);
    expect(afterB.failedSendRestoration?.content).toEqual(plainContent);

    // A's own dispatch now gets refused - the connection drops while the
    // byte resolution is still outstanding, so `sendAction` refuses A's retry
    // when it finally tries to go out.
    harness.callbacks().onConnectionStatus("reconnecting", null, null);

    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });

    const finalState = harness.handle.store.getState();
    // B's restoration is UNTOUCHED - A's abandonment must not clobber it.
    expect(finalState.failedSendRestoration?.clientActionId).toBe(
      b.clientActionId,
    );
    expect(finalState.failedSendRestoration?.content).toEqual(plainContent);
    // A is not silently destroyed - and "not destroyed" has to mean A's TEXT
    // is still recoverable, not that a sentence about A was shown. The first
    // version of this test asserted only the reason and a generic phrase, so
    // it passed with A's content gone: exactly the failure the reviewer
    // reproduced. The assertion that matters is the prompt itself.
    const aNotice = finalState.errorNotices.find(
      (notice) => notice.clientActionId === a.clientActionId,
    );
    expect(aNotice).toBeDefined();
    expect(aNotice?.message).toContain(A_PROMPT_TEXT);
    // The reason is now a CLAUSE, not a sentence: `unrecoverableSendNotice`
    // opens the statement with it and continues ", and another unsent message
    // is already waiting in the composer", so the trailing period is stripped.
    expect(aNotice?.message).toContain("Host does not hold this digest");
    // And under the durable code, so the last copy survives an unfocused pane
    // and is never evicted from the notice ring before the user sees it.
    expect(aNotice?.code).toBe(SEND_NOT_RECORDED_NOTICE_CODE);
    // A's retry never actually reached the wire.
    expect(harness.sent).toHaveLength(2);
  });

  it("R6 (8): the suppression is scoped to the recovering action id and to a bounded window", async () => {
    // R6: `suppressNoticeAfterDispatch`/`consumeSuppressedNotice`. The host's
    // rejection sequence is the ack, THEN an awaited failure-event append,
    // THEN a separate `errorNotice` - local byte recovery can be fast enough
    // to dispatch the retry BEFORE that notice arrives, by which point the
    // recovery record (the only thing `F4 (6)`'s in-flight suppression could
    // key off) is already gone. Pre-fix, that late notice for a message that
    // actually went through read as an ordinary rejection and surfaced a
    // missing-attachment warning for a successful send.
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    // The recovery record is gone - the retry already dispatched - and ONLY
    // NOW does the original's follow-up notice arrive.
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code: "MISSING_ATTACHMENT_BYTES",
        message: "Host does not hold this digest.",
        severity: "warning",
        clientActionId,
      },
    });
    expect(harness.handle.store.getState().errorNotices).toHaveLength(0);

    // Positive control 1: a notice for an UNRELATED action id, in the same
    // window, is never suppressed - the suppression is per-id, not global.
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code: "SOME_OTHER_CODE",
        message: "An unrelated notice.",
        severity: "warning",
        clientActionId: "unrelated-action-id",
      },
    });
    expect(harness.handle.store.getState().errorNotices).toHaveLength(1);

    // Positive control 2: a second recovery whose suppression window is left
    // to expire before its notice arrives is appended, not swallowed forever.
    // The window is DERIVED from the production constant, not restated - a
    // hard-coded 10_000 here would silently stop testing the boundary the day
    // someone tuned it, which is the failure mode a mirrored literal always
    // has.
    const hash2 = await seedSecondConfirmedImage();
    const second = sendHashOnlyMessage(harness, hash2);
    rejectMissingAttachmentBytes(harness, second.clientActionId, "not-on-host");
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(4);
    });
    await new Promise((resolve) =>
      setTimeout(resolve, POST_DISPATCH_NOTICE_SUPPRESSION_MS + 100),
    );
    harness.callbacks().onErrorNotice({
      kind: "errorNotice",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      notice: {
        code: "MISSING_ATTACHMENT_BYTES",
        message: "Host still does not hold this digest.",
        severity: "warning",
        clientActionId: second.clientActionId,
      },
    });
    expect(harness.handle.store.getState().errorNotices).toHaveLength(2);
  }, 15_000);

  it("R7 (9): a recovering send's browser-annotation crop hash stays rooted for the whole of the await", async () => {
    // Pre-fix, `collectPendingAnnotationImageHashes` (the GC root source for
    // annotation-card bytes) walked `pendingActions`, `pendingUserMessages`
    // and `failedSendRestoration` only - a recovering send's action is gone
    // from `pendingActions` by design, so for the whole of the byte
    // resolution nothing named its annotation crop hash, and a GC sweep run
    // during that window could reclaim the very bytes the retry still needed
    // to re-attach.
    const hash = await seedConfirmedImage();
    const cropHash = "annotation-crop-hash-r7";
    const annotation: BrowserAnnotationRecord = {
      kind: "browser-annotation",
      annotationId: "ann-r7",
      tabId: "tab-1",
      sessionId: "session-1",
      origin: "https://example.com",
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      capturedAt: 1_700_000_000_000,
      comment: "make it pop",
      counts: { elements: 0, regions: 0, strokes: 0 },
      elements: [],
      imageFileName: "crop-r7.png",
      imageHash: cropHash,
      droppedElementCount: 0,
    };

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const wireContent = hashOnlyContent(hash);
    const action = harness.handle.store.getState().sendMessage({
      content: wireContent,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: buildAttachmentsFromJSONContent(wireContent),
      deliveryPolicy: "auto",
      restore: { content: wireContent, browserAnnotations: [annotation] },
    });
    expect(action).not.toBeNull();
    if (action === null) throw new Error("sendMessage was refused");

    // Positive control: rooted before the rejection too (nothing about
    // recovery is required for the ordinary pending-action root).
    expect(landingLiveImageRootHashes().has(cropHash)).toBe(true);

    rejectMissingAttachmentBytes(harness, action.clientActionId, "not-on-host");
    // Read synchronously, in the same tick as the rejection - before the
    // retry's own continuation has a microtask to run.
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    expect(landingLiveImageRootHashes().has(cropHash)).toBe(true);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
  });

  it("R8 (10): a dispatched retry releases the settled action's own staging-revision entry, leaving a newer stage alone", async () => {
    const hashA = await seedConfirmedImage();
    const hashB = await seedSecondConfirmedImage();
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    const intentB: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-b",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    const intentC: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-c",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };

    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);

    // First recovery: nothing re-stages while the retry is outstanding, so
    // the settled action's OWN hand-back is the only thing standing in the
    // slot when the retry dispatches.
    const first = sendHashOnlyMessage(harness, hashA);
    expect(readStagedWorktreeIntent(stagingKey)).toBeNull();
    rejectMissingAttachmentBytes(harness, first.clientActionId, "not-on-host");
    // The worktree re-stage (runs before the hash-only fork) put A back.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    // Pre-fix: nothing released this stale entry, so it stood forever - a
    // LATER displacement could release a binding that belongs to whatever
    // the user has staged since, an ownership mismatch.
    expect(readStagedWorktreeIntent(stagingKey)).toBeNull();

    // Second recovery: this time the user stages a wholesale-different
    // workspace WHILE the byte resolution is still outstanding.
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentB);
    const second = sendHashOnlyMessage(harness, hashB);
    expect(readStagedWorktreeIntent(stagingKey)).toBeNull();
    rejectMissingAttachmentBytes(harness, second.clientActionId, "not-on-host");
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentB);
    useWorktreeIntentStagingStore.getState().setIntent(stagingKey, intentC);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(4);
    });
    // The stale release's recorded revision no longer matches (C's stage
    // bumped it), so the release is a no-op and C survives untouched.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentC);
  });

  it("R9 (11): both queue mutations re-settle the whole-set budget against the LIVE queue, not a stale figure", async () => {
    resetProcessMemoryRuntimeForTests();
    function expectedChatWindowsPlaneBytes(state: ChatSessionState): number {
      return (
        legacyTranscriptResidencyBytes(state.messages, state.events) +
        chatWholeSetSliceBytes({
          queue: state.queue,
          pendingApprovals: state.pendingApprovals,
          pendingFileEditApprovals: state.pendingFileEditApprovals,
          pendingInterviews: state.pendingInterviews,
          backgroundItems: state.backgroundItems,
          managedCommands: state.managedCommands,
        })
      );
    }
    function chatWindowsPlaneSettledBytes(): number {
      const plane = getProcessMemoryAccountant()
        .snapshot()
        .planes.find((p) => p.planeId === BUDGET_PLANE_IDS.chatWindows);
      if (plane === undefined) {
        throw new Error("chat-windows plane is not registered");
      }
      return plane.settledBytes;
    }

    const hashA = await seedConfirmedImage();
    const hashB = await seedSecondConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);

    // Phase 1: repaint. Pre-fix, `runHashOnlyInlineRetry`'s repaint of the
    // queue (removing the settled row, appending the retry's) had no
    // `commitWholeSetSliceBudget()` behind it, so the accountant kept
    // charging this holder the PRE-repaint figure for as long as the chat
    // then stayed quiet on the transcript.
    const a = sendHashOnlyMessage(harness, hashA);
    rejectMissingAttachmentBytes(harness, a.clientActionId, "not-on-host");
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const afterRepaint = harness.handle.store.getState();
    expect(chatWindowsPlaneSettledBytes()).toBe(
      expectedChatWindowsPlaneBytes(afterRepaint),
    );

    // Phase 2: abandonment. Pre-fix, `abandonHashOnlyRecovery`'s two queue
    // writes (removing the optimistic row, and separately the `queue`
    // rewrite baked into its returned patch) had no re-settle either.
    const b = sendHashOnlyMessage(harness, hashB);
    rejectMissingAttachmentBytes(harness, b.clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    harness.callbacks().onConnectionStatus("reconnecting", null, null);
    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });
    const afterAbandon = harness.handle.store.getState();
    expect(chatWindowsPlaneSettledBytes()).toBe(
      expectedChatWindowsPlaneBytes(afterAbandon),
    );
  });

  // ─── T5 follow-ups (RR1-RR7) ─────────────────────────────────────────────

  it("RR1 (DRIVE RED): a chat with a pending hash-only recovery is not evicted by warm-pool overflow, and a reacquire finds it intact", async () => {
    // The guard is `hasActiveWork`, NOT `isEvictable`. That correction is
    // this test's own history: the hold was first written into `isEvictable`,
    // on the belief that the warm-cap walk is the route that asks it. The
    // shared registry filters cap candidates on `hasActiveWork` FIRST, so
    // once the hold was also in `hasActiveWork` - required, because idle
    // expiry reads nothing else - the `isEvictable` clause became
    // unreachable, and this test passed for a reason other than its name.
    // Drive it red by dropping `|| holdsUnrecordedPrompt(handle)` from
    // `hasActiveWork`; dropping anything from `isEvictable` changes nothing.
    //
    // Pre-fix, both were `() => true`: "nothing a chat session holds is lost
    // by disposing it". A recovering send is the counterexample - its prompt is rejected by the host, gone from
    // `pendingActions`, and for the whole of the byte resolution the
    // recovery record is the ONLY copy anywhere. A cap-driven overflow sweep
    // could pick this exact session to dispose, destroying the prompt with
    // no trace and no chance to hand it back.
    const hashA = await seedConfirmedImage();

    harness = createHarness();
    const chatA = harness;
    emitOwnerSnapshot(chatA.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(chatA, hashA);
    rejectMissingAttachmentBytes(chatA, clientActionId, "not-on-host");
    expect(
      Object.keys(chatA.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // An ordinary, otherwise-idle second chat - the only session this cap
    // can legitimately evict.
    const chatBHostId = HOST_ID;
    const chatBEpicId = "epic-rr1-b";
    const chatBChatId = "chat-rr1-b";
    const chatBHandle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: chatBHostId,
      epicId: chatBEpicId,
      chatId: chatBChatId,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: null,
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      }),
    });

    // A cap of 1: a single warm chat is already at the cap, so both tiles
    // unmounting (both leases dropped) forces an overflow sweep that must
    // pick exactly one of the two lease-free sessions to dispose.
    const registry = new ChatSessionRegistry({
      idleTtlMs: 60 * 60 * 1_000,
      maxWarmSessions: 1,
    });
    const targetA: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "rr1",
    };
    const targetB: ChatSessionTarget = {
      epicId: chatBEpicId,
      chatId: chatBChatId,
      hostId: chatBHostId,
      scopeKey: "rr1",
    };
    registry.acquire(targetA, () => chatA.handle);
    registry.acquire(targetB, () => chatBHandle);
    // Both tiles unmount - the last tile referencing each chat releases it.
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);
    registry.release(chatBEpicId, chatBChatId, chatBHostId);

    // A survives - it is the ONLY non-evictable session, so B (with nothing
    // to lose) is the one the cap picks instead.
    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBe(chatA.handle);
    expect(registry.peek(chatBEpicId, chatBChatId, chatBHostId)).toBeNull();

    // Custody after a reacquire: the SAME handle comes back, recovery
    // intact - not a fresh, empty replacement. The factory throwing proves
    // it was never called.
    const reacquired = registry.acquire(targetA, () => {
      throw new Error("must not rebuild - A must still be warm");
    });
    expect(reacquired).toBe(chatA.handle);
    expect(
      Object.keys(reacquired.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    registry.release(EPIC_ID, CHAT_ID, HOST_ID);
    await vi.waitFor(() => {
      expect(chatA.sent).toHaveLength(2);
    });
  });

  it("RRR1 (2, DRIVE RED): a chat whose retry is dispatched but not yet acknowledged is not evicted by warm-pool overflow, and a reacquire finds it intact", async () => {
    // Re-review 3's finding. Drive red via `hasActiveWork`, which is the
    // predicate the cap walk actually reaches (see RR1 above).
    // `holdsUnrecordedPrompt` reads `hashOnlyRecoveries`, which
    // empties the MOMENT the retry is dispatched - before the host has seen
    // it, let alone acknowledged it. Pre-fix, that made A "evictable" for the
    // whole window between dispatch and ack, the same loss RR1 closed for the
    // recovery record itself, one custodian later.
    const hashA = await seedConfirmedImage();

    harness = createHarness();
    const chatA = harness;
    emitOwnerSnapshot(chatA.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(chatA, hashA);
    rejectMissingAttachmentBytes(chatA, clientActionId, "not-on-host");
    await vi.waitFor(() => {
      expect(chatA.sent).toHaveLength(2);
    });
    expect(
      Object.keys(chatA.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);
    const retryFrame = chatA.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    expect(
      Object.values(chatA.handle.store.getState().pendingActions).some(
        (action) => action.hashOnlyRetry,
      ),
    ).toBe(true);

    const chatBEpicId = "epic-rr1-2-b";
    const chatBChatId = "chat-rr1-2-b";
    const chatBHandle = createIdleChatHandle(chatBEpicId, chatBChatId, HOST_ID);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 60 * 60 * 1_000,
      maxWarmSessions: 1,
    });
    const targetA: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "rr1-2",
    };
    const targetB: ChatSessionTarget = {
      epicId: chatBEpicId,
      chatId: chatBChatId,
      hostId: HOST_ID,
      scopeKey: "rr1-2",
    };
    registry.acquire(targetA, () => chatA.handle);
    registry.acquire(targetB, () => chatBHandle);
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);
    registry.release(chatBEpicId, chatBChatId, HOST_ID);

    // A survives - it is the only session still holding an unrecorded
    // prompt, so B (with nothing to lose) is the one the cap picks instead.
    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBe(chatA.handle);
    expect(registry.peek(chatBEpicId, chatBChatId, HOST_ID)).toBeNull();

    const reacquired = registry.acquire(targetA, () => {
      throw new Error("must not rebuild - A must still be warm");
    });
    expect(reacquired).toBe(chatA.handle);
    expect(
      Object.values(reacquired.store.getState().pendingActions).some(
        (action) => action.hashOnlyRetry,
      ),
    ).toBe(true);

    // Positive control: acknowledge the retry - custody has genuinely moved
    // on - then release A again and force another overflow sweep. A is now
    // the OLDEST parked entry, so if it is truly evictable the cap picks it.
    chatA.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: retryFrame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    chatA.callbacks().onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: retryFrame.messageId,
        sender: retryFrame.sender,
        message: {
          kind: "user",
          content: retryFrame.content,
          browserAnnotations: retryFrame.browserAnnotations,
        },
        timestamp: 4,
        sessionAnchor: null,
      },
    });
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);

    const chatCEpicId = "epic-rr1-2-c";
    const chatCChatId = "chat-rr1-2-c";
    const chatCHandle = createIdleChatHandle(chatCEpicId, chatCChatId, HOST_ID);
    const targetC: ChatSessionTarget = {
      epicId: chatCEpicId,
      chatId: chatCChatId,
      hostId: HOST_ID,
      scopeKey: "rr1-2",
    };
    registry.acquire(targetC, () => chatCHandle);
    registry.release(chatCEpicId, chatCChatId, HOST_ID);

    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
  });

  it("RRR1 (3, DRIVE RED): a chat whose failed send is handed back but not yet consumed by the composer is not evicted by warm-pool overflow, and a reacquire finds it intact", () => {
    // Re-review 3's finding: a refused dispatch moves the prompt into
    // `failedSendRestoration` and removes the recovery record in the same
    // step, so the predicate read this as settled even though nobody has
    // copied the restoration into the composer draft store yet. Drive red via
    // `hasActiveWork`, the predicate the cap walk reaches (see RR1 above).
    harness = createHarness();
    const chatA = harness;
    emitOwnerSnapshot(chatA.callbacks(), []);
    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const sentAction = sendMessageWithContent(
      chatA,
      plainContent,
      plainContent,
    );
    chatA.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: sentAction.clientActionId,
      action: "send",
      status: "rejected",
      reason: "A was not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    expect(
      chatA.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(sentAction.clientActionId);

    const chatBEpicId = "epic-rr1-3-b";
    const chatBChatId = "chat-rr1-3-b";
    const chatBHandle = createIdleChatHandle(chatBEpicId, chatBChatId, HOST_ID);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 60 * 60 * 1_000,
      maxWarmSessions: 1,
    });
    const targetA: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "rr1-3",
    };
    const targetB: ChatSessionTarget = {
      epicId: chatBEpicId,
      chatId: chatBChatId,
      hostId: HOST_ID,
      scopeKey: "rr1-3",
    };
    registry.acquire(targetA, () => chatA.handle);
    registry.acquire(targetB, () => chatBHandle);
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);
    registry.release(chatBEpicId, chatBChatId, HOST_ID);

    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBe(chatA.handle);
    expect(registry.peek(chatBEpicId, chatBChatId, HOST_ID)).toBeNull();

    const reacquired = registry.acquire(targetA, () => {
      throw new Error("must not rebuild - A must still be warm");
    });
    expect(reacquired).toBe(chatA.handle);
    expect(reacquired.store.getState().failedSendRestoration).not.toBeNull();

    // Positive control: the composer takes the prompt - custody has
    // genuinely moved on - then release A again and force another overflow
    // sweep. A is now the OLDEST parked entry, so if it is truly evictable
    // the cap picks it.
    reacquired.store
      .getState()
      .ackFailedSendRestoration(sentAction.clientActionId);
    expect(reacquired.store.getState().failedSendRestoration).toBeNull();
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);

    const chatCEpicId = "epic-rr1-3-c";
    const chatCChatId = "chat-rr1-3-c";
    const chatCHandle = createIdleChatHandle(chatCEpicId, chatCChatId, HOST_ID);
    const targetC: ChatSessionTarget = {
      epicId: chatCEpicId,
      chatId: chatCChatId,
      hostId: HOST_ID,
      scopeKey: "rr1-3",
    };
    registry.acquire(targetC, () => chatCHandle);
    registry.release(chatCEpicId, chatCChatId, HOST_ID);

    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
  });

  it("RRR1 (4, DRIVE RED): idle expiry defers disposal while a hash-only recovery is outstanding, and disposes once everything settles", async () => {
    // Re-review 3's second entry to the same loss: the shared registry's
    // `expireIfIdle` never consults `isEvictable` at all - it defers only on
    // `hasActiveWork`, which pre-fix was bare `hasActiveChatWork`. The
    // reviewer's concrete case: a recovery beginning 5s before the idle timer
    // fires is torn down well inside its own 30s recovery deadline.
    const hash = await seedConfirmedImage();
    localImageMocks.getImageBytes.mockImplementation(
      () => new Promise<Uint8Array | undefined>(() => {}),
    );

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 5_000,
      maxWarmSessions: 8,
    });
    const target: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "rr1-4",
    };
    const chatHandle = harness.handle;
    registry.acquire(target, () => chatHandle);

    // Installed BEFORE the rejection - see RR7's own note on why the
    // deadline's `setTimeout` must be armed while fake timers are already
    // active.
    vi.useFakeTimers();
    try {
      rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(1);

      registry.release(EPIC_ID, CHAT_ID, HOST_ID);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).not.toBeNull();
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(1);

      // Let the recovery's own bounded wait time out and dispatch its (bare)
      // retry, then acknowledge that retry - custody has now genuinely moved
      // on past every state this predicate holds for.
      await vi.advanceTimersByTimeAsync(RECOVERY_INLINING_TIMEOUT_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(0);
      expect(harness.sent).toHaveLength(2);
      const retryFrame = harness.sent[1];
      if (retryFrame.kind !== "send") throw new Error("expected a send frame");
      harness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        clientActionId: retryFrame.clientActionId,
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
        token: null,
      });
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: {
          role: "user",
          messageId: retryFrame.messageId,
          sender: retryFrame.sender,
          message: {
            kind: "user",
            content: retryFrame.content,
            browserAnnotations: retryFrame.browserAnnotations,
          },
          timestamp: 4,
          sessionAnchor: null,
        },
      });

      // Positive control: nothing left to hold - the next idle check
      // disposes.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("RRR1 (5, DRIVE RED): idle expiry defers disposal while a dispatched retry is unacknowledged, and disposes once it is acked", async () => {
    const hash = await seedConfirmedImage();

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    expect(
      Object.values(harness.handle.store.getState().pendingActions).some(
        (action) => action.hashOnlyRetry,
      ),
    ).toBe(true);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 5_000,
      maxWarmSessions: 8,
    });
    const target: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "rr1-5",
    };
    const chatHandle = harness.handle;
    registry.acquire(target, () => chatHandle);

    vi.useFakeTimers();
    try {
      registry.release(EPIC_ID, CHAT_ID, HOST_ID);
      // Two windows: still unacknowledged both times.
      vi.advanceTimersByTime(10_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).not.toBeNull();
      expect(
        Object.values(harness.handle.store.getState().pendingActions).some(
          (action) => action.hashOnlyRetry,
        ),
      ).toBe(true);

      // Positive control: acknowledging the retry - custody has moved on.
      harness.callbacks().onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        clientActionId: retryFrame.clientActionId,
        action: "send",
        status: "accepted",
        reason: null,
        code: null,
        backgroundStopTaskIds: [],
        token: null,
      });
      harness.callbacks().onMessageAccepted({
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        message: {
          role: "user",
          messageId: retryFrame.messageId,
          sender: retryFrame.sender,
          message: {
            kind: "user",
            content: retryFrame.content,
            browserAnnotations: retryFrame.browserAnnotations,
          },
          timestamp: 4,
          sessionAnchor: null,
        },
      });
      vi.advanceTimersByTime(5_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("RRR1 (6, DRIVE RED): idle expiry defers disposal while a failed send's prompt is unconsumed, and disposes once the composer takes it", () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const sentAction = sendMessageWithContent(
      harness,
      plainContent,
      plainContent,
    );
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: sentAction.clientActionId,
      action: "send",
      status: "rejected",
      reason: "not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(sentAction.clientActionId);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 5_000,
      maxWarmSessions: 8,
    });
    const target: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "rr1-6",
    };
    const chatHandle = harness.handle;
    registry.acquire(target, () => chatHandle);

    vi.useFakeTimers();
    try {
      registry.release(EPIC_ID, CHAT_ID, HOST_ID);
      vi.advanceTimersByTime(10_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).not.toBeNull();
      expect(
        harness.handle.store.getState().failedSendRestoration,
      ).not.toBeNull();

      // Positive control: the composer driver consumes the restoration.
      harness.handle.store
        .getState()
        .ackFailedSendRestoration(sentAction.clientActionId);
      vi.advanceTimersByTime(5_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("RR2 (DRIVE RED, extends R2 (5)): a dispatch refused mid-recovery while another prompt already occupies the restoration slot is stated with the prompt's own text, not a sentence about it, and does not leave a stale worktree claim behind", async () => {
    // Pre-fix (the single-slot era's own bug, which the map's
    // `abandonHashOnlyRecovery` had to fix rather than merely preserve): when
    // the restoration slot was already occupied, the recovery being
    // abandoned was cleared - record, queue row and echo - with NO notice at
    // all. A second version said the reason but not the TEXT: an
    // `errorNotice` under a code with no retention guarantee, quoting none of
    // the user's draft. `displacedRestorationNotice` is the real last-copy
    // machinery: it quotes the draft verbatim under `SEND_NOT_RECORDED_NOTICE_CODE`.
    const hashA = await seedConfirmedImage();

    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);

    // A: hash-only, recovers silently, under A's own staged worktree pick.
    const a = sendHashOnlyMessage(harness, hashA);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intentA);
    rejectMissingAttachmentBytes(harness, a.clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    // A's own rejection re-staged its pick, ahead of the hash-only fork.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);

    // B: an ordinary (non-hash-only) send, refused loudly - this is what
    // takes the restoration slot while A is still recovering. It reads (and
    // so takes over) whatever the chat's worktree slot currently holds, same
    // as any ordinary send would.
    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const b = sendMessageWithContent(harness, plainContent, plainContent);
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: b.clientActionId,
      action: "send",
      status: "rejected",
      reason: "B was not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    const afterB = harness.handle.store.getState();
    expect(afterB.failedSendRestoration?.clientActionId).toBe(b.clientActionId);
    expect(afterB.failedSendRestoration?.content).toEqual(plainContent);
    // B's own rejection re-staged whatever it carried (A's old pick, since B
    // took it over on dispatch) - it is B's binding now, not A's leftover.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);

    // A's own dispatch now gets refused - the connection drops while the
    // byte resolution is still outstanding, so `sendAction` refuses A's
    // retry when it finally tries to go out.
    harness.callbacks().onConnectionStatus("reconnecting", null, null);

    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });

    const finalState = harness.handle.store.getState();
    // B's restoration is UNTOUCHED - A's abandonment must not clobber it.
    expect(finalState.failedSendRestoration?.clientActionId).toBe(
      b.clientActionId,
    );
    expect(finalState.failedSendRestoration?.content).toEqual(plainContent);
    // A is not silently destroyed - and "not destroyed" has to mean A's TEXT
    // is still recoverable, not that a sentence about A was shown.
    const aNotice = finalState.errorNotices.find(
      (notice) => notice.clientActionId === a.clientActionId,
    );
    expect(aNotice).toBeDefined();
    expect(aNotice?.message).toContain(A_PROMPT_TEXT);
    // The reason is now a CLAUSE, not a sentence: `unrecoverableSendNotice`
    // opens the statement with it and continues ", and another unsent message
    // is already waiting in the composer", so the trailing period is stripped.
    expect(aNotice?.message).toContain("Host does not hold this digest");
    expect(aNotice?.code).toBe(SEND_NOT_RECORDED_NOTICE_CODE);
    // RRR3: and the account tail names A's OWN frozen worktree, so following
    // the notice re-picks the workspace this send actually had. Passing the
    // raw host reason to `displacedRestorationNotice` - which renders no
    // account of its own and expects one already baked in - produced a notice
    // that said the prompt was lost without saying its worktree went too, so
    // a resend would silently run against whatever B staged.
    expect(aNotice?.message).toContain(intentA.entries[0].workspacePath);
    expect(aNotice?.message).toMatch(/pick|worktree/i);
    // A's retry never actually reached the wire.
    expect(harness.sent).toHaveLength(2);
    // Staging bookkeeping: A no longer owns dispatch of the chat's worktree
    // slot (B's own send and rejection already superseded it), so a LATER
    // rejection cannot mistake A for the action still awaiting this slot's
    // outcome. The slot itself is left exactly as B's own re-stage put it -
    // A's abandonment does not touch it.
    expect(
      stagedWorktreeIntentAwaitsDispatchFrom(stagingKey, a.clientActionId),
    ).toBe(false);
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);
  });

  it("RRR3 (extends RR2): when the currently staged worktree DIFFERS from A's frozen pick, the notice names A's frozen one, not the current stage", async () => {
    // RR2's own test never actually exercises a DIVERGENCE: B re-stages
    // exactly A's old pick when it takes over dispatch, so the frozen intent
    // and the current stage read the same either way. This is the case the
    // finding is actually about - `unrecoverableSendNotice` renders A's
    // FROZEN intent, not whatever the chat's worktree slot holds NOW - so a
    // pick made after A's own dispatch but before A's abandonment must not
    // leak into A's notice.
    const hashA = await seedConfirmedImage();

    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    const intentC: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-c",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);

    // A: hash-only, recovers silently, under A's own staged worktree pick.
    const a = sendHashOnlyMessage(harness, hashA);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intentA);
    rejectMissingAttachmentBytes(harness, a.clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // B: an ordinary send, refused loudly - takes the restoration slot and
    // whatever pick was staged (still A's own /repo-a at this point).
    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const b = sendMessageWithContent(harness, plainContent, plainContent);
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: b.clientActionId,
      action: "send",
      status: "rejected",
      reason: "B was not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });

    // The user stages a THIRD pick wholesale, after both A and B have already
    // dispatched under /repo-a - the chat's worktree slot now diverges from
    // A's frozen intent. `setIntent` (not `stageIntent`, which merges) is the
    // wholesale replacement a genuinely different workspace pick makes.
    useWorktreeIntentStagingStore.getState().setIntent(stagingKey, intentC);
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentC);

    // A's own dispatch now gets refused.
    harness.callbacks().onConnectionStatus("reconnecting", null, null);
    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });

    const finalState = harness.handle.store.getState();
    const aNotice = finalState.errorNotices.find(
      (notice) => notice.clientActionId === a.clientActionId,
    );
    expect(aNotice).toBeDefined();
    // Names A's OWN frozen pick, /repo-a - not /repo-c, the pick staged
    // after A's dispatch and still sitting there now.
    expect(aNotice?.message).toContain(intentA.entries[0].workspacePath);
    expect(aNotice?.message).not.toContain(intentC.entries[0].workspacePath);
    // The current stage is untouched by A's abandonment.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentC);
  });

  it("RR5 (1): a dispatched retry takes over dispatch ownership of the staged worktree pick, so a SECOND refusal hands the prompt back WITH it", async () => {
    // Pre-fix, the retry only RELEASED the settled action's staging-revision
    // entry - it never took ownership of the re-staged pick under its own
    // id. `stagedWorktreeIntentAwaitsDispatchFrom(key, retryId)` therefore
    // answered false, so if the retry was ALSO refused, the loud hand-back
    // returned the prompt's TEXT but silently dropped the worktree: for a
    // queued send (the host defers materialization to dequeue) that is the
    // whole exposure - neither attempt ever applied the pick.
    const hash = await seedConfirmedImage();
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), [
      seedManagedCommandItem("queue-seed-rr5-1"),
    ]);
    const first = sendHashOnlyMessage(harness, hash);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intentA);

    rejectMissingAttachmentBytes(harness, first.clientActionId, "not-on-host");
    // A's own rejection re-staged its pick, ahead of the hash-only fork.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    expect(retryFrame.worktreeIntent).toEqual(intentA);
    // The retry now owns dispatch of the pick it carried - the slot reads
    // "consumed", not "staged", and by the retry's OWN action id.
    expect(
      stagedWorktreeIntentAwaitsDispatchFrom(
        stagingKey,
        retryFrame.clientActionId,
      ),
    ).toBe(true);
    expect(readStagedWorktreeIntent(stagingKey)).toBeNull();

    // The retry is now ALSO refused - marked `hashOnlyRetry`, so this goes
    // to the ordinary (loud) path rather than a second silent retry.
    rejectMissingAttachmentBytes(
      harness,
      retryFrame.clientActionId,
      "not-on-host",
    );

    const finalState = harness.handle.store.getState();
    // The loud hand-back returns the prompt's TEXT...
    expect(finalState.failedSendRestoration?.content).toEqual(
      hashOnlyContent(hash),
    );
    // ...WITH the worktree pick this send was made under - not silently
    // dropped.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);
  });

  it("RR5 (2): a worktree stage made DURING the recovery is left untouched, and the retry does not claim dispatch ownership of it", async () => {
    const hash = await seedConfirmedImage();
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    const intentB: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-b",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentA);

    // The user stages a wholesale-different workspace WHILE the retry's byte
    // resolution is still outstanding. `setIntent` bumps the revision, so
    // the retry's post-dispatch consume below must not claim this pick.
    useWorktreeIntentStagingStore.getState().setIntent(stagingKey, intentB);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    // The retry still carries the ORIGINAL pick - frozen on the recovery
    // record, never re-read from the staging store at dispatch time.
    expect(retryFrame.worktreeIntent).toEqual(intentA);
    // B is untouched, and the retry does not own dispatch of it - the
    // revision mismatch correctly declines to claim a pick it never staged.
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentB);
    expect(
      stagedWorktreeIntentAwaitsDispatchFrom(
        stagingKey,
        retryFrame.clientActionId,
      ),
    ).toBe(false);
  });

  it("RR7 (DRIVE RED): a non-settling LOCAL image read is bounded by RECOVERY_INLINING_TIMEOUT_MS, not left to hang forever", async () => {
    // Pre-fix, `reinlineRefusedSendContent` awaited `prepareDraftImageInlining`
    // with no deadline: a stalled `getImageBytes` (the local leg's first
    // step, with no host client to fall back to in this suite) meant the
    // whole recovery - its GC roots, queue row, reconciliation exemption and
    // (since RR1) its warm-eviction hold - never terminated.
    const hash = await seedConfirmedImage();
    localImageMocks.getImageBytes.mockImplementation(
      () => new Promise<Uint8Array | undefined>(() => {}),
    );

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    // Installed BEFORE the rejection: `runHashOnlyInlineRetry`'s async chain
    // runs synchronously up to its first genuine await, so the deadline's
    // `setTimeout` is armed inside the SAME synchronous call as
    // `rejectMissingAttachmentBytes` below. Fake timers must already be
    // active when that happens, or the real timer it registers is immune to
    // every `advanceTimersByTimeAsync` call that follows.
    vi.useFakeTimers();
    try {
      rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(1);

      // Positive control: well before the deadline, the recovery is STILL
      // outstanding - the stall genuinely blocks it; the wait does not
      // resolve on its own.
      await vi.advanceTimersByTimeAsync(RECOVERY_INLINING_TIMEOUT_MS - 1_000);
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(1);
      expect(harness.sent).toHaveLength(1);

      // At the deadline, the bounded wait resolves and the recovery
      // terminates - carrying whatever legs answered (none, here). Several
      // microtask hops separate the timer firing from the retry's dispatch
      // (`withResolvedDeadline` resolves, `reinlineRefusedSendContent`
      // returns, `runHashOnlyInlineRetry` resumes and calls `sendAction`), so
      // the advance is followed by explicit microtask flushes rather than a
      // single one.
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);
    expect(harness.sent).toHaveLength(2);
    const retryFrame = harness.sent[1];
    if (retryFrame.kind !== "send") throw new Error("expected a send frame");
    // Unresolved: the local leg never answered, so the digest still travels
    // bare - the host's own dangling-hash guard is the remaining authority.
    const node = retryFrame.content.content?.at(0);
    expect(node?.attrs?.hash).toBe(hash);

    // The recovery-specific holds go with the record, and that is the whole
    // claim: the eviction hold, the GC roots, the reconciliation exemption and
    // the parking hold all key on `hashOnlyRecoveries`, which is now empty.
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(0);
    // Asserting "roots released" and "parking released" DIRECTLY is not
    // possible here, and the reason is worth stating rather than papering:
    // this deadline ends in a DISPATCH, and the retry's own pending action
    // legitimately re-roots the same hash and legitimately holds parking as an
    // outstanding send. Both would read as held for a completely correct
    // reason. The same trap caught an earlier round's parking test. What is
    // distinguishable is the record itself, above.
  }, 15_000);

  it("RRR2 (DRIVE RED): the shared deadline inlines whichever hash resolved and leaves only the stalled one bare, in the SAME document", async () => {
    // Re-review 3's finding: pre-fix, `prepareDraftImageInlining`'s single
    // all-or-nothing `commit` only ran once its WHOLE batch settled, so a
    // deadline firing while hash B was stalled harvested an EMPTY map -
    // hash A, which had resolved in milliseconds, went out bare beside B and
    // forced a second refusal the host could have been spared entirely.
    const hashA = await seedConfirmedImage();
    const hashB = await seedSecondConfirmedImage();
    const resolveBRef: {
      current: ((bytes: Uint8Array | undefined) => void) | null;
    } = { current: null };
    localImageMocks.getImageBytes.mockImplementation((hash) => {
      if (hash === hashB) {
        return new Promise<Uint8Array | undefined>((resolve) => {
          resolveBRef.current = resolve;
        });
      }
      if (localImageMocks.realGetImageBytes === null) {
        throw new Error("expected the real getImageBytes to be captured");
      }
      return localImageMocks.realGetImageBytes(hash);
    });

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const content = twoHashOnlyContent(hashA, hashB);
    const { clientActionId } = sendMessageWithContent(
      harness,
      content,
      content,
    );

    // Installed BEFORE the rejection - see RR7's own note on why the
    // deadline's `setTimeout` must be armed while fake timers are already
    // active.
    vi.useFakeTimers();
    try {
      rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(RECOVERY_INLINING_TIMEOUT_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.sent).toHaveLength(2);
      const retryFrame = harness.sent[1];
      if (retryFrame.kind !== "send") throw new Error("expected a send frame");
      const nodeA = retryFrame.content.content?.find(
        (node) => node.attrs?.id === "image-a",
      );
      const nodeB = retryFrame.content.content?.find(
        (node) => node.attrs?.id === "image-b",
      );
      // A resolved in time - inlined, hash attr dropped.
      expect(nodeA?.attrs?.hash).toBeUndefined();
      expect(typeof nodeA?.attrs?.b64content).toBe("string");
      // B never answered - left bare for the host's own dangling-hash guard.
      expect(nodeB?.attrs?.hash).toBe(hashB);
      expect(nodeB?.attrs?.b64content).toBeUndefined();

      // A late completion of B must not mutate the document already sent,
      // nor trigger a second send: nothing reads the resolved-bytes map once
      // the deadline has already returned it.
      const sentBeforeLateCompletion = harness.sent.length;
      const contentBeforeLateCompletion = retryFrame.content;
      resolveBRef.current?.(new Uint8Array([9, 9, 9, 9, 9]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.sent).toHaveLength(sentBeforeLateCompletion);
      expect(retryFrame.content).toBe(contentBeforeLateCompletion);
    } finally {
      vi.useRealTimers();
    }
  });

  it("P3: a recovering QUEUED send's browser-annotation crop hash is rooted with no other owner standing - only the recovery branch can be the source", async () => {
    // The crop-root test above (R7 (9)) uses an idle send whose optimistic
    // echo already roots the crop via `pendingUserMessages`, so it never
    // exercises the NEW recovery branch `collectPendingAnnotationImageHashes`
    // gained for this round. A QUEUED send has no echo at all, so once the
    // settled action leaves `pendingActions` the recovery record is
    // provably the only thing left that could be naming this hash.
    const hash = await seedConfirmedImage();
    const cropHash = "annotation-crop-hash-p3";
    const annotation: BrowserAnnotationRecord = {
      kind: "browser-annotation",
      annotationId: "ann-p3",
      tabId: "tab-1",
      sessionId: "session-1",
      origin: "https://example.com",
      pageUrl: "https://example.com/",
      pageTitle: "Example",
      capturedAt: 1_700_000_000_000,
      comment: "make it pop",
      counts: { elements: 0, regions: 0, strokes: 0 },
      elements: [],
      imageFileName: "crop-p3.png",
      imageHash: cropHash,
      droppedElementCount: 0,
    };

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), [
      seedManagedCommandItem("queue-seed-p3"),
    ]);
    const wireContent = hashOnlyContent(hash);
    const action = harness.handle.store.getState().sendMessage({
      content: wireContent,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: buildAttachmentsFromJSONContent(wireContent),
      deliveryPolicy: "auto",
      restore: { content: wireContent, browserAnnotations: [annotation] },
    });
    expect(action).not.toBeNull();
    if (action === null) throw new Error("sendMessage was refused");

    // The QUEUED shape: no optimistic transcript echo at all.
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(0);

    rejectMissingAttachmentBytes(harness, action.clientActionId, "not-on-host");
    const duringRecovery = harness.handle.store.getState();
    expect(Object.keys(duringRecovery.hashOnlyRecoveries)).toHaveLength(1);
    // Every other owner `collectPendingAnnotationImageHashes` walks is
    // explicitly absent, so the root check below cannot be credited to one
    // of them by accident.
    expect(
      Object.hasOwn(duringRecovery.pendingActions, action.clientActionId),
    ).toBe(false);
    expect(duringRecovery.pendingUserMessages).toHaveLength(0);
    expect(duringRecovery.failedSendRestoration).toBeNull();

    expect(landingLiveImageRootHashes().has(cropHash)).toBe(true);

    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
  });

  it("R4F2 (6, DRIVE RED): two concurrent recoveries abandoned at disposal both reach the prompt stash, not just the one that won the restoration slot", async () => {
    // `abandonAllHashOnlyRecoveries` gives the restoration SLOT to only one of
    // two simultaneously-abandoned recoveries; the loser's prompt exists only
    // inside an `errorNotice`'s rendered MESSAGE STRING from that point on -
    // no document behind it. A handoff that stashes only
    // `state.failedSendRestoration` (the winner) passes an "the stash has an
    // entry" assertion while silently dropping the loser's text forever.
    const hashA = await seedConfirmedImage();
    const hashB = await seedSecondConfirmedImage();
    const TEXT_A = "recovery A's own unsent prompt";
    const TEXT_B = "recovery B's own unsent prompt";

    // Never resolves: both recoveries stay outstanding for the whole test: a
    // dispatched retry would retire its record before disposal ever runs.
    localImageMocks.getImageBytes.mockImplementation(
      () => new Promise<Uint8Array | undefined>(() => {}),
    );

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const a = sendMessageWithContent(
      harness,
      hashOnlyContentWithText(hashA, TEXT_A),
      hashOnlyContentWithText(hashA, TEXT_A),
    );
    const b = sendMessageWithContent(
      harness,
      hashOnlyContentWithText(hashB, TEXT_B),
      hashOnlyContentWithText(hashB, TEXT_B),
    );
    rejectMissingAttachmentBytes(harness, a.clientActionId, "not-on-host");
    rejectMissingAttachmentBytes(harness, b.clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(2);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    harness.handle.dispose();

    // Exactly one of the two could take the single restoration slot; the
    // other is the "displaced" loser this round's finding is about.
    const afterDispose = harness.handle.store.getState();
    expect(afterDispose.failedSendRestoration).not.toBeNull();
    const winnerId = afterDispose.failedSendRestoration?.clientActionId;
    expect([a.clientActionId, b.clientActionId]).toContain(winnerId);
    const loserId =
      winnerId === a.clientActionId ? b.clientActionId : a.clientActionId;
    const loserNotice = afterDispose.errorNotices.find(
      (notice) => notice.clientActionId === loserId,
    );
    expect(loserNotice).toBeDefined();

    // BOTH documents were handed to the stash, each with its own trailing
    // qualification paragraph - not one entry, and not a bare "save was
    // called".
    // On the SET of documents, never on a call count. Two reasons, and the
    // second is the one that bit: the count is what a "the stash has an
    // entry" assertion degenerates into, and it cannot tell the winner from
    // the loser; and the handoff is now asynchronous - it resolves images
    // before saving - so a PREVIOUS test's teardown can land its save inside
    // this one, making any exact count a flake.
    const stashedTexts = (): ReadonlyArray<string> =>
      handedOffDrafts().map((draft) => draftPlainText(draft.content));
    await vi.waitFor(
      () => {
        expect(stashedTexts().some((text) => text.includes(TEXT_A))).toBe(true);
        expect(stashedTexts().some((text) => text.includes(TEXT_B))).toBe(true);
      },
      // These recoveries' image reads never settle, so each handoff waits out
      // its own deadline before saving the text alone. DERIVED from the
      // production constant: a restated literal would silently become a flake
      // the day that window moves.
      // Both handoffs run concurrently, so the wait is one deadline, not two -
      // the doubling is headroom for a loaded machine, not a second window.
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
    for (const text of stashedTexts()) {
      expect(text).toContain("Unsent");
    }
  });

  it("R4F2(a): abandoning a recovery on a FREE restoration slot states the worktree clause in `reason` (handed back) and in `displacedReason` (not), matching `deadSendAccountClauses`", async () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-free-slot",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    const hash = await seedConfirmedImage();
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    // The connection drops while the retry's byte resolution is still
    // outstanding, so `sendAction` refuses it - onto a FREE restoration slot.
    harness.callbacks().onConnectionStatus("reconnecting", null, null);
    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.clientActionId).toBe(clientActionId);

    // Derived, not restated: the same account the production code builds -
    // survivors only (nothing was swept), no settings/account drift (neither
    // was ever touched), `auto` delivery.
    const account: DeadSendAccount = {
      worktree: { survivors: intentA, swept: null, superseded: false },
      sentSettings: SETTINGS,
      currentSettings: state.currentComposerSettings,
      sentAccountContext: useAccountContextStore.getState().accountContext,
      currentAccountContext: useAccountContextStore.getState().accountContext,
      sentDeliveryPolicy: "auto",
    };
    const expectedReason = `Host does not hold this digest.${deadSendAccountClauses(account, true)}`;
    const expectedDisplacedReason = `Host does not hold this digest.${deadSendAccountClauses(account, false)}`;

    expect(state.failedSendRestoration?.reason).toBe(expectedReason);
    expect(state.failedSendRestoration?.displacedReason).toBe(
      expectedDisplacedReason,
    );
    // The axis actually predicts a DIFFERENT string here: handed back, the
    // survivor binding needs no re-picking and gets no worktree clause at
    // all; not handed back, the user is told to re-pick it.
    expect(state.failedSendRestoration?.reason).not.toBe(
      state.failedSendRestoration?.displacedReason,
    );
    expect(state.failedSendRestoration?.reason).not.toContain(
      "/repo-free-slot",
    );
    expect(state.failedSendRestoration?.displacedReason).toContain(
      "/repo-free-slot",
    );
  });

  it("R4F2(b) (DRIVE RED): sweep evidence recorded while the slot was consumed survives the user staging a new folder before the recovery is abandoned", async () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    // `kind: "import"` on purpose: `worktreeFolderIntentReferencesRemoved`
    // (the function a sweep's removal set is tested against) only ever
    // matches `import` and `worktree` entries - a `local` entry is an
    // ordinary already-existing checkout Sweep never touches, so it can
    // NEVER be reported swept, and this whole mechanism would never fire for
    // one.
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: "/repo-a",
          worktreePath: "/repo-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    const hash = await seedConfirmedImage();
    // Never resolves: the recovery must still be outstanding when we abandon
    // it directly through disposal below.
    localImageMocks.getImageBytes.mockImplementation(
      () => new Promise<Uint8Array | undefined>(() => {}),
    );

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intentA);

    // A sweep removes the whole worktree WHILE the original send's dispatch
    // still holds the slot's consumption mark (before its own rejection is
    // processed) - the only window this mechanism can ever observe a sweep
    // in, since every ordinary mutation that resolves the slot drops the
    // evidence again.
    const removed: RemovedWorktreeRefs = {
      worktreePaths: new Set(["/repo-a"]),
      branches: [],
    };
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, removed);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    const recoveries = harness.handle.store.getState().hashOnlyRecoveries;
    expect(Object.keys(recoveries)).toHaveLength(1);
    // The session ledger holds it, and nothing below can take it back.
    expect(sessionSweptRefsForHost(HOST_ID)?.worktreePaths.has("/repo-a")).toBe(
      true,
    );

    // The user stages an entirely different folder - an ordinary thing to do
    // mid-recovery - which drops the staging store's OWN sweep-evidence
    // record for this key.
    const intentB: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-b",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentB);
    expect(readStagedWorktreeIntent(stagingKey)).toEqual(intentB);

    harness.handle.dispose();

    const finalState = harness.handle.store.getState();
    expect(finalState.failedSendRestoration).not.toBeNull();
    // The statement rests on the FROZEN evidence, not on the staging
    // store's now-empty live record: it still says the directory is gone.
    expect(finalState.failedSendRestoration?.reason).toContain(
      "no longer exists",
    );
    expect(finalState.failedSendRestoration?.reason).toContain("/repo-a");
  });

  it("R4F1 (cap overflow, DRIVE RED): a chat holding an undelivered last-copy notice is not evicted by warm-pool overflow, and delivering the notice releases the hold", async () => {
    const hashA = await seedConfirmedImage();

    harness = createHarness();
    const chatA = harness;
    emitOwnerSnapshot(chatA.callbacks(), []);
    const a = sendHashOnlyMessage(chatA, hashA);
    rejectMissingAttachmentBytes(chatA, a.clientActionId, "not-on-host");
    expect(
      Object.keys(chatA.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // B takes the restoration slot loudly, forcing A's own eventual
    // abandonment onto the notice-only path (state d).
    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const b = sendMessageWithContent(chatA, plainContent, plainContent);
    chatA.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: b.clientActionId,
      action: "send",
      status: "rejected",
      reason: "B was not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });
    expect(
      chatA.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(b.clientActionId);

    chatA.callbacks().onConnectionStatus("reconnecting", null, null);
    await vi.waitFor(() => {
      expect(
        Object.keys(chatA.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(0);
    });
    const aNotice = chatA.handle.store
      .getState()
      .errorNotices.find(
        (notice) => notice.clientActionId === a.clientActionId,
      );
    expect(aNotice).toBeDefined();
    if (aNotice === undefined) throw new Error("expected A's notice");
    expect(
      chatA.handle.store
        .getState()
        .deliveredLastCopyActionIds.has(a.clientActionId),
    ).toBe(false);
    // B's own hand-back is a SEPARATE hold (state b) on the same store - the
    // composer consumes it here so only A's undelivered notice (state d) is
    // left standing for the rest of this test to isolate.
    chatA.handle.store.getState().ackFailedSendRestoration(b.clientActionId);
    expect(chatA.handle.store.getState().failedSendRestoration).toBeNull();

    const chatBEpicId = "epic-r4f1-d-b";
    const chatBChatId = "chat-r4f1-d-b";
    const chatBHandle = createIdleChatHandle(chatBEpicId, chatBChatId, HOST_ID);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 60 * 60 * 1_000,
      maxWarmSessions: 1,
    });
    const targetA: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "r4f1-d",
    };
    const targetB: ChatSessionTarget = {
      epicId: chatBEpicId,
      chatId: chatBChatId,
      hostId: HOST_ID,
      scopeKey: "r4f1-d",
    };
    registry.acquire(targetA, () => chatA.handle);
    registry.acquire(targetB, () => chatBHandle);
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);
    registry.release(chatBEpicId, chatBChatId, HOST_ID);

    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBe(chatA.handle);
    expect(registry.peek(chatBEpicId, chatBChatId, HOST_ID)).toBeNull();

    const reacquired = registry.acquire(targetA, () => {
      throw new Error("must not rebuild - A must still be warm");
    });
    expect(reacquired).toBe(chatA.handle);

    // Positive control: delivering the notice (the toast layer marks it once
    // shown) - custody has genuinely moved on.
    reacquired.store.getState().markNoticeDelivered(aNotice);
    expect(
      reacquired.store
        .getState()
        .deliveredLastCopyActionIds.has(a.clientActionId),
    ).toBe(true);
    registry.release(EPIC_ID, CHAT_ID, HOST_ID);

    const chatCEpicId = "epic-r4f1-d-c";
    const chatCChatId = "chat-r4f1-d-c";
    const chatCHandle = createIdleChatHandle(chatCEpicId, chatCChatId, HOST_ID);
    const targetC: ChatSessionTarget = {
      epicId: chatCEpicId,
      chatId: chatCChatId,
      hostId: HOST_ID,
      scopeKey: "r4f1-d",
    };
    registry.acquire(targetC, () => chatCHandle);
    registry.release(chatCEpicId, chatCChatId, HOST_ID);

    expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
  });

  it("R4F1 (idle expiry, DRIVE RED): idle expiry defers disposal while an undelivered last-copy notice is outstanding, and disposes once it is delivered", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const hashA = await seedConfirmedImage();
    const a = sendHashOnlyMessage(harness, hashA);
    rejectMissingAttachmentBytes(harness, a.clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    const plainContent: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "plain send" }] },
      ],
    };
    const b = sendMessageWithContent(harness, plainContent, plainContent);
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: b.clientActionId,
      action: "send",
      status: "rejected",
      reason: "B was not accepted.",
      code: null,
      backgroundStopTaskIds: [],
      token: null,
    });

    harness.callbacks().onConnectionStatus("reconnecting", null, null);
    await vi.waitFor(() => {
      expect(
        Object.keys(harness?.handle.store.getState().hashOnlyRecoveries ?? {}),
      ).toHaveLength(0);
    });
    const aNotice = harness.handle.store
      .getState()
      .errorNotices.find(
        (notice) => notice.clientActionId === a.clientActionId,
      );
    expect(aNotice).toBeDefined();
    if (aNotice === undefined) throw new Error("expected A's notice");
    // B's own hand-back is a SEPARATE hold (state b) on the same store - the
    // composer consumes it here so only A's undelivered notice (state d) is
    // left standing for the rest of this test to isolate.
    harness.handle.store.getState().ackFailedSendRestoration(b.clientActionId);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    const registry = new ChatSessionRegistry({
      idleTtlMs: 5_000,
      maxWarmSessions: 8,
    });
    const target: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "r4f1-d-idle",
    };
    const chatHandle = harness.handle;
    registry.acquire(target, () => chatHandle);

    vi.useFakeTimers();
    try {
      registry.release(EPIC_ID, CHAT_ID, HOST_ID);
      vi.advanceTimersByTime(10_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).not.toBeNull();

      // Positive control: the toast layer delivers the notice.
      harness.handle.store.getState().markNoticeDelivered(aNotice);
      vi.advanceTimersByTime(5_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R4F1 (deferral cap, DRIVE RED): past MAX_ACTIVE_CHAT_IDLE_DEFER_MS the session is disposed even mid-recovery, and the still-unrecorded prompt reaches the prompt stash with its content and workspace qualification", async () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-cap",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    const hash = await seedConfirmedImage();
    // Never resolves: the recovery must still be outstanding all the way to
    // the deferral cap - a longer timer is not a handoff, so nothing short
    // of the durable stash write may substitute for it here.
    localImageMocks.getImageBytes.mockImplementation(
      () => new Promise<Uint8Array | undefined>(() => {}),
    );

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks(), []);
    const { clientActionId } = sendHashOnlyMessage(harness, hash);

    const registry = new ChatSessionRegistry({
      idleTtlMs: 5_000,
      maxWarmSessions: 8,
    });
    const target: ChatSessionTarget = {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: HOST_ID,
      scopeKey: "r4f1-cap",
    };
    const chatHandle = harness.handle;
    registry.acquire(target, () => chatHandle);

    vi.useFakeTimers();
    try {
      rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
      expect(
        Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
      ).toHaveLength(1);

      registry.release(EPIC_ID, CHAT_ID, HOST_ID);
      // Well inside the cap: still held. (The recovery's OWN 30s bounded wait
      // elapses long before the cap and dispatches a bare retry, which then
      // sits unacknowledged forever - custody moves from `hashOnlyRecoveries`
      // to a `hashOnlyRetry`-marked pending action, but the hold itself does
      // not lift; that is state (c), not (a), and this assertion is
      // deliberately state-agnostic about which one is currently holding.)
      await vi.advanceTimersByTimeAsync(MAX_ACTIVE_CHAT_IDLE_DEFER_MS - 10_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).not.toBeNull();

      // Past the cap: disposed regardless of `hasActiveWork`.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();

      // And the custody is genuinely gone from the session plane rather than
      // parked somewhere a reacquire would find: the next acquire REBUILDS.
      // That is what makes the stash write below the only remaining copy, and
      // it is the half a `peek` alone cannot establish.
      let rebuilt = false;
      registry.acquire(target, () => {
        rebuilt = true;
        return createIdleChatHandle(EPIC_ID, CHAT_ID, HOST_ID);
      });
      expect(rebuilt).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // The durable handoff - not merely a longer hold: the still-unrecorded
    // prompt reached the stash with its own content and the trailing
    // qualification paragraph naming the workspace it was written for.
    // Derived, with headroom: this recovery's image read never settles, so the
    // handoff waits out its own deadline before saving the text alone.
    // `vi.waitFor`'s 1s default is shorter than that window, which made this
    // fail for a reason that had nothing to do with what it asserts.
    await vi.waitFor(
      () => {
        expect(handedOffDrafts()).toHaveLength(1);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
    const text = draftPlainText(handedOffDrafts()[0].content);
    expect(text).toContain(A_PROMPT_TEXT);
    expect(text).toContain("Unsent");
    expect(text).toContain("/repo-cap");
  });
});
