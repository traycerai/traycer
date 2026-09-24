import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * W-2: EVERY RENDERER HOLDER OF HASH-ONLY CONTENT THAT CAN OUTLIVE A DRAFT
 * CLEAR IS A GC ROOT.
 *
 * The local image store is content-addressed and swept: `clearAcceptedDraft`
 * schedules a reconcile, the first pass releases session bytes nothing roots
 * and the next deletes them from IndexedDB. Only the composer/modal/stash
 * drafts and the initial-chat handoff were rooted, so everything that holds a
 * document BETWEEN a draft clear and its own resolution was sweeping its own
 * bytes out from under itself.
 *
 * Each case below is the same shape as
 * `landing-image-gc-handoff-root.test.ts`: put bytes in, make the holder the
 * ONLY thing referencing them (`releaseSession` drops the session cache's own
 * protection, or a surviving warm entry would mask a broken root), run the
 * real reconcile, and look in IndexedDB. Every positive is paired with the
 * negative that proves the root is the holder's and is RELEASED with it -
 * without those, a root that simply never lets go would pass every case above.
 */

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn() }),
}));

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const OWNER_ID = "owner-1";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function hashOnlyImageDoc(hash: string): JsonContent {
  return {
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
              size: 3,
              byHashEligible: true,
              hash,
            },
          },
          { type: "text", text: "look" },
        ],
      },
    ],
  };
}

interface Modules {
  readonly gc: typeof import("@/lib/composer/landing-image-gc");
  readonly store: typeof import("@/lib/composer/landing-image-store");
  readonly budget: typeof import("@/lib/composer/landing-image-budget");
  readonly session: typeof import("@/stores/chats/chat-session-store");
}

/**
 * One module graph per case. Everything that participates in rooting has to be
 * imported AFTER the same `resetModules`, or the store under test would
 * register its root source on a different `landing-image-budget` instance than
 * the one the sweep reads - which reads exactly like a missing root.
 */
async function loadModules(): Promise<Modules> {
  vi.resetModules();
  idbData.clear();
  Reflect.deleteProperty(globalThis, "runnerHost");
  const idb = await import("idb-keyval");
  vi.mocked(idb.set).mockImplementation((key, value) => {
    idbData.set(idbStringKey(key), value);
    return Promise.resolve();
  });
  vi.mocked(idb.get).mockImplementation((key) =>
    Promise.resolve(idbData.get(idbStringKey(key))),
  );
  vi.mocked(idb.del).mockImplementation((key) => {
    idbData.delete(idbStringKey(key));
    return Promise.resolve();
  });
  vi.mocked(idb.keys).mockImplementation(() =>
    Promise.resolve(Array.from(idbData.keys())),
  );
  const store = await import("@/lib/composer/landing-image-store");
  const budget = await import("@/lib/composer/landing-image-budget");
  const gc = await import("@/lib/composer/landing-image-gc");
  const session = await import("@/stores/chats/chat-session-store");
  gc.markLandingDraftsReady();
  await flush();
  return { gc, store, budget, session };
}

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  callbacks(): ChatStreamCallbacks;
}

function createHarness(session: Modules["session"]): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = session.createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
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
        // These roots are about GC, not about the wire shape: a session that
        // cannot bridge is the conservative answer and keeps every image node
        // in this file inline-bound, which is what the holders here root.
        draftBlobBridgeSupported: () => false,
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

function emitSnapshot(harness: Harness): void {
  harness.callbacks().onConnectionStatus("open", null, null);
  harness.callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
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

function queuedPromptItem(
  queueItemId: string,
  content: JsonContent,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId: `m-${queueItemId}`,
    message: { kind: "user" as const, content, browserAnnotations: [] },
    sender: { type: "user" as const, userId: OWNER_ID },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    sentFromHostId: null,
    delivery: "next_turn" as const,
    status: "pending" as const,
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function chatEvent(
  eventId: string,
  type: ChatEvent["type"],
  metadata: Record<string, unknown>,
): ChatEvent {
  return {
    eventId,
    type,
    timestamp: 1,
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

/**
 * The precondition for a cancel that PARKS its content:
 * `setupFailedQueueRowRestore` hands the prompt back only for a row whose
 * worktree provisioning failed, which it decides from the setup-card window
 * whose `setup.creating` names this row's message.
 */
function emitFailedSetupFor(harness: Harness, messageId: string): void {
  const events: ReadonlyArray<ChatEvent> = [
    chatEvent("event-creating", "setup.creating", {
      workspacePath: "/repo",
      triggeringMessageId: messageId,
    }),
    chatEvent("event-failed", "setup.failed", {
      workspacePath: "/repo",
      setupExitCode: 2,
    }),
  ];
  for (const event of events) {
    harness.callbacks().onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event,
    });
  }
}

function emitQueue(
  harness: Harness,
  items: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  harness.callbacks().onQueueChanged({
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    queue: { status: "running", items: [...items] },
  });
}

let urlCounter = 0;

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:mock/${++urlCounter}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "runnerHost");
});

describe("landing image GC: a PENDING SEND's restore roots its images", () => {
  it("a hash held only by an in-flight send's restore survives the sweep", async () => {
    const m = await loadModules();
    const harness = createHarness(m.session);
    emitSnapshot(harness);
    const hash = await m.store.putImage(bytesOf([4, 5, 6]));
    const content = hashOnlyImageDoc(hash);

    // The send dispatches and the composer draft is cleared in the same tick;
    // from here the pending action's `restore` is the only local reference.
    const sent = harness.handle.store.getState().sendMessage({
      content,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: [],
      // The ordinary send path. Which policy this is does not matter to the
      // pin - what roots the hash is the pending action's `restore` - but it
      // has to be a real member of `ChatQueueDeliveryPolicy`.
      deliveryPolicy: "auto",
      restore: { content, browserAnnotations: [] },
    });
    expect(sent).not.toBeNull();
    m.store.releaseSession(hash);

    await m.gc.reconcile();
    await flush();

    // Without this the host refusing the send AFTER both sweeps would restore
    // a prompt whose only local bytes had been deleted.
    expect(await m.store.imageHashKeys()).toContain(hash);
  });

  it("control: the same hash is collected when no send is outstanding", async () => {
    const m = await loadModules();
    const harness = createHarness(m.session);
    emitSnapshot(harness);
    const hash = await m.store.putImage(bytesOf([4, 5, 6]));
    m.store.releaseSession(hash);

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).not.toContain(hash);
  });
});

describe("landing image GC: a QUEUED prompt roots its images", () => {
  it("a hash held only by a queued item survives the sweep", async () => {
    const m = await loadModules();
    const harness = createHarness(m.session);
    emitSnapshot(harness);
    const hash = await m.store.putImage(bytesOf([7, 8, 9]));
    // A queued prompt is re-derived from this payload at drain time, and the
    // queued-blob repair only runs for an item still IN the queue - so this
    // root is also what spans the window between `send.failed` and the
    // re-upload.
    emitQueue(harness, [queuedPromptItem("q-1", hashOnlyImageDoc(hash))]);
    m.store.releaseSession(hash);

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).toContain(hash);
  });

  it("control: the same hash is collected once the item leaves the queue", async () => {
    const m = await loadModules();
    const harness = createHarness(m.session);
    emitSnapshot(harness);
    const hash = await m.store.putImage(bytesOf([7, 8, 9]));
    emitQueue(harness, [queuedPromptItem("q-1", hashOnlyImageDoc(hash))]);
    m.store.releaseSession(hash);
    emitQueue(harness, []);

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).not.toContain(hash);
  });
});

describe("landing image GC: a CANCEL awaiting its ack roots its images", () => {
  it("a hash held only by a pending cancel restoration survives the sweep", async () => {
    const m = await loadModules();
    const harness = createHarness(m.session);
    emitSnapshot(harness);
    const hash = await m.store.putImage(bytesOf([2, 4, 6]));
    emitQueue(harness, [queuedPromptItem("q-1", hashOnlyImageDoc(hash))]);
    emitFailedSetupFor(harness, "m-q-1");

    // The cancel takes the row out of the queue and parks its content in
    // `pendingCancelRestorations` - the host can still refuse the cancel, so
    // the content is held across that round trip and rooted with it.
    expect(harness.handle.store.getState().queueCancel("q-1")).not.toBeNull();
    expect(
      Object.keys(harness.handle.store.getState().pendingCancelRestorations),
    ).toHaveLength(1);
    emitQueue(harness, []);
    m.store.releaseSession(hash);

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).toContain(hash);
  });

  // The control the other two holders already had, and this one did not. A
  // positive alone cannot tell "the cancel restoration roots it" from "something
  // else in this harness roots everything": the queue emit, the failed setup and
  // the snapshot all touch state, and any of them keeping the hash alive would
  // read as a pass. Same hash, same harness, same sweep - only the cancel is
  // missing, and the sweep must then collect it.
  it("control: the same hash is collected when no cancel is outstanding", async () => {
    const m = await loadModules();
    const harness = createHarness(m.session);
    emitSnapshot(harness);
    const hash = await m.store.putImage(bytesOf([2, 4, 6]));
    emitQueue(harness, [queuedPromptItem("q-1", hashOnlyImageDoc(hash))]);
    emitFailedSetupFor(harness, "m-q-1");

    // The row leaves the queue with NO cancel parked behind it, so nothing in
    // this store names the hash once the queue is empty.
    emitQueue(harness, []);
    expect(
      Object.keys(harness.handle.store.getState().pendingCancelRestorations),
    ).toHaveLength(0);
    m.store.releaseSession(hash);

    await m.gc.reconcile();
    await flush();

    expect(await m.store.imageHashKeys()).not.toContain(hash);
  });
});
