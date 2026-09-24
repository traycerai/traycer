/**
 * R6F5(b) (P2): `retryHandoffAccountFor` - the account builder for a
 * dispatched-retry action still in flight at disposal - reads the HOST-LEVEL
 * swept set (`sweepAccountForIntent` / `sessionSweptRefsForHost`), not the
 * old per-slot `worktreePartition`.
 *
 * The per-slot partition's evidence is dropped by every mutation that
 * resolves the slot (including the very ack that dispatches the retry), so a
 * sweep landing AFTER that resolution had nothing left to record against and
 * the handoff could say a swept worktree was still fine to re-pick - while
 * every OTHER statement about the same send (the hash-only recovery's own
 * abandon path, already fixed in R5F4) correctly said it was gone.
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
import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { RemovedWorktreeRefs } from "@/lib/worktree/removed-worktree-refs";

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
  sessionSweptRefsForHost,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { pngBytesOfSize } from "@/lib/composer/__tests__/image-fixtures";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";
import {
  resetHandedOffDrafts,
  waitForHandedOffDraft,
} from "@/stores/chats/__tests__/handoff-draft-observer";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const EPIC_ID = "epic-r6f5b";
const CHAT_ID = "chat-r6f5b";
const OWNER_ID = "owner-r6f5b";
const HOST_ID = "host-r6f5b";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
  identityId: null,
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
    kind: "conversation",
    evolutionTurnsSinceReview: null,
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
  resetHandedOffDrafts();
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

describe("R7F3: a sticky per-consumer sweep record survives another consumer clearing the host-wide fact", () => {
  it("A's retry handoff still says the worktree is gone after B stages A's path and clears the host-wide mark (DRIVE RED)", async () => {
    const stagingKeyA: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const stagingKeyB: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: "chat-r7f3-b",
    };
    const sharedEntry: WorktreeFolderIntent = {
      kind: "import",
      workspacePath: "/repo-r7f3-shared",
      worktreePath: "/repo-r7f3-shared",
      repoIdentifier: null,
      isPrimary: true,
    };
    const sharedIntent: WorktreeIntent = { entries: [sharedEntry] };
    useWorktreeIntentStagingStore
      .getState()
      .stageIntent(stagingKeyA, sharedIntent);

    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "sticky sweep prompt"),
    );

    // The host sweeps A's path BEFORE the refusal, so the evidence exists to
    // be captured while the send still owns `clientActionId`.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/repo-r7f3-shared"]),
        branches: [],
      });

    // The refusal begins the hash-only recovery: `clientActionId` now owns a
    // `HashOnlyRecoveryState`, still keyed by the ORIGINAL id, and the async
    // retry has not dispatched yet. `beginHashOnlyRecovery` folds the
    // still-visible host-wide sweep into this recovery's sticky record
    // SYNCHRONOUSLY, in the same tick, before B gets a chance to clear the
    // host-wide mark below - R9F2's fix, and the only thing that captures
    // this evidence: nothing else touches the staging store between the
    // purge above and B's own stage next, so there is no OTHER write to fire
    // the consumer-observing subscription and fold the fact in that way.
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");

    // NOW chat B stages A's OWN path - the user reasserting a path exists is
    // exactly what clears the host-wide mark, for every consumer, regardless
    // of who originally staged it or who it was swept out from under.
    //
    // `stageEntry`, the per-ROW action, because that is the one that carries
    // the assertion: a bulk `stageIntent` re-stages entries the user never
    // touched (its caller restamps `isPrimary` after a primary switch) and
    // deliberately retracts nothing.
    useWorktreeIntentStagingStore
      .getState()
      .stageEntry(stagingKeyB, sharedEntry);
    expect(
      sessionSweptRefsForHost(HOST_ID)?.worktreePaths.has(
        "/repo-r7f3-shared",
      ) ?? false,
    ).toBe(false);

    // The retry dispatches - hand-across carries the sticky record from the
    // original id to the new one.
    await vi.waitFor(() => {
      expect(
        Object.values(
          harness?.handle.store.getState().pendingActions ?? {},
        ).some((action) => action.hashOnlyRetry),
      ).toBe(true);
    });

    // Dispose while the retry is still unacknowledged: its handoff runs
    // through `retryHandoffAccountFor`, which must still say the worktree is
    // gone. The host-wide record says otherwise by now (B cleared it), so
    // only the sticky per-consumer record can be the source of that "gone".
    harness.handle.dispose();

    const text = await waitForHandedOffDraft(
      "sticky sweep prompt",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
    expect(text).toContain("no longer exists");
    expect(text).toContain("/repo-r7f3-shared");
  });
});

describe("R6F5(b): retryHandoffAccountFor reflects the host-level sweep set", () => {
  it("a sweep landing AFTER the dispatch ack resolved the staging slot still names the retry's worktree as gone (DRIVE RED)", async () => {
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
          workspacePath: "/repo-retry-sweep",
          worktreePath: "/repo-retry-sweep",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);

    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "retry-sweep prompt"),
    );

    // The refusal resolves the dispatch mark (staging returns to an
    // ordinary, unconsumed state) and fires the silent hash-only retry -
    // BEFORE the sweep below ever runs.
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryAction = Object.values(
      harness.handle.store.getState().pendingActions,
    ).find((action) => action.hashOnlyRetry);
    expect(retryAction).toBeDefined();
    expect(retryAction?.restore).not.toBeUndefined();

    // The user stages a DIFFERENT pick for whatever comes next while the
    // retry is still in flight - an ordinary `setIntent`, which drops this
    // slot's dispatch mark and per-slot `sweptRefsByKey` wholesale ("one
    // lifetime, one drop"). The retry's own frozen `restoreWorktreeIntent`
    // is untouched - it is a snapshot, not a live reference to the slot.
    useWorktreeIntentStagingStore.getState().setIntent(stagingKey, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo-next-pick",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    // THEN the sweep runs - the per-slot evidence for THIS key is gone, but
    // the host-level record is monotonic and unaffected by the re-stage.
    const removed: RemovedWorktreeRefs = {
      worktreePaths: new Set(["/repo-retry-sweep"]),
      branches: [],
    };
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, removed);

    // Dispose while the retry is still unacknowledged: its handoff runs
    // through `retryHandoffAccountFor`.
    harness.handle.dispose();

    const text = await waitForHandedOffDraft(
      "retry-sweep prompt",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
    expect(text).toContain("no longer exists");
    expect(text).toContain("/repo-retry-sweep");
  });
});
