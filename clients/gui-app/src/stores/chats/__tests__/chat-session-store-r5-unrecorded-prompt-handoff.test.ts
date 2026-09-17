/**
 * R5F2, R5F3 and R5F4: the durable-handoff round's remaining gaps.
 *
 *  - R5F2: `lastCopyPrompts` covers a last-copy notice created WELL BEFORE
 *    disposal (not merely one this disposal's own abandonment created), and
 *    is released once the notice is delivered.
 *  - R5F3: a multi-folder staging keeps every entry (not just the first
 *    `workspacePath`), and the in-flight-retry variant hands off
 *    `displacedReason` (which names the worktree), not `reason` (which
 *    doesn't).
 *  - R5F4: `sessionSweptRefsForHost` (never cleared) is what a hand-back's
 *    account is built from, not the old per-slot `sweptRefsByKey` (dropped by
 *    every mutation that resolves a slot).
 *
 * `save` is mocked here, as the existing hash-only-refusal suite does, so
 * assertions read the exact `PromptStashSnapshot` the store handed off - but
 * every captured snapshot is ALSO replayed through the REAL repository
 * (fake-indexeddb) to prove it actually persists and restores, which is the
 * whole point of R5F1: a snapshot that merely "looks right" to a mock can
 * still be the one shape `savePromptStashSnapshot` refuses.
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
import type { RemovedWorktreeRefs } from "@/lib/worktree/removed-worktree-refs";
import type { PromptStashSnapshot } from "@/lib/composer/prompt-stash-codec";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { pngBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import {
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  loadPromptStashSnapshot,
  savePromptStashSnapshot,
} from "@/lib/composer/prompt-stash-repository";
import { materializePromptStashEntry } from "@/lib/composer/prompt-stash-content";
import {
  promptStashRowId,
  type PromptStashRow,
} from "@/lib/composer/prompt-stash-codec";
import {
  ChatSessionRegistry,
  MAX_ACTIVE_CHAT_IDLE_DEFER_MS,
  type ChatSessionTarget,
} from "@/stores/chats/session-registry";

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

const EPIC_ID = "epic-r5";
const CHAT_ID = "chat-r5";
const OWNER_ID = "owner-r5";
const HOST_ID = "host-r5";

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
  const epicId = EPIC_ID;
  const chatId = CHAT_ID;
  const hostId = HOST_ID;
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId,
    epicId,
    chatId,
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

function emitOwnerSnapshot(callbacks: ChatStreamCallbacks): void {
  const epicId = EPIC_ID;
  const chatId = CHAT_ID;
  callbacks.onConnectionStatus("open", null, null);
  const chat: Chat = {
    id: chatId,
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
    epicId,
    chatId,
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
): { readonly clientActionId: string; readonly messageId: string } {
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

/** Replays a captured snapshot through the REAL repository, proving it is
 * not merely a mock-shaped object but one `savePromptStashSnapshot` actually
 * accepts and `materializePromptStashEntry` actually restores. */
async function assertSnapshotSurvivesRealRepository(
  snapshot: PromptStashSnapshot,
): Promise<JsonContent> {
  await savePromptStashSnapshot(snapshot);
  const { rows } = await loadPromptStashSnapshot();
  const row = rows.find(
    (candidate: PromptStashRow) =>
      promptStashRowId(candidate) === snapshot.entry.id,
  );
  expect(row?.kind).toBe("entry");
  if (row === undefined || row.kind !== "entry") {
    throw new Error("expected the entry to survive a real save");
  }
  return materializePromptStashEntry(row.entry);
}

/**
 * Coverage-fix helper: locates, among every snapshot `save` actually
 * received, the one whose content contains `text`, then replays THAT one
 * through the real repository. Every matrix case below used to inspect only
 * the mocked call args - a real gap, since a mock accepts a snapshot of any
 * shape and a test that never replays it through `savePromptStashSnapshot`
 * cannot tell a well-formed handoff from a malformed one that merely
 * "looks right".
 */
async function assertMatchingSnapshotSurvivesRealRepository(
  text: string,
): Promise<JsonContent> {
  const match = promptStashMocks.save.mock.calls
    .map(([snapshot]) => snapshot)
    .find((snapshot) => JSON.stringify(snapshot.entry.content).includes(text));
  expect(match).toBeDefined();
  if (match === undefined) {
    throw new Error(`expected a stashed snapshot containing ${text}`);
  }
  return assertSnapshotSurvivesRealRepository(match);
}

let harness: Harness | null = null;
let secondHarness: Harness | null = null;

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
  secondHarness?.handle.dispose();
  secondHarness = null;
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
});

describe("R5F2: lastCopyPrompts covers a notice created well before disposal", () => {
  it("a last-copy notice created via the rejection path, long before disposal, reaches the prompt stash at dispose (DRIVE RED)", async () => {
    // A occupies the restoration slot; B's rejection is then displaced onto
    // the notice-only path (`lastCopyPrompts`), well before this test ever
    // calls `dispose()`. Pre-fix, `handOffUnrecordedPromptToStash` read only
    // `state.failedSendRestoration` plus `pendingActions` - a notice-only
    // prompt sitting in the ring since long before teardown was invisible to
    // it, and warm eviction (or the deferral cap) could destroy it with no
    // trace.
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const a = sendMessageWithContent(
      harness,
      plainContent("A occupies the slot"),
    );
    rejectPlain(harness, a.clientActionId, "A was not accepted.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(a.clientActionId);

    const B_TEXT = "B's prompt, displaced long before disposal";
    const b = sendMessageWithContent(harness, plainContent(B_TEXT));
    rejectPlain(harness, b.clientActionId, "B was not accepted.");

    // B lost the slot race: it is stated in a notice, not handed back.
    expect(
      harness.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(a.clientActionId);
    const bNotice = harness.handle.store
      .getState()
      .errorNotices.find(
        (notice) => notice.clientActionId === b.clientActionId,
      );
    expect(bNotice).toBeDefined();
    expect(
      Object.hasOwn(
        harness.handle.store.getState().lastCopyPrompts,
        b.clientActionId,
      ),
    ).toBe(true);

    // The session sits, unrelated to B's prompt, for a while - then disposes.
    harness.handle.dispose();

    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const texts = promptStashMocks.save.mock.calls.map(([snapshot]) =>
      JSON.stringify(snapshot.entry.content),
    );
    expect(texts.some((text) => text.includes(B_TEXT))).toBe(true);

    // Real-repository proof: the captured snapshot for B actually persists
    // and restores, not merely "looks right" to the mock.
    const bSnapshot = promptStashMocks.save.mock.calls
      .map(([snapshot]) => snapshot)
      .find((snapshot) =>
        JSON.stringify(snapshot.entry.content).includes(B_TEXT),
      );
    expect(bSnapshot).toBeDefined();
    if (bSnapshot === undefined) throw new Error("expected B's snapshot");
    const restored = await assertSnapshotSurvivesRealRepository(bSnapshot);
    expect(JSON.stringify(restored)).toContain(B_TEXT);
  });

  it("positive control: once the notice is delivered (markNoticeDelivered), that prompt is NOT stashed at dispose", async () => {
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());

    const A_TEXT = "A occupies the slot";
    const a = sendMessageWithContent(harness, plainContent(A_TEXT));
    rejectPlain(harness, a.clientActionId, "A was not accepted.");

    const B_TEXT = "B's prompt, delivered before disposal";
    const b = sendMessageWithContent(harness, plainContent(B_TEXT));
    rejectPlain(harness, b.clientActionId, "B was not accepted.");
    const bNotice = harness.handle.store
      .getState()
      .errorNotices.find(
        (notice) => notice.clientActionId === b.clientActionId,
      );
    expect(bNotice).toBeDefined();
    if (bNotice === undefined) throw new Error("expected B's notice");

    // Custody has genuinely moved on: the toast layer showed the notice.
    harness.handle.store.getState().markNoticeDelivered(bNotice);
    expect(
      Object.hasOwn(
        harness.handle.store.getState().lastCopyPrompts,
        b.clientActionId,
      ),
    ).toBe(false);

    harness.handle.dispose();

    // A's own hand-back IS stashed - a separate hold, and waiting for it is
    // what makes the negative below meaningful. `>= 0` was the bug here: it is
    // true before any handoff has run, so the assertion that B is absent was
    // being made against an empty list every time.
    await vi.waitFor(
      () => {
        expect(
          promptStashMocks.save.mock.calls.some(([snapshot]) =>
            JSON.stringify(snapshot.entry.content).includes(A_TEXT),
          ),
        ).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
    const texts = promptStashMocks.save.mock.calls.map(([snapshot]) =>
      JSON.stringify(snapshot.entry.content),
    );
    expect(texts.some((text) => text.includes(B_TEXT))).toBe(false);
  });
});

describe("R5F3: every handoff variant carries the full frozen account", () => {
  it("a multi-folder staging (import + local) names EVERY entry and its branch in the stashed qualification, not just the first workspacePath (DRIVE RED)", async () => {
    const stagingKey: WorktreeStagingKey = {
      surface: "owner",
      hostId: HOST_ID,
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const multiIntent: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: "/repo-primary",
          worktreePath: "/repo-primary-worktree",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "local",
          workspacePath: "/repo-secondary",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    };
    useWorktreeIntentStagingStore
      .getState()
      .stageIntent(stagingKey, multiIntent);

    const hash = await seedConfirmedImage(pngBytesOfSize(32));

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "multi-folder prompt"),
    );
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(multiIntent);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    // WAIT for the silent retry to actually reach the wire, and hold there
    // unacknowledged. This is the part that decides which handoff variant
    // runs, and an earlier version of this test got it wrong: disposing while
    // the recovery is still in `hashOnlyRecoveries` makes
    // `abandonAllHashOnlyRecoveries` convert it to `failedSendRestoration`
    // first, so the RESTORATION path answers and `retryHandoffAccountFor` is
    // never reached. The assertions below passed anyway - the restoration's
    // own account names every entry too - which is exactly how a test comes to
    // describe a path it does not take.
    await vi.waitFor(() => {
      expect(harness?.sent).toHaveLength(2);
    });
    const retryAction = Object.values(
      harness.handle.store.getState().pendingActions,
    ).find((action) => action.hashOnlyRetry);
    // `?.restore` on a MISSING action is `undefined`, which `not.toBeNull()`
    // happily accepts - so this passed whether or not a retry existed. Assert
    // the action first, then its restore.
    expect(retryAction).toBeDefined();
    expect(retryAction?.restore).not.toBeUndefined();
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    harness.handle.dispose();

    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const [snapshot] = promptStashMocks.save.mock.calls[0];
    const text = JSON.stringify(snapshot.entry.content);
    // Every staged entry named, not just the primary `workspacePath` - and via
    // `retryHandoffAccountFor`, which the preconditions above pin.
    expect(text).toContain("/repo-primary-worktree");
    expect(text).toContain("/repo-secondary");
  });

  it("the restoration variant's stashed text uses displacedReason (names the worktree), not reason (which omits it) (DRIVE RED)", async () => {
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
          workspacePath: "/repo-restoration",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);

    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      plainContent("restoration-variant prompt"),
    );
    rejectPlain(harness, clientActionId, "Not accepted.");
    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.clientActionId).toBe(clientActionId);
    // Sanity: `reason` (handed-back) and `displacedReason` (not) genuinely
    // differ, which is the whole premise of this test.
    expect(state.failedSendRestoration?.reason).not.toContain(
      "/repo-restoration",
    );
    expect(state.failedSendRestoration?.displacedReason).toContain(
      "/repo-restoration",
    );

    harness.handle.dispose();

    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const [snapshot] = promptStashMocks.save.mock.calls[0];
    const text = JSON.stringify(snapshot.entry.content);
    expect(text).toContain("/repo-restoration");
  });
});

describe("R5F4: sessionSweptRefsForHost is the monotonic source for a sweep's account", () => {
  it("(a) a purge that lands AFTER the ack already restored staging (no consumed-slot mark) still says the swept directory no longer exists (DRIVE RED)", async () => {
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
          workspacePath: "/repo-post-ack",
          worktreePath: "/repo-post-ack",
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
      hashOnlyContent(hash, "post-ack sweep prompt"),
    );

    // The rejection resolves the dispatch mark - staging returns to an
    // ordinary, unconsumed state - BEFORE the sweep below ever runs. The old
    // per-slot `sweptRefsByKey` is recorded only against a slot with a live
    // dispatch mark, so a sweep after this point had nothing to record
    // against; `sessionSweptRefsByHost` has no such requirement.
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    const removed: RemovedWorktreeRefs = {
      worktreePaths: new Set(["/repo-post-ack"]),
      branches: [],
    };
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, removed);

    harness.handle.dispose();

    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const [snapshot] = promptStashMocks.save.mock.calls[0];
    const text = JSON.stringify(snapshot.entry.content);
    expect(text).toContain("no longer exists");
    expect(text).toContain("/repo-post-ack");
  });

  it("(b) a LATER sweep's evidence is what the statement reflects, not a copy read before it (DRIVE RED)", async () => {
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
          workspacePath: "/repo-later-sweep",
          worktreePath: "/repo-later-sweep",
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
      hashOnlyContent(hash, "later-sweep prompt"),
    );
    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    // A first, irrelevant sweep - the reader (if it captured a snapshot here)
    // must not freeze on this one.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/unrelated-repo"]),
        branches: [],
      });

    // The LATER sweep that actually removes this recovery's own folder.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/repo-later-sweep"]),
        branches: [],
      });

    harness.handle.dispose();

    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const [snapshot] = promptStashMocks.save.mock.calls[0];
    const text = JSON.stringify(snapshot.entry.content);
    expect(text).toContain("no longer exists");
    expect(text).toContain("/repo-later-sweep");
  });

  it("(c) a PARTIAL sweep whose survivors are restaged before the recovery record exists still says the swept directory is gone (DRIVE RED)", async () => {
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
          workspacePath: "/repo-partial-swept",
          worktreePath: "/repo-partial-swept",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "import",
          workspacePath: "/repo-partial-survivor",
          worktreePath: "/repo-partial-survivor",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);

    // The send FREEZES the full intent (both entries) into the pending
    // action before anything is swept - that frozen copy is what the
    // eventual recovery record's `worktreeIntent` comes from.
    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const { clientActionId } = sendMessageWithContent(
      harness,
      hashOnlyContent(hash, "partial-sweep prompt"),
    );
    const originalFrame = harness.sent[0];
    if (originalFrame.kind !== "send") throw new Error("expected a send frame");
    expect(originalFrame.worktreeIntent).toEqual(intent);

    // THEN a partial sweep removes one entry, and the survivor is restaged -
    // an ordinary re-stage after a partial sweep - which drops the staging
    // store's own per-slot evidence for this key entirely, BEFORE the
    // recovery record below is even created.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents(HOST_ID, {
        worktreePaths: new Set(["/repo-partial-swept"]),
        branches: [],
      });
    const survivorOnly: WorktreeIntent = {
      entries: [
        {
          kind: "import",
          workspacePath: "/repo-partial-survivor",
          worktreePath: "/repo-partial-survivor",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore
      .getState()
      .stageIntent(stagingKey, survivorOnly);

    rejectMissingAttachmentBytes(harness, clientActionId, "not-on-host");
    expect(
      Object.keys(harness.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);

    harness.handle.dispose();

    await vi.waitFor(() => {
      expect(promptStashMocks.save).toHaveBeenCalled();
    });
    const [snapshot] = promptStashMocks.save.mock.calls[0];
    const text = JSON.stringify(snapshot.entry.content);
    expect(text).toContain("no longer exists");
    expect(text).toContain("/repo-partial-swept");
  });
});

describe("R5F2: the four-state x cap matrix (each state protects the session, and disposal hands off the frozen worktree)", () => {
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
        workspacePath: "/repo-matrix",
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  };

  async function buildState1Recovering(): Promise<{
    readonly h: Harness;
    readonly text: string;
  }> {
    const text = "state-1 recovering prompt";
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);
    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    const h = createHarness();
    emitOwnerSnapshot(h.callbacks());
    const { clientActionId } = sendMessageWithContent(
      h,
      hashOnlyContent(hash, text),
    );
    rejectMissingAttachmentBytes(h, clientActionId, "not-on-host");
    expect(
      Object.keys(h.handle.store.getState().hashOnlyRecoveries),
    ).toHaveLength(1);
    return { h, text };
  }

  async function buildState2DispatchedRetry(): Promise<{
    readonly h: Harness;
    readonly text: string;
  }> {
    const text = "state-2 dispatched-retry prompt";
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);
    const hash = await seedConfirmedImage(pngBytesOfSize(32));
    const h = createHarness();
    emitOwnerSnapshot(h.callbacks());
    const { clientActionId } = sendMessageWithContent(
      h,
      hashOnlyContent(hash, text),
    );
    rejectMissingAttachmentBytes(h, clientActionId, "not-on-host");
    await vi.waitFor(() => {
      expect(h.sent).toHaveLength(2);
    });
    expect(
      Object.values(h.handle.store.getState().pendingActions).some(
        (action) => action.hashOnlyRetry,
      ),
    ).toBe(true);
    return { h, text };
  }

  function buildState3HandedBack(): {
    readonly h: Harness;
    readonly text: string;
  } {
    const text = "state-3 handed-back prompt";
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);
    const h = createHarness();
    emitOwnerSnapshot(h.callbacks());
    const { clientActionId } = sendMessageWithContent(h, plainContent(text));
    rejectPlain(h, clientActionId, "Not accepted.");
    expect(
      h.handle.store.getState().failedSendRestoration?.clientActionId,
    ).toBe(clientActionId);
    return { h, text };
  }

  function buildState4UndeliveredNotice(): {
    readonly h: Harness;
    readonly text: string;
  } {
    useWorktreeIntentStagingStore.getState().stageIntent(stagingKey, intent);
    const h = createHarness();
    emitOwnerSnapshot(h.callbacks());
    const a = sendMessageWithContent(h, plainContent("occupies the slot"));
    rejectPlain(h, a.clientActionId, "A not accepted.");
    const text = "state-4 undelivered-notice prompt";
    const b = sendMessageWithContent(h, plainContent(text));
    rejectPlain(h, b.clientActionId, "B not accepted.");
    expect(
      Object.hasOwn(
        h.handle.store.getState().lastCopyPrompts,
        b.clientActionId,
      ),
    ).toBe(true);
    return { h, text };
  }

  const states: ReadonlyArray<{
    readonly name: string;
    readonly build: () =>
      | { readonly h: Harness; readonly text: string }
      | Promise<{ readonly h: Harness; readonly text: string }>;
  }> = [
    { name: "(1) recovering", build: buildState1Recovering },
    {
      name: "(2) dispatched retry, unacknowledged",
      build: buildState2DispatchedRetry,
    },
    {
      name: "(3) handed back, not consumed",
      build: buildState3HandedBack,
    },
    {
      name: "(4) undelivered last-copy notice",
      build: buildState4UndeliveredNotice,
    },
  ];

  for (const { name, build } of states) {
    it(`state ${name}: held past idle expiry, disposed only at the deferral cap, prompt reaches the stash with its worktree named`, async () => {
      const { h, text } = await build();
      harness = h;

      const registry = new ChatSessionRegistry({
        idleTtlMs: 5_000,
        maxWarmSessions: 8,
      });
      const target: ChatSessionTarget = {
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: `matrix-${name}`,
      };
      registry.acquire(target, () => h.handle);

      vi.useFakeTimers();
      try {
        registry.release(EPIC_ID, CHAT_ID, HOST_ID);
        await vi.advanceTimersByTimeAsync(
          MAX_ACTIVE_CHAT_IDLE_DEFER_MS - 10_000,
        );
        expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).not.toBeNull();

        await vi.advanceTimersByTimeAsync(20_000);
        expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
      } finally {
        vi.useRealTimers();
      }

      await vi.waitFor(() => {
        expect(promptStashMocks.save).toHaveBeenCalled();
      });
      const savedTexts = promptStashMocks.save.mock.calls.map(([snapshot]) =>
        JSON.stringify(snapshot.entry.content),
      );
      expect(savedTexts.some((saved) => saved.includes(text))).toBe(true);
      expect(
        savedTexts.some(
          (saved) => saved.includes(text) && saved.includes("/repo-matrix"),
        ),
      ).toBe(true);
      // Deliberately NOT asserting whether the image survived.
      //
      // Two wrong versions preceded this one. The first claimed the bytes are
      // never resolvable here - false: `seedConfirmedImage` calls the real
      // `putImage`, so they are in this window's landing partition. The second
      // asserted per-case survival and failed on state (2), which reported
      // "the bytes could not be read in time".
      //
      // That second failure is a RACE these cases cannot settle, and the fake
      // clock only makes it easy to observe: they advance an HOUR to reach the
      // deferral cap with the disposal inside that advance, so the handoff's
      // 5 s deadline fires immediately against an image read that completes in
      // microtasks. Which one wins differs between otherwise identical states.
      //
      // Not "a harness artefact" - that framing was too categorical and the
      // reviewer disproved it with a real-timer probe: with the bytes local,
      // an event-loop stall long enough to outlast the deadline still drops
      // the image. That is the fallback behaving as designed - the words are
      // what the deadline protects - but it is production behaviour, not a
      // property of fake timers. Encoding either outcome here would be
      // encoding the race.
      //
      // Image survival is asserted where it is deterministic: the real-
      // repository round trip in
      // `lib/drafts/__tests__/unrecorded-prompt-handoff-real-repository.test.ts`
      // and the capacity case in the R6F3 file. What THIS matrix claims is the
      // text and the worktree, and that is what it checks.
      const matching = promptStashMocks.save.mock.calls
        .map(([snapshot]) => snapshot)
        .filter((snapshot) =>
          JSON.stringify(snapshot.entry.content).includes(text),
        );
      expect(matching.length).toBeGreaterThan(0);

      // Coverage fix: replay the actual matching snapshot through the real
      // repository rather than trusting the mocked call args alone.
      const restored = await assertMatchingSnapshotSurvivesRealRepository(text);
      expect(JSON.stringify(restored)).toContain(text);
    });

    it(`state ${name}: held during warm-cap overflow (a plain otherwise-idle sibling is evicted instead), and eventually the deferral cap disposes it with the prompt stashed`, async () => {
      const { h, text } = await build();
      harness = h;

      const siblingEpicId = `epic-matrix-sibling-${name}`;
      const siblingChatId = `chat-matrix-sibling-${name}`;
      const siblingHandle = createIdleChatHandle(
        siblingEpicId,
        siblingChatId,
        HOST_ID,
      );
      secondHarness = null;

      const registry = new ChatSessionRegistry({
        idleTtlMs: 60 * 60 * 1_000,
        maxWarmSessions: 1,
      });
      const target: ChatSessionTarget = {
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: `matrix-overflow-${name}`,
      };
      const siblingTarget: ChatSessionTarget = {
        epicId: siblingEpicId,
        chatId: siblingChatId,
        hostId: HOST_ID,
        scopeKey: `matrix-overflow-${name}`,
      };
      registry.acquire(target, () => h.handle);
      registry.acquire(siblingTarget, () => siblingHandle);
      registry.release(EPIC_ID, CHAT_ID, HOST_ID);
      registry.release(siblingEpicId, siblingChatId, HOST_ID);

      // The holder survives the overflow sweep; the plain sibling, with
      // nothing to lose, is the one the cap picks instead.
      expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBe(h.handle);
      expect(registry.peek(siblingEpicId, siblingChatId, HOST_ID)).toBeNull();

      // Past the deferral cap, the hold no longer protects it either.
      const reacquired = registry.acquire(target, () => {
        throw new Error("must not rebuild before the deferral cap elapses");
      });
      expect(reacquired).toBe(h.handle);

      vi.useFakeTimers();
      try {
        registry.release(EPIC_ID, CHAT_ID, HOST_ID);
        await vi.advanceTimersByTimeAsync(
          MAX_ACTIVE_CHAT_IDLE_DEFER_MS + 1_000,
        );
        expect(registry.peek(EPIC_ID, CHAT_ID, HOST_ID)).toBeNull();
      } finally {
        vi.useRealTimers();
      }

      await vi.waitFor(() => {
        expect(promptStashMocks.save).toHaveBeenCalled();
      });
      const savedTexts = promptStashMocks.save.mock.calls.map(([snapshot]) =>
        JSON.stringify(snapshot.entry.content),
      );
      expect(savedTexts.some((saved) => saved.includes(text))).toBe(true);

      // Coverage fix: replay the actual matching snapshot through the real
      // repository rather than trusting the mocked call args alone.
      const restored = await assertMatchingSnapshotSurvivesRealRepository(text);
      expect(JSON.stringify(restored)).toContain(text);
    });
  }
});
