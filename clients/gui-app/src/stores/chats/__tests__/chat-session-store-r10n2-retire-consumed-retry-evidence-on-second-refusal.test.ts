/**
 * R10N2: `retireConsumedRetryEvidence` retires a hash-only retry's
 * `stickySweptByAction` record at the moment its SECOND refusal has consumed
 * it - called from `onActionAck` right after the rejection updater that
 * reads it (`rejectionSweepFor` → `sweepAccountForIntent`) has already run.
 *
 * `chat-session-store-r9f3-retry-second-refusal-sticky-sweep.test.ts` proves
 * the terminal ACCOUNT is right (the notice and `lastCopyPrompts` both say
 * "no longer exists"), but removing `retireConsumedRetryEvidence` leaves that
 * file green - it never looks at `stickySweptByAction` itself, only at what
 * was built from it before this call ever runs. This file drives the
 * retirement directly, the same way
 * `chat-session-store-r9-sticky-sweep-retire-on-accepted-ack.test.ts` drives
 * the ACCEPTED half: a spy on `Map.prototype.delete` (the private map's own
 * prototype, not a production-code change) observes the deletion at the
 * moment it happens, and asserts what should already be true by then - the
 * pending action is gone and `lastCopyPrompts` already carries the account
 * `retireConsumedRetryEvidence`'s own doc comment says it is called AFTER.
 * Reading store state from inside a `Map.prototype.delete` spy proves the
 * ORDER, not just the outcome - a `retireConsumedRetryEvidence` moved to
 * BEFORE the rejection updater would still leave the map empty by the end of
 * the test, but would fail these in-spy assertions.
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

const EPIC_ID = "epic-r10n2";
const CHAT_ID = "chat-r10n2";
const OWNER_ID = "owner-r10n2";
const HOST_ID = "host-r10n2";

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

function plainContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

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

describe("R10N2: retireConsumedRetryEvidence deletes the retry's sticky record AFTER its terminal account is built", () => {
  it("deletes the retry's sticky-sweep entry only once the pending action is gone and lastCopyPrompts already holds its 'no longer exists' account (DRIVE RED)", async () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    // `kind: "import"`, not `"local"`: only import/worktree entries can ever
    // be reported swept by `worktreeFolderIntentReferencesRemoved`.
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: "/repo-r10n2",
          worktreePath: "/repo-r10n2",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    // Occupy the single restoration slot with an unrelated, already-settled
    // rejection FIRST, so the retry's own terminal refusal below is
    // DISPLACED - the branch that produces a `lastCopyPrompts` document,
    // which `rejectionLastCopySend` only ever builds for a displaced send.
    const occupant = sendMessageWithContent(
      harness,
      plainContent("an unrelated message that took the restoration slot"),
    );
    rejectPlain(harness, occupant.clientActionId, "Not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration,
    ).not.toBeNull();

    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "R10N2 sticky-retirement prompt"),
    );

    // First refusal begins the hash-only recovery and dispatches the retry.
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    let retryActionId = "";
    await vi.waitFor(() => {
      const retry = Object.values(
        harness?.handle.store.getState().pendingActions ?? {},
      ).find((action) => action.hashOnlyRetry);
      expect(retry).toBeDefined();
      if (retry !== undefined) retryActionId = retry.clientActionId;
    });

    // The host sweeps the frozen path while the retry is outstanding; the
    // consumer-observing subscription folds it into the retry's sticky
    // record under its OWN clientActionId.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/repo-r10n2"]),
        branches: [],
      });

    let observedDeletion = false;
    let pendingStillPresentAtDeletion = true;
    let lastCopyPromptMissingAtDeletion = true;
    let lastCopyPromptReasonAtDeletion = "";
    // Read through the property descriptor, not `Map.prototype.delete`
    // directly - that bare member access is exactly what `@typescript-eslint/
    // unbound-method` flags, even though the call below supplies `this`
    // explicitly via `.call`.
    const deleteDescriptor = Object.getOwnPropertyDescriptor(
      Map.prototype,
      "delete",
    );
    if (
      deleteDescriptor === undefined ||
      typeof deleteDescriptor.value !== "function"
    ) {
      throw new Error("Expected Map.prototype.delete to exist.");
    }
    const originalDelete: (
      this: Map<unknown, unknown>,
      key: unknown,
    ) => boolean = deleteDescriptor.value as (
      this: Map<unknown, unknown>,
      key: unknown,
    ) => boolean;
    const deleteSpy = vi
      .spyOn(Map.prototype, "delete")
      .mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
        if (key === retryActionId) {
          observedDeletion = true;
          const state = harness?.handle.store.getState();
          pendingStillPresentAtDeletion =
            state !== undefined &&
            Object.hasOwn(state.pendingActions, retryActionId);
          const prompt = state?.lastCopyPrompts[retryActionId];
          lastCopyPromptMissingAtDeletion = prompt === undefined;
          lastCopyPromptReasonAtDeletion = prompt?.reason ?? "";
        }
        return originalDelete.call(this, key);
      });
    try {
      // The retry's SECOND refusal - `alreadyRetried` is now true, so this is
      // its terminal statement, not another recovery.
      rejectMissingAttachmentBytes(harness, retryActionId, "not-on-host");
    } finally {
      deleteSpy.mockRestore();
    }

    expect(observedDeletion).toBe(true);
    // At the exact moment `stickySweptByAction` loses this entry, the
    // rejection updater's `set()` has already run: the pending action is
    // gone and `lastCopyPrompts` already carries the account it read from
    // that entry. `retireConsumedRetryEvidence` runs AFTER, not before.
    expect(pendingStillPresentAtDeletion).toBe(false);
    expect(lastCopyPromptMissingAtDeletion).toBe(false);
    expect(lastCopyPromptReasonAtDeletion).toContain("no longer exists");
    expect(lastCopyPromptReasonAtDeletion).toContain("/repo-r10n2");
  });
});
