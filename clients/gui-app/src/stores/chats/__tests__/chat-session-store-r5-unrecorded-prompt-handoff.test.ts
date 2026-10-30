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
 * Nothing is mocked on the destination side: the handoff's last step is a
 * synchronous `installLandingDraft`, so the REAL landing draft store is both
 * the observation surface and the durability proof. That is the whole point of
 * R5F1 - a document that merely "looks right" to a mock can still be one the
 * real destination refuses, and here there is no gap between the two.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
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
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";
import {
  deleteLandingDraftOnHost,
  LANDING_DRAFT_PERSIST_KEY,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  landingDraftIsRetired,
  resetLandingDraftRetirementsForTests,
} from "@/lib/drafts/landing-draft-retirement";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { putImage } from "@/lib/composer/landing-image-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import { pngBytesOfSize } from "@/lib/composer/__tests__/image-fixtures";
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
  handedOffDrafts,
  resetHandedOffDrafts,
  waitForHandedOffDraft,
} from "@/stores/chats/__tests__/handoff-draft-observer";
import {
  ChatSessionRegistry,
  MAX_ACTIVE_CHAT_IDLE_DEFER_MS,
  type ChatSessionTarget,
} from "@/stores/chats/session-registry";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

// Ids the next `uuid` v4 calls answer with, oldest first; empty means real ids.
// A send's `clientActionId` is the first v4 it draws, so queueing one here
// makes a second chat send under an action id a first chat already used.
const pinnedV4Ids = vi.hoisted((): string[] => []);
vi.mock("uuid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("uuid")>();
  return { ...actual, v4: () => pinnedV4Ids.shift() ?? actual.v4() };
});

const originalCreateImageBitmap = globalThis.createImageBitmap;

const EPIC_ID = "epic-r5";
const CHAT_ID = "chat-r5";
const OWNER_ID = "owner-r5";
const HOST_ID = "host-r5";

const SETTINGS: ChatRunSettings = {
  ultracode: false,
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
      portForwards: [],
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

/**
 * The installed draft whose content contains `text`, from the REAL landing
 * draft store. Every matrix case below used to inspect only a mock's call args
 * - a real gap, since a mock accepts a document of any shape. There is no mock
 * left to accept one: what these read IS the durable row.
 */
function installedDraftContaining(text: string): JsonContent {
  const match = handedOffDrafts().find((draft) =>
    JSON.stringify(draft.content).includes(text),
  );
  expect(match).toBeDefined();
  if (match === undefined) {
    throw new Error(`expected an installed draft containing ${text}`);
  }
  return match.content;
}

let harness: Harness | null = null;
let secondHarness: Harness | null = null;

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
      expect(
        handedOffDrafts().some((snapshot) =>
          JSON.stringify(snapshot.content).includes(B_TEXT),
        ),
      ).toBe(true);
    });

    // Durability proof: the row B was handed off as is in the real store, not
    // merely "looks right" to a mock.
    const bSnapshot = handedOffDrafts().find((snapshot) =>
      JSON.stringify(snapshot.content).includes(B_TEXT),
    );
    expect(bSnapshot).toBeDefined();
    if (bSnapshot === undefined) throw new Error("expected B's snapshot");
    expect(JSON.stringify(bSnapshot.content)).toContain(B_TEXT);
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
          handedOffDrafts().some((snapshot) =>
            JSON.stringify(snapshot.content).includes(A_TEXT),
          ),
        ).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
    const texts = handedOffDrafts().map((snapshot) =>
      JSON.stringify(snapshot.content),
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

    const text = await waitForHandedOffDraft(
      "/repo-primary-worktree",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
    // Every staged entry named, not just the primary `workspacePath` - and via
    // `retryHandoffAccountFor`, which the preconditions above pin.
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

    // The wait IS the assertion: it settles only once a handed-off draft names
    // this worktree, which is what `displacedReason` (not `reason`) carries.
    await waitForHandedOffDraft(
      "/repo-restoration",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
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

    const text = await waitForHandedOffDraft(
      "no longer exists",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
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

    const text = await waitForHandedOffDraft(
      "no longer exists",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
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

    const text = await waitForHandedOffDraft(
      "no longer exists",
      HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000,
    );
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
        expect(
          handedOffDrafts().some((snapshot) =>
            JSON.stringify(snapshot.content).includes(text),
          ),
        ).toBe(true);
      });
      const savedTexts = handedOffDrafts().map((snapshot) =>
        JSON.stringify(snapshot.content),
      );
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
      // `lib/drafts/__tests__/unrecorded-prompt-handoff-landing-install.test.ts`
      // and the capacity case in the R6F3 file. What THIS matrix claims is the
      // text and the worktree, and that is what it checks.
      const matching = handedOffDrafts().filter((snapshot) =>
        JSON.stringify(snapshot.content).includes(text),
      );
      expect(matching.length).toBeGreaterThan(0);

      // Coverage fix: read the actual matching row out of the real store rather than trusting the mocked call args alone.
      expect(JSON.stringify(installedDraftContaining(text))).toContain(text);
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
        expect(
          handedOffDrafts().some((snapshot) =>
            JSON.stringify(snapshot.content).includes(text),
          ),
        ).toBe(true);
      });

      // Coverage fix: read the actual matching row out of the real store rather than trusting the mocked call args alone.
      expect(JSON.stringify(installedDraftContaining(text))).toContain(text);
    });
  }
});

describe("a disposed chat's prompt whose draft the browser refuses to save", () => {
  it("stays readable in Drafts for the session: the chat held the last copy", async () => {
    const text = "unrecorded message whose chat is disposed";
    harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    const action = sendMessageWithContent(harness, plainContent(text));
    rejectPlain(
      harness,
      action.clientActionId,
      "The host refused the message.",
    );
    // Rejected while hidden: this is the session's only copy of the prompt.
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(plainContent(text));
    const write = localStorage.setItem.bind(localStorage);
    const refuse = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((name, value) => {
        if (name === LANDING_DRAFT_PERSIST_KEY)
          throw new DOMException("No room", "QuotaExceededError");
        write(name, value);
      });
    try {
      harness.handle.dispose();
      expect(await waitForHandedOffDraft(text, 1000)).toContain(text);
    } finally {
      refuse.mockRestore();
    }
  });

  describe("with every landing write refused", () => {
    const REFUSED_TEXT = "unrecorded message the browser cannot save";

    let landingWriteRefusal: MockInstance<Storage["setItem"]> | null = null;

    beforeEach(() => {
      landingWriteRefusal = null;
      resetLandingDraftRetirementsForTests();
      pinnedV4Ids.length = 0;
    });

    afterEach(() => {
      landingWriteRefusal?.mockRestore();
      landingWriteRefusal = null;
      resetLandingDraftRetirementsForTests();
      pinnedV4Ids.length = 0;
    });

    function rowsHolding(text: string) {
      return useLandingDraftStore
        .getState()
        .drafts.filter((draft) => JSON.stringify(draft.content).includes(text));
    }

    function refuseLandingWrites(): void {
      const write = localStorage.setItem.bind(localStorage);
      landingWriteRefusal = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation((name, value) => {
          if (name === LANDING_DRAFT_PERSIST_KEY)
            throw new DOMException("No room", "QuotaExceededError");
          write(name, value);
        });
    }

    // The crop of an annotation the prompt carries. A landing draft has no
    // annotation sidecar, so once the chat is disposed the only thing naming
    // this hash is the teardown's own capture root - which the handoff
    // releases in its final `finally`, after every attempt and the second
    // chance have settled.
    const CROP_HASH = "b".repeat(64);

    function cropAnnotation(): BrowserAnnotationRecord {
      return {
        kind: "browser-annotation",
        annotationId: "ann-refused-teardown",
        tabId: "tab-1",
        sessionId: "session-1",
        origin: "https://example.test",
        pageUrl: "https://example.test/checkout",
        pageTitle: "Checkout",
        source: {
          kind: "browser",
          tabId: "tab-1",
          sessionId: "session-1",
          origin: "https://example.test",
          pageUrl: "https://example.test/checkout",
          pageTitle: "Checkout",
        },
        capturedAt: 1_700_000_000_000,
        comment: "the button is misaligned",
        counts: { elements: 1, regions: 0, strokes: 2 },
        elements: [],
        imageFileName: "crop.png",
        imageHash: CROP_HASH,
        droppedElementCount: 0,
      };
    }

    /**
     * Has `chat` hold a rejected prompt and disposes it with the browser
     * refusing the landing-draft key. Resolves once the teardown handoff has
     * settled: its capture root for the crop is held the instant the chat is
     * gone and released only when the whole chain is done. Every state the
     * landing store passes through on the way is recorded.
     */
    async function disposeRefusedChat(
      chat: Harness,
      text: string,
      content: JsonContent,
    ): Promise<{ readonly clientActionId: string; readonly seen: string[][] }> {
      emitOwnerSnapshot(chat.callbacks());
      const action = chat.handle.store.getState().sendMessage({
        content,
        sender: { type: "user", userId: OWNER_ID },
        settings: SETTINGS,
        attachments: buildAttachmentsFromJSONContent(content),
        deliveryPolicy: "auto",
        restore: { content, browserAnnotations: [cropAnnotation()] },
      });
      if (action === null) throw new Error("sendMessage was refused");
      rejectPlain(chat, action.clientActionId, "The host refused the message.");
      refuseLandingWrites();
      // The ids of the rows holding the prompt after EVERY change, so a copy
      // that exists only between two attempts is still seen.
      const seen: string[][] = [];
      const stop = useLandingDraftStore.subscribe(() => {
        seen.push(rowsHolding(text).map((row) => row.id));
      });
      try {
        chat.handle.dispose();
        expect(landingLiveImageRootHashes().has(CROP_HASH)).toBe(true);
        await vi.waitFor(
          () => expect(landingLiveImageRootHashes().has(CROP_HASH)).toBe(false),
          { timeout: 1000 },
        );
      } finally {
        stop();
      }
      return { clientActionId: action.clientActionId, seen };
    }

    it("leaves exactly one readable copy, at every step of the teardown", async () => {
      harness = createHarness();
      const { seen } = await disposeRefusedChat(
        harness,
        REFUSED_TEXT,
        plainContent(REFUSED_TEXT),
      );

      const rows = rowsHolding(REFUSED_TEXT);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]?.content)).toContain(REFUSED_TEXT);
      // Between the first attempt landing and the second chance running, the
      // store never held a second row, nor a different id for the prompt.
      expect(new Set(seen.flat()).size).toBe(1);
      expect(Math.max(...seen.map((ids) => ids.length))).toBe(1);
    });

    it("still leaves one copy when the image read fails and the second chance runs", async () => {
      // A hash no store holds and no host serves: the real resolver answers
      // nothing, the import throws, and the first write of the shared id is
      // the text-only install in the handoff's own catch. Its row lands in
      // memory, the refused write throws, and the teardown's second chance
      // runs against that row.
      harness = createHarness();
      const { seen } = await disposeRefusedChat(
        harness,
        REFUSED_TEXT,
        hashOnlyContent("a".repeat(64), REFUSED_TEXT),
      );

      expect(rowsHolding(REFUSED_TEXT)).toHaveLength(1);
      expect(new Set(seen.flat()).size).toBe(1);
      expect(Math.max(...seen.map((ids) => ids.length))).toBe(1);
    });

    it("does not bring the prompt back once the person deleted it from Drafts", async () => {
      harness = createHarness();
      const { clientActionId } = await disposeRefusedChat(
        harness,
        REFUSED_TEXT,
        plainContent(REFUSED_TEXT),
      );
      const copies = rowsHolding(REFUSED_TEXT);
      expect(copies.length).toBeGreaterThan(0);
      // The person frees some room before deleting, so the delete itself is
      // not what the browser refuses; the second teardown meets a full one.
      landingWriteRefusal?.mockRestore();
      for (const copy of copies) deleteLandingDraftOnHost(copy.id, HOST_ID);
      expect(rowsHolding(REFUSED_TEXT)).toHaveLength(0);
      expect(copies.every((copy) => landingDraftIsRetired(copy.id))).toBe(true);

      // Another chat sends under the same action id and is disposed the same
      // way: the same prompt, already discarded by the person.
      secondHarness = createHarness();
      pinnedV4Ids.push(clientActionId);
      const again = await disposeRefusedChat(
        secondHarness,
        REFUSED_TEXT,
        plainContent(REFUSED_TEXT),
      );
      expect(again.clientActionId).toBe(clientActionId);

      // The handoff has settled, and no state the store passed through held
      // the prompt: the retired id refused every install.
      expect(again.seen.flat()).toEqual([]);
      expect(rowsHolding(REFUSED_TEXT)).toHaveLength(0);
    });
  });
});
