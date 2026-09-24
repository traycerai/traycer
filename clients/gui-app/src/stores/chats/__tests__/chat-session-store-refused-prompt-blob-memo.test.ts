import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { SEND_NOT_RECORDED_NOTICE_CODE } from "@/stores/chats/chat-queue-reconciler";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { useAuthStore } from "@/stores/auth/auth-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  isDraftBlobConfirmed,
  isDraftBlobUnbridgeable,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { confirmAttachmentsByHash } from "@/lib/composer/attachments-by-hash";

/**
 * The loop that breaks when a refused prompt comes back to the composer.
 *
 * `confirmedBlobsByHost` remembers that a host acked a digest, and the submit
 * path skips the upload for anything it holds. The host's staging tier sweeps
 * on quota and idle age, so that memo can outlive the bytes. That is not one
 * lost message but a cycle with no exit: the refusal hands the prompt back, the
 * prompt carries the same hashes, the memo still says confirmed, and the resend
 * uploads nothing and is refused again.
 *
 * THESE CASES DRIVE THE REFUSAL, they do not call a restore door. That
 * distinction is the whole reason the suite is shaped this way. A missing hash
 * is refused at `handleSend`'s chokepoint
 * (`chat-session-manager.ts:~24774`), which rejects the send FRAME with
 * `eventType: "send.failed"` - so it arrives as a rejected `actionAck`, and NOT
 * as the `setup.failed` event that drives `takeSetupFailedRestoration`. The
 * first version of this fix sat on that setup door and its test called the door
 * directly, so it passed while the arm the refusal actually opens retracted
 * nothing.
 *
 * The full enumeration of arms, and why the queued drain is not one of them,
 * lives on `forgetRefusedContentBlobAcks` in the store.
 */

const EPIC_ID = "epic-blob-memo";
const CHAT_ID = "chat-blob-memo";
const OWNER_ID = "owner-blob-memo";
const HOST_ID = "host-a";

/** A real-looking digest: the upload keys its idempotency on the hash itself. */
const SHA256 =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
  identityId: null,
};

/** Hash-only, which is what every composer produces now. */
const HASH_ONLY_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-1",
            fileName: "shot.png",
            mimeType: "image/png",
            size: IMAGE_BYTES.length,
            byHashEligible: true,
            hash: SHA256,
          },
        },
        { type: "text", text: "look at this" },
      ],
    },
  ],
};

vi.mock("@/lib/composer/landing-image-store", () => ({
  getImageBytes: (hash: string) =>
    Promise.resolve(hash === SHA256 ? IMAGE_BYTES : undefined),
  putImageBytesAtHash: () => Promise.resolve(true),
  // Not used by anything this file drives, and still required: this factory is
  // built from scratch rather than spread over `importOriginal`, so every
  // export the module has must appear here or the importer gets `undefined`.
  // `landing-image-gc.reconcile` awaits this one on its startup sweep and threw
  // "No ... export is defined on the mock" in every suite that mocks the module
  // this way - a warn rather than a failure, because the sweep is `void`ed with
  // a `.catch`, which is exactly why it survived unnoticed.
  ensureMeasuredImageSizes: () => Promise.resolve(),
}));

interface UploadClient {
  readonly client: DraftBlobClient;
  readonly putCalls: ReadonlyArray<string>;
}

/** A client whose `drafts.putBlob` always acks, recording each digest. */
function uploadClient(): UploadClient {
  const putCalls: string[] = [];
  const requestWithOptions = ((
    method: string,
    params: { readonly sha256: string },
  ) => {
    if (method !== "drafts.putBlob") return Promise.resolve({});
    putCalls.push(params.sha256);
    return Promise.resolve({ ok: true });
  }) as HostRequester<HostRpcRegistry>["requestWithOptions"];
  const request = (() =>
    Promise.resolve({})) as HostRequester<HostRpcRegistry>["request"];
  return { client: { request, requestWithOptions }, putCalls };
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
  callbacks.onSnapshot({
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
        kind: "conversation",
        evolutionTurnsSinceReview: null,
      },
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

interface SentFrame {
  readonly messageId: string;
  readonly clientActionId: string;
}

function sendHashOnlyMessage(harness: Harness): SentFrame {
  harness.handle.store.getState().sendMessage({
    content: HASH_ONLY_CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(HASH_ONLY_CONTENT),
    deliveryPolicy: "auto",
    restore: { content: HASH_ONLY_CONTENT, browserAnnotations: [] },
  });
  const sent = harness.sent.at(-1);
  if (sent === undefined || sent.kind !== "send") {
    throw new Error("expected a send frame");
  }
  return { messageId: sent.messageId, clientActionId: sent.clientActionId };
}

/**
 * The host refusing a hash it cannot resolve, as it actually arrives.
 *
 * `handleSend`'s dangling-hash chokepoint rejects the send FRAME with this
 * code (`chat-session-manager.ts:~24774`), so what the renderer sees is a
 * rejected `actionAck` - NOT a `setup.failed` event. Driving the ack rather
 * than calling a restore door directly is the whole point of these cases: the
 * first version of this fix sat on the setup door, which no missing-bytes
 * refusal reaches, and its test passed because it called that door itself.
 */
function rejectSendForMissingBytes(harness: Harness, frame: SentFrame): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: frame.clientActionId,
    action: "send",
    status: "rejected",
    reason:
      "One or more attached images are unavailable in this workspace. Remove them and re-attach, or re-paste the image directly.",
    code: "MISSING_ATTACHMENT_BYTES",
    backgroundStopTaskIds: [],
    token: null,
  });
}

/**
 * An EDIT-AND-RESEND of the same hash-only document.
 *
 * Its pending record carries `restore: null` - an edit re-opens its own editor
 * rather than handing a draft back to the composer - which is exactly why the
 * memo retraction cannot be keyed off `restore`.
 */
function editHashOnlyMessage(harness: Harness): SentFrame {
  harness.handle.store.getState().editUserMessage({
    targetMessageId: "persistent-message-1",
    content: HASH_ONLY_CONTENT,
    sender: { type: "user", userId: OWNER_ID },
    settings: SETTINGS,
    revertFileChanges: false,
    revertArtifacts: false,
  });
  const sent = harness.sent.at(-1);
  if (sent === undefined || sent.kind !== "editUserMessage") {
    throw new Error("expected an editUserMessage frame");
  }
  return { messageId: sent.messageId, clientActionId: sent.clientActionId };
}

function rejectEditForMissingBytes(harness: Harness, frame: SentFrame): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: frame.clientActionId,
    action: "editUserMessage",
    status: "rejected",
    reason:
      "One or more attached images are unavailable in this workspace. Remove them and re-attach, or re-paste the image directly.",
    code: "MISSING_ATTACHMENT_BYTES",
    backgroundStopTaskIds: [],
    token: null,
  });
}

/**
 * A refused SEND carrying `chat.subscribe@1.12`'s typed cause.
 *
 * The cause is load-bearing for every case that wants the LOUD path, and the
 * reason is `hashOnlyRetryForRejection`. A `not-on-host` refusal (and an absent
 * cause, which falls back to it) is one this client can quietly fix, so `@1.12`
 * TAKES THE ACK OVER: it re-inlines and re-dispatches, and nothing is handed
 * back to the composer at all. The prompt only returns once that single retry
 * has been spent, or when the cause is one no retry can fix.
 *
 * `too-large` is the cause these cases want. It surfaces on the FIRST refusal
 * with an empty `unbridgeable` set, so the restore arm runs without also
 * marking digests undecodable - and, more importantly, the takeover's own
 * `invalidateDraftBlobConfirmations` never runs. That is what keeps the
 * retraction assertions honest: with `not-on-host` they would pass off the
 * takeover's retraction whether or not the restore arm retracts anything, which
 * is the one thing these cases exist to prove.
 */
function rejectSendWithCause(
  harness: Harness,
  frame: SentFrame,
  cause: "not-on-host" | "unsupported-format" | "too-large",
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: frame.clientActionId,
    action: "send",
    status: "rejected",
    reason:
      "One or more attached images are unavailable in this workspace. Remove them and re-attach, or re-paste the image directly.",
    code: "MISSING_ATTACHMENT_BYTES",
    cause,
    backgroundStopTaskIds: [],
    token: null,
  });
}

/** The same refusal carrying `chat.subscribe@1.12`'s typed cause. */
function rejectEditWithCause(
  harness: Harness,
  frame: SentFrame,
  cause: "not-on-host" | "unsupported-format" | "too-large",
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: frame.clientActionId,
    action: "editUserMessage",
    status: "rejected",
    reason: "The host's writer cannot decode this image.",
    code: "MISSING_ATTACHMENT_BYTES",
    cause,
    backgroundStopTaskIds: [],
    token: null,
  });
}

let harness: Harness | null = null;

beforeEach(() => {
  // An identity, because a confirmation is recorded and read PER ACCOUNT and a
  // null owner confirms nothing. Without it the eight `toBe(true)` assertions
  // below red - loudly, which is survivable - and, worse, the six `toBe(false)`
  // ones all pass while proving nothing: they would be reading "signed out",
  // not "the memo was retracted", which is the entire subject of this file.
  useAuthStore.setState({
    contextMetadata: { userId: OWNER_ID, username: OWNER_ID },
  });
  resetDraftBlobTransportForTests();
});

afterEach(() => {
  useAuthStore.setState({ contextMetadata: null });
  harness?.handle.dispose();
  harness = null;
  resetDraftBlobTransportForTests();
});

describe("a refused prompt's restore retracts this host's blob acks", () => {
  it("forgets the restored content's hashes, so the user's resend uploads again", async () => {
    const upload = uploadClient();
    // The state the whole defect needs: this renderer has SEEN an ack for
    // these bytes, which is what makes its submit path skip the upload.
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);
    expect(upload.putCalls).toEqual([SHA256]);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const frame = sendHashOnlyMessage(harness);

    // The refusal as the host sends it, with the cause that REACHES the
    // restore arm - see `rejectSendWithCause` for why an untyped refusal is
    // claimed by `@1.12`'s silent retry instead.
    rejectSendWithCause(harness, frame, "too-large");

    // The content really is on its way back to the composer - the existing
    // contract, unchanged. Asserted so a future change that stops restoring
    // cannot leave these cases passing on a retraction with nothing to restore.
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(HASH_ONLY_CONTENT);

    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(false);

    // The consequence, which is the point rather than the memo's internal
    // state: the resend's confirm step now issues a real upload instead of
    // skipping it and shipping a hash this host no longer holds.
    //
    // `ownerUserId` is the SAME id the seeding puts in the auth store, and it
    // has to be for the four calls in this file to mean anything: the gate's
    // memo is keyed per account, so a `null` owner confirms nothing and every
    // one of these would be reading "signed out" rather than "the memo was
    // retracted". The leaf takes it as a parameter rather than reading the
    // store, so passing it here is not redundant with the `beforeEach` - the
    // two cover different readers of the same identity.
    const resend = uploadClient();
    const confirmed = await confirmAttachmentsByHash({
      hostId: HOST_ID,
      client: resend.client,
      plan: { eligible: [SHA256], ineligible: [], hasInlineHashedNode: false },
      ownerUserId: OWNER_ID,
    });

    expect(resend.putCalls).toEqual([SHA256]);
    expect([...confirmed.byHash]).toEqual([SHA256]);
    expect(confirmed.inline).toEqual([]);
  });

  /**
   * W-8: EDIT-AND-RESEND joined this class the moment it was gated by hash.
   *
   * Its pending record has `restore: null` and no `pendingUserMessage`, so the
   * `restore !== null` branch above never fired for it and
   * `use-chat-message-actions` forgets nothing itself. The editor reopened
   * correctly and every LATER Edit/Send skipped the upload against the stale
   * memo and was refused again - a permanent loop for that window.
   */
  it("a refused EDIT retracts its acks too, though it restores no prompt", async () => {
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const frame = editHashOnlyMessage(harness);

    rejectEditForMissingBytes(harness, frame);

    // No prompt was handed back - that is the edit contract, and it is what
    // made the `restore`-keyed retraction blind here.
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    // The memo was retracted anyway.
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(false);

    // The consequence: the next edit re-uploads instead of shipping a hash the
    // host has already refused.
    const resend = uploadClient();
    const confirmed = await confirmAttachmentsByHash({
      hostId: HOST_ID,
      client: resend.client,
      plan: { eligible: [SHA256], ineligible: [], hasInlineHashedNode: false },
      ownerUserId: OWNER_ID,
    });

    expect(resend.putCalls).toEqual([SHA256]);
    expect([...confirmed.byHash]).toEqual([SHA256]);
  });

  /**
   * The MARKING half of `hashOnlyRetryForRejection`, for an edit.
   *
   * `unsupported-format` is a verdict about the digest, not about this request:
   * the host's writer cannot decode it, so it must never travel bare again. The
   * classifier used to bail on `pending.action !== "send"` before reaching the
   * decision table, so an edit's refusal recorded nothing - and once edits
   * became hash-only, every later edit of that message shipped the same
   * undecodable digest and was refused identically.
   */
  it("an edit refused unsupported-format marks the digest unbridgeable", async () => {
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);
    expect(isDraftBlobUnbridgeable(HOST_ID, SHA256)).toBe(false);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const frame = editHashOnlyMessage(harness);
    const framesBefore = harness.sent.length;

    rejectEditWithCause(harness, frame, "unsupported-format");

    expect(isDraftBlobUnbridgeable(HOST_ID, SHA256)).toBe(true);
    // And the SILENT half stayed shut. An edit's inline retry would rewrite a
    // message the user is looking at, so the refusal surfaces instead: nothing
    // new on the wire, and no recovery record holding custody of it.
    expect(harness.sent.length).toBe(framesBefore);
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toEqual([]);
  });

  /**
   * The other side of that guard, and the one that proves the split is real
   * rather than incidental: `not-on-host` is the retryable cause, and it still
   * retries nothing for an edit. Without this, a version that simply deleted
   * the `action !== "send"` check would pass the case above.
   */
  it("an edit refused not-on-host still never retries silently", async () => {
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const frame = editHashOnlyMessage(harness);
    const framesBefore = harness.sent.length;

    rejectEditWithCause(harness, frame, "not-on-host");

    expect(harness.sent.length).toBe(framesBefore);
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toEqual([]);
    // `not-on-host` is not a verdict about the digest, so nothing is marked -
    // the bytes simply were not where this client believed.
    expect(isDraftBlobUnbridgeable(HOST_ID, SHA256)).toBe(false);
  });

  it("without the restore, the resend skips the upload - the loop this breaks", async () => {
    // The control, and it is the half that makes the case above mean
    // something: the memo really does suppress the upload, so the assertion
    // that it no longer does is a change in behaviour and not a fixture that
    // never had an ack to begin with.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    const resend = uploadClient();
    await confirmAttachmentsByHash({
      hostId: HOST_ID,
      client: resend.client,
      plan: { eligible: [SHA256], ineligible: [], hasInlineHashedNode: false },
      ownerUserId: OWNER_ID,
    });

    expect(resend.putCalls).toEqual([]);
  });

  it("also retracts at the setup-gating restore door, which is a different arm", async () => {
    // Arm 2 of the class. It is NOT how a missing-bytes refusal arrives -
    // `takeSetupFailedRestoration` is driven only by `setup.failed` /
    // `setup.cancelled`, and both host sites emit `send.failed` - but it does
    // hand hash-carrying content back, so it retracts too. Pinned separately
    // from the rejection case above so neither can pass on the other's behalf,
    // which is exactly how the first version of this fix looked correct while
    // sitting on a door the refusal never opens.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const frame = sendHashOnlyMessage(harness);
    const restored = harness.handle.store
      .getState()
      .takeSetupFailedRestoration(frame.messageId);

    expect(restored).toEqual(HASH_ONLY_CONTENT);
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(false);
  });

  it("retracts only this host's ack, never another host's", async () => {
    // Host-keyed on the way out as well as on the way in. A refusal is one
    // host saying it lost these bytes; another host's staging tier is a
    // different fact, and dropping it would cost that host a re-upload of
    // bytes it still holds.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);
    await putDraftBlobs("host-b", upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    rejectSendForMissingBytes(harness, sendHashOnlyMessage(harness));

    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(false);
    expect(isDraftBlobConfirmed("host-b", SHA256, OWNER_ID)).toBe(true);
  });
});

const QUEUE_ITEM_ID = "queue-item-1";
const QUEUED_MESSAGE_ID = "queued-message-1";

function setupEvent(
  eventId: string,
  type: ChatEvent["type"],
  metadata: Record<string, unknown>,
  timestamp: number,
): ChatEvent {
  return {
    eventId,
    type,
    timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata,
  };
}

function queuedRow(author: "user" | "agent"): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: QUEUE_ITEM_ID,
    messageId: QUEUED_MESSAGE_ID,
    message:
      author === "user"
        ? {
            kind: "user",
            content: HASH_ONLY_CONTENT,
            browserAnnotations: [],
          }
        : {
            kind: "agent",
            content: HASH_ONLY_CONTENT,
            fromAgentId: "agent-9",
            senderTitle: "Peer agent",
            senderHarnessId: "codex",
            reply: { expectsReply: false },
          },
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

/**
 * A row parked in the queue behind a setup window, with the setup's outcome as
 * the caller names it. `setup.creating` is what carries `triggeringMessageId`,
 * so the window can only be tied to this row through it.
 */
function parkQueuedRowWithSetup(
  harness: Harness,
  outcome: "setup.failed" | "setup.succeeded",
  author: "user" | "agent",
): void {
  harness.handle.store.setState({
    queue: { status: "paused", items: [queuedRow(author)] },
    events: [
      setupEvent(
        "event-creating",
        "setup.creating",
        {
          workspacePath: "/repo",
          triggeringMessageId: QUEUED_MESSAGE_ID,
        },
        1,
      ),
      setupEvent(outcome, outcome, { workspacePath: "/repo" }, 2),
    ],
  });
}

/**
 * Kill the connection and bring it back with a snapshot reporting `items`.
 *
 * The close/open pair is what bumps `connectionEpoch`, which is what makes the
 * fold treat the in-flight cancel as an older-epoch pending it must settle
 * itself. Driven through the real callbacks rather than by writing state, so
 * the sweep and the queue evidence are the store's own.
 */
function reconnectWithQueueItems(
  harness: Harness,
  items: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  const callbacks = harness.callbacks();
  callbacks.onConnectionStatus("closed", null, null);
  callbacks.onConnectionStatus("open", null, null);
  callbacks.onSnapshot({
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
        kind: "conversation",
        evolutionTurnsSinceReview: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      // Spread into a fresh array: the parameter is readonly (this helper does
      // not mutate it) while the protocol's queue snapshot declares `items`
      // mutable, and a readonly array is not assignable to that.
      queue: { status: "paused", items: [...items] },
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

function cancelQueuedRow(harness: Harness): string {
  const clientActionId = harness.handle.store
    .getState()
    .queueCancel(QUEUE_ITEM_ID);
  if (clientActionId === null) throw new Error("expected a queueCancel frame");
  return clientActionId;
}

function ackCancel(
  harness: Harness,
  clientActionId: string,
  status: "accepted" | "rejected",
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "queueCancel",
    status,
    reason: status === "rejected" ? "git worktree add failed" : null,
    code: status === "rejected" ? "WORKTREE_CREATE_FAILED" : null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

/**
 * Arm 4, and the hole it closes.
 *
 * `takeSetupFailedRestoration` deliberately declines while the row is still
 * queued - the prompt is visible and editable in the dock, so a second copy in
 * the composer would fork it. But the driver's `eventId` dedupe consumes the
 * `setup.failed` regardless, so that decline spends the event. Cancel the row
 * afterwards and the last copy went with it: the prompt the user typed is gone
 * with no way to get it back. Cancel is therefore where it has to return, and
 * the only place it still exists to be read.
 */
describe("cancelling a queued row whose setup failed returns it to the composer", () => {
  it("hands the prompt back, forgets its hashes, and only once the host accepts", async () => {
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    parkQueuedRowWithSetup(harness, "setup.failed", "user");
    const clientActionId = cancelQueuedRow(harness);

    // NOTHING yet: the host materializes before it honours a cancel, so until
    // the ack the row may still be there and the prompt is still in the dock.
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);

    ackCancel(harness, clientActionId, "accepted");

    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(HASH_ONLY_CONTENT);
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(false);

    // The consequence, same as arm 1: the resend really re-uploads rather than
    // shipping a hash this host may no longer hold.
    const resend = uploadClient();
    await confirmAttachmentsByHash({
      hostId: HOST_ID,
      client: resend.client,
      plan: { eligible: [SHA256], ineligible: [], hasInlineHashedNode: false },
      ownerUserId: OWNER_ID,
    });
    expect(resend.putCalls).toEqual([SHA256]);
  });

  it("restores nothing when the host refuses the cancel with WORKTREE_CREATE_FAILED", async () => {
    // Ticket 7's host semantics: the cancel materializes the worktree first and
    // is REJECTED when that fails, leaving the row queued. The prompt is still
    // in the dock, so handing a copy to the composer would fork it - the same
    // reason the queued guard declines in the first place.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    parkQueuedRowWithSetup(harness, "setup.failed", "user");
    const clientActionId = cancelQueuedRow(harness);

    ackCancel(harness, clientActionId, "rejected");

    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);
    // The row is the host's to remove and it did not remove it.
    expect(
      harness.handle.store
        .getState()
        .queue.items.some((item) => item.queueItemId === QUEUE_ITEM_ID),
    ).toBe(true);
  });

  it("captures nothing for an AGENT-authored row, even when its setup failed", async () => {
    // A queued prompt's payload is a union, and the agent member is a message
    // another agent sent in over A2A. Nobody typed it into this composer, so
    // there is no draft it came from and none it can go back to - handing it
    // over would compose words the user never wrote. The union is also why the
    // first version of this did not compile: the agent member carries no
    // `browserAnnotations`, which the restore contract needs.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    parkQueuedRowWithSetup(harness, "setup.failed", "agent");
    const clientActionId = cancelQueuedRow(harness);

    ackCancel(harness, clientActionId, "accepted");

    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);
  });

  /**
   * The ack is not the only arm. A cancel the host ACCEPTED and acted on can
   * lose its ack to a dying connection; the reconnect snapshot then sweeps the
   * pending as an older-epoch non-send, and an ack-only consumer would leave
   * the promised prompt unreturned and this entry orphaned for the life of the
   * store - with its image bytes rooted behind it. The snapshot's own queue is
   * the evidence of which way it went.
   */
  it("settles a cancel whose ack died with the connection: row gone on reconnect means the prompt comes back", async () => {
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    parkQueuedRowWithSetup(harness, "setup.failed", "user");
    cancelQueuedRow(harness);

    // The connection dies before the ack, and the reconnect snapshot reports a
    // queue WITHOUT the row: the host honoured the cancel.
    reconnectWithQueueItems(harness, []);

    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(HASH_ONLY_CONTENT);
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(false);
    expect(harness.handle.store.getState().pendingCancelRestorations).toEqual(
      {},
    );
  });

  it("settles it the other way when the row survived the reconnect: nothing restored, slot released", async () => {
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    parkQueuedRowWithSetup(harness, "setup.failed", "user");
    cancelQueuedRow(harness);

    // Same death, opposite evidence: the row is still queued, so the cancel
    // never landed. It is the user's to see and cancel again, and a copy in
    // the composer would fork it.
    reconnectWithQueueItems(harness, [queuedRow("user")]);

    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);
    // Released either way - an entry that outlives its connection is the leak.
    expect(harness.handle.store.getState().pendingCancelRestorations).toEqual(
      {},
    );
  });

  it("keeps the losing prompt as a last copy when the restoration slot is already taken", async () => {
    // ONE slot, first writer wins - and the loser is KEPT, not dropped. The
    // first version reasoned that a displaced cancel's prompt was still safe
    // in the dock; it is not, because the very cancellation being acked is
    // what removes that row.
    //
    // The REGRESSION WITNESS is `lastCopyPrompts`, not the notice. A notice is
    // a rendering the user may never read; the last-copy entry is what roots
    // the prompt's images against the sweep and what the teardown handoff
    // stashes. A version of this that dropped the document and still appended
    // a toast would satisfy the message assertion below and lose the text.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    // Occupy the slot with a rejected send's restoration.
    rejectSendWithCause(harness, sendHashOnlyMessage(harness), "too-large");
    const occupant = harness.handle.store.getState().failedSendRestoration;
    expect(occupant).not.toBeNull();

    parkQueuedRowWithSetup(harness, "setup.failed", "user");
    const clientActionId = cancelQueuedRow(harness);
    ackCancel(harness, clientActionId, "accepted");

    // The incumbent keeps the slot...
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(occupant?.clientActionId);
    // ...and the cancelled row's prompt is kept as a last copy rather than
    // discarded. THIS is the assertion that fails if custody regresses.
    const lastCopy =
      harness.handle.store.getState().lastCopyPrompts[clientActionId];
    // `toBeDefined` first and deliberately, even though the Record's index
    // type says it cannot be missing: that type is the lie here, and this is
    // the assertion that actually fails when no entry was recorded.
    expect(lastCopy).toBeDefined();
    expect(lastCopy.reason).toContain("Workspace setup failed");
    expect(JSON.stringify(lastCopy.content)).toContain("look at this");
    // And it is stated, through upstream's dead-send surface rather than the
    // displaced-restoration one: the prompt is not waiting anywhere to be put
    // back, so the statement is about the copy it is carrying.
    const stated = harness.handle.store
      .getState()
      .errorNotices.filter(
        (notice) => notice.clientActionId === clientActionId,
      );
    expect(stated).toHaveLength(1);
    expect(stated[0]?.code).toBe(SEND_NOT_RECORDED_NOTICE_CODE);
    expect(stated[0]?.message).toContain(
      "another unsent message is already waiting in the composer",
    );
    // The statement quotes the draft, which is the whole point of stating it.
    expect(stated[0]?.message).toContain("look at this");
  });

  it("leaves an ordinary cancel alone when the row's setup did not fail", async () => {
    // The scope control. Cancelling a healthy row is the user discarding a
    // message they no longer want; returning it to the composer would undo the
    // gesture they just made.
    const upload = uploadClient();
    await putDraftBlobs(HOST_ID, upload.client, [SHA256], OWNER_ID);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    parkQueuedRowWithSetup(harness, "setup.succeeded", "user");
    const clientActionId = cancelQueuedRow(harness);

    ackCancel(harness, clientActionId, "accepted");

    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(isDraftBlobConfirmed(HOST_ID, SHA256, OWNER_ID)).toBe(true);
  });
});
