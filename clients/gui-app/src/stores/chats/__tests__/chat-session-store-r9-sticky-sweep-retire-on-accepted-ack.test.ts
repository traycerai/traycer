/**
 * `retireSweptEvidenceOnAck` retires a settled action's sticky sweep record
 * (`stickySweptByAction`) on every ACK that is not a rejection. Cleanup used
 * to happen solely on abandonment, so a send that simply succeeded left its
 * evidence in the map for the rest of the session's life - a leak bounded
 * only by `dispose()`'s own `stickySweptByAction.clear()`.
 *
 * There is no legitimate later PRODUCTION read of a settled action's own
 * evidence to assert an absence against - once an ack settles it, the id is
 * gone from both `pendingActions` and `hashOnlyRecoveries`, and nothing else
 * in the store is keyed by it. So this drives the retirement itself: a spy
 * on `Map.prototype.delete` (the private map's own prototype, not a
 * production-code change) observes whether the settled id was actually
 * deleted at the moment its ACCEPTED ack is processed.
 *
 * The `rejected`-ack half is covered ELSEWHERE, not unexercised - an earlier
 * version of this comment said it was, and `rejectionSweepFor` has since made
 * it load-bearing: a retry's second refusal reads the very entry a rejected
 * ack would have deleted. Its drive-red lives in
 * `chat-session-store-r9f3-retry-second-refusal-sticky-sweep.test.ts`. This
 * file drives the ACCEPTED half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import {
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { pngBytesOfSize } from "@/lib/composer/__tests__/image-fixtures";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const EPIC_ID = "epic-r9-ack-retire";
const CHAT_ID = "chat-r9-ack-retire";
const OWNER_ID = "owner-r9-ack-retire";
const HOST_ID = "host-r9-ack-retire";

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
  // `drafts.putBlob` rides THIS member, never `request` above - a fake without
  // it is a fake no upload can reach. Options ignored: no case here turns on
  // the idempotency key or the upload budget.
  requestWithOptions: ((_method, _params) =>
    Promise.resolve({
      ok: true as const,
    })) as HostRequester<HostRpcRegistry>["requestWithOptions"],
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
          size: 32,
          hash,
        },
      },
      { type: "paragraph", content: [{ type: "text", text }] },
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

function acceptAck(harness: Harness, clientActionId: string): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId,
    action: "send",
    status: "accepted",
    reason: null,
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

const originalCreateImageBitmap = globalThis.createImageBitmap;

let harness: Harness | null = null;

beforeEach(() => {
  installFreshIndexedDb();
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

describe("retireSweptEvidenceOnAck: an ACCEPTED ack retires the settled action's sticky sweep record", () => {
  it("deletes the retry's sticky evidence at the moment its ack is accepted (DRIVE RED)", async () => {
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
          kind: "import",
          workspacePath: "/repo-r9-ack-retire",
          worktreePath: "/repo-r9-ack-retire",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);

    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId: firstId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "ack-retire prompt"),
    );

    rejectMissingAttachmentBytes(harness, firstId, "not-on-host");
    let retryActionId = "";
    await vi.waitFor(() => {
      const retry = Object.values(
        harness?.handle.store.getState().pendingActions ?? {},
      ).find((action) => action.hashOnlyRetry);
      expect(retry).toBeDefined();
      if (retry !== undefined) retryActionId = retry.clientActionId;
    });

    // Give the retry SOMETHING in the sticky map to retire: a sweep while it
    // is live folds evidence into its record via the consumer-observing
    // subscription (same mechanism R9F2/R9F3 exercise).
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/repo-r9-ack-retire"]),
        branches: [],
      });

    // No production read can observe this settled id's evidence again once
    // it settles (see the file doc comment), so this spies on the map's own
    // prototype - a test-side observation, not a production change - to
    // confirm the retirement itself actually ran.
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    try {
      acceptAck(harness, retryActionId);
      expect(deleteSpy.mock.calls.some(([key]) => key === retryActionId)).toBe(
        true,
      );
    } finally {
      deleteSpy.mockRestore();
    }
  });
});
