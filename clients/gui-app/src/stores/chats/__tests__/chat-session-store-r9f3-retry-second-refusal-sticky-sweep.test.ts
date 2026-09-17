/**
 * R9F3 (P2): a hash-only retry's SECOND refusal - its send's terminal
 * statement - now builds its worktree account from the transferred sticky
 * evidence via `rejectionSweepFor`/`sweepAccountForIntent`, not the live
 * per-slot partition (`worktreePartition`).
 *
 * The per-slot partition answers "what is staged now": staging ANY newer
 * pick on the same key drops its dispatch mark and the `sweptRefsByKey`
 * record with it ("one lifetime, one drop" - `stageIntent`), regardless of
 * whether the newer pick has anything to do with the swept path. So once the
 * user has staged a newer worktree, the OLD per-slot read reports the
 * retry's frozen (and actually-removed) worktree as fine again - while the
 * HOST-level record (`sessionSweptRefsByHost`) is untouched by staging a
 * DIFFERENT path, and correctly still says it is gone.
 *
 * Both surfaces a terminal refusal produces from that account must agree:
 * the loud `errorNotices` entry (what a listening surface renders live) and
 * the `lastCopyPrompts` document behind it (what teardown hands to the
 * prompt stash) are built from the SAME evidence, so a wrong account breaks
 * both identically.
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
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import {
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { pngBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const EPIC_ID = "epic-r9f3";
const CHAT_ID = "chat-r9f3";
const OWNER_ID = "owner-r9f3";
const HOST_ID = "host-r9f3";

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

describe("R9F3: a retry's SECOND refusal reads the sticky host-level sweep, not the live per-slot partition", () => {
  it("a retry's second refusal still says the frozen worktree is gone, in both the notice and the stashed copy, after a newer worktree pick clears the per-slot mark (DRIVE RED)", async () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    // `kind: "import"` deliberately, not `"local"`:
    // `worktreeFolderIntentReferencesRemoved` only matches `import`/`worktree`
    // entry kinds against a sweep - a `local` entry can never be reported
    // swept, which would make this fixture prove nothing.
    const intentA: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: "/repo-r9f3-a",
          worktreePath: "/repo-r9f3-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intentA);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    // Occupy the restoration slot with an unrelated, already-settled
    // rejection FIRST, so the retry's own terminal refusal below is
    // DISPLACED - the branch that produces a `lastCopyPrompts` document
    // alongside the notice, rather than taking `failedSendRestoration`
    // itself (which would just make this test about the wrong send).
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
      hashOnlyContent(hash, "sticky second-refusal prompt"),
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

    // The host sweeps A's path while the retry is outstanding. The
    // consumer-observing subscription folds it into the retry's sticky
    // record (R9F2) as this fires, AND updates the per-slot record for the
    // same key.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/repo-r9f3-a"]),
        branches: [],
      });

    // The user stages a NEWER, unrelated pick on the SAME key. This drops
    // the per-slot dispatch mark and its `sweptRefsByKey` record wholesale -
    // "one lifetime, one drop" - regardless of the new pick's own path. The
    // HOST-level fact about `/repo-r9f3-a` is untouched: only re-staging
    // that EXACT path would clear it.
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-r9f3-newer-pick",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    // The retry's SECOND refusal - `alreadyRetried` is now true, so this is
    // its terminal statement, not another recovery.
    rejectMissingAttachmentBytes(harness, retryActionId, "not-on-host");

    const notice = harness.handle.store
      .getState()
      .errorNotices.find((n) => n.clientActionId === retryActionId);
    expect(notice).toBeDefined();
    if (notice === undefined) throw new Error("expected the retry's notice");
    expect(notice.message).toContain("no longer exists");
    expect(notice.message).toContain("/repo-r9f3-a");

    const lastCopyPrompts = harness.handle.store.getState().lastCopyPrompts;
    expect(Object.hasOwn(lastCopyPrompts, retryActionId)).toBe(true);
    expect(lastCopyPrompts[retryActionId]?.reason).toContain(
      "no longer exists",
    );
    expect(lastCopyPrompts[retryActionId]?.reason).toContain("/repo-r9f3-a");
  });
});
