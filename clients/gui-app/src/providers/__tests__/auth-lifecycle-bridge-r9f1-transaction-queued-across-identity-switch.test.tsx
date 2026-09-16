/**
 * R9F1 (P1, cross-account leak): the identity fence did not reach the
 * IndexedDB transaction. Both prior checks (`stillCurrent()` before
 * `hydrate()`, and again right after) pass, and only THEN does
 * `runTransaction` open a transaction that can queue behind another one and
 * commit after the account has already switched - the reviewer's repro is a
 * separate transaction simply holding the stash's own object stores.
 *
 * `savePromptStashSnapshotWhile` now re-checks `stillCurrent()` from INSIDE
 * the transaction, at the last point before any write, and aborts the whole
 * transaction if it fails. This file drives that queued-transaction repro
 * directly against the real repository (fake IndexedDB, no store mock), for
 * both the ordinary primary save and the text-only retry a capacity refusal
 * falls back to - both go through the SAME `savePromptStashSnapshotWhile`
 * call and the same `stillCurrent` closure, but they are driven by two
 * different transactions and the fix has to hold for each one separately.
 */
import "./install-fresh-indexeddb-eagerly";

import { IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";

import { EpicSessionLifecycleBridge } from "@/providers/auth-lifecycle-bridge";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { usePromptStashStore } from "@/stores/composer/prompt-stash-store";
import {
  loadPromptStashSnapshot,
  PROMPT_STASH_BUDGET_BYTES,
  PROMPT_STASH_DB_NAME,
} from "@/lib/composer/prompt-stash-repository";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";
import { pngBytesOfSize } from "@/lib/composer/__tests__/prompt-stash-image-fixtures";
import {
  imageEntry,
  openDb,
  requestToPromise,
  sha256Hex,
  transactionComplete,
} from "@/lib/composer/__tests__/prompt-stash-repository-test-helpers";

/**
 * Resolves whatever bytes the test has registered for a hash, matching
 * `resolveDraftImageBytes`'s real signature. Defaults to `null` (the shape
 * every other test in this feature already relies on) so registering a hash
 * here is opt-in per test.
 */
const imageBytesByHash = vi.hoisted(
  () => new Map<string, Uint8Array<ArrayBuffer>>(),
);
vi.mock("@/lib/drafts/resolve-draft-image-bytes", () => ({
  resolveDraftImageBytes: (hash: string) =>
    Promise.resolve(imageBytesByHash.get(hash) ?? null),
}));

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const CHAT_HOST_ID = "host-r9f1";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function plainContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function hashOnlyContent(
  hash: string,
  text: string,
  size: number,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "image-r9f1",
          fileName: "shot.png",
          mimeType: "image/png",
          size,
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

function createHarness(
  epicId: string,
  chatId: string,
  userId: string,
): Harness {
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: CHAT_HOST_ID,
    epicId,
    chatId,
    userId,
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

function emitOwnerSnapshot(
  callbacks: ChatStreamCallbacks,
  epicId: string,
  chatId: string,
  ownerId: string,
): void {
  callbacks.onConnectionStatus("open", null, null);
  const chat: Chat = {
    id: chatId,
    parentId: null,
    userId: ownerId,
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
      access: { role: "owner", ownerUserId: ownerId, canAct: true },
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

function sendAndReject(args: {
  readonly harness: Harness;
  readonly epicId: string;
  readonly chatId: string;
  readonly ownerId: string;
  readonly content: JsonContent;
}): void {
  const { harness, epicId, chatId, ownerId, content } = args;
  const action = harness.handle.store.getState().sendMessage({
    content,
    sender: { type: "user", userId: ownerId },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(content),
    deliveryPolicy: "auto",
    restore: { content, browserAnnotations: [] },
  });
  expect(action).not.toBeNull();
  if (action === null) throw new Error("sendMessage was refused");
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId,
    chatId,
    clientActionId: action.clientActionId,
    action: "send",
    status: "rejected",
    reason: "Not accepted.",
    code: null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in",
  email: string | null,
  userId: string | null,
): void {
  if (status === "signed-in" && email !== null && userId !== null) {
    useAuthStore.setState({
      status,
      profile: { userId, userName: email, email },
      contextMetadata: { userId, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

async function stashRows(): Promise<ReadonlyArray<unknown>> {
  await usePromptStashStore.getState().hydrate();
  return usePromptStashStore.getState().rows;
}

async function stashContainsText(text: string): Promise<boolean> {
  const [memoryRows, { rows: durableRows }] = await Promise.all([
    stashRows(),
    loadPromptStashSnapshot(),
  ]);
  const inMemory = memoryRows.some((row) => JSON.stringify(row).includes(text));
  const durable = durableRows.some((row) => JSON.stringify(row).includes(text));
  return inMemory || durable;
}

/**
 * Holds a REAL read-write transaction open on the prompt stash's own three
 * stores until `release()` is called - the reviewer's repro, a separate
 * transaction simply holding the stores. `runTransaction`'s own transactions
 * share this scope, so every one of them queues behind this one and cannot
 * even begin its work (including the `stillCurrent()` re-check the fix
 * added) until this releases.
 *
 * `fake-indexeddb` commits a transaction the instant its request queue is
 * empty at the end of a scheduling round, so "holding it open" means never
 * letting that queue run empty: each request re-queues another cheap one
 * from inside its own success handler, synchronously, before the scheduler
 * gets a chance to see the queue as drained.
 */
async function holdPromptStashTransactionOpen(): Promise<() => void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PROMPT_STASH_DB_NAME);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        request.error ?? new Error("Could not open the prompt stash database."),
      );
    };
  });
  const tx = db.transaction(["entries", "blobs", "meta"], "readwrite");
  tx.oncomplete = () => {
    db.close();
  };
  let stopped = false;
  const pump = (): void => {
    if (stopped) return;
    const request = tx.objectStore("meta").get("state");
    request.onsuccess = () => {
      pump();
    };
    request.onerror = () => undefined;
  };
  pump();
  return () => {
    stopped = true;
  };
}

/**
 * Sibling entry whose blob alone consumes the entire prompt-stash budget, so a
 * PRIMARY save of even a small valid image genuinely overflows it -
 * `savePromptStashSnapshotWhile`'s own budget arithmetic, not the 5 MiB
 * image-preparation ceiling `resolveDraftImageBytes` never even lets a
 * too-large hash-only attachment past. Written directly into the "entries"
 * and "blobs" stores, bypassing the repository entirely: a real send's own
 * budget arithmetic sums `keptBytes` from whatever the store already holds
 * for OTHER entries, so this only has to be a well-formed sibling, not
 * something the repository itself wrote.
 */
const RETRY_FILLER_HASH = "f".repeat(64);

async function seedCapacityFillerEntry(byteLength: number): Promise<void> {
  const db = await openDb(PROMPT_STASH_DB_NAME, undefined, undefined);
  try {
    const tx = db.transaction(["entries", "blobs"], "readwrite");
    await requestToPromise(
      tx
        .objectStore("entries")
        .put(imageEntry("filler-r9f1-retry-capacity", 0, RETRY_FILLER_HASH)),
    );
    await requestToPromise(
      tx.objectStore("blobs").put({
        hash: RETRY_FILLER_HASH,
        bytes: new Uint8Array(byteLength),
        byteLength,
        mimeType: "image/png",
      }),
    );
    await transactionComplete(tx);
  } finally {
    db.close();
  }
}

/**
 * Fires `onEntriesPutSuccess` synchronously inside the REAL `entries.put`
 * request's own "success" event - registered via `addEventListener` before
 * `savePromptStashSnapshotWhile`'s own `requestToPromise` attaches its
 * `onsuccess` property handler, so this callback runs first and can switch
 * identity before that `await` even resumes.
 *
 * For the capacity-refused retry scenario this is, deliberately, the ONLY
 * `entries.put` the whole handoff ever makes: the oversubscribed PRIMARY
 * attempt throws `PromptStashCapacityExceededError` before it reaches any
 * store write at all (the budget check runs before the first `put`), so this
 * hook fires once, for the RETRY's own transaction - landing the switch
 * squarely inside the second transaction, not the first.
 */
type PutMethod = (
  this: IDBObjectStore,
  value: unknown,
  key: IDBValidKey | undefined,
) => IDBRequest<IDBValidKey>;

function hookEntriesPutSuccess(onEntriesPutSuccess: () => void): () => void {
  // Read through the property descriptor, not `FakeIDBObjectStore.prototype
  // .put` directly - that bare member access is exactly what `@typescript-
  // eslint/unbound-method` flags, even though every call below supplies
  // `this` explicitly via `.call`.
  const descriptor = Object.getOwnPropertyDescriptor(
    FakeIDBObjectStore.prototype,
    "put",
  );
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("Expected IDBObjectStore.prototype.put to exist.");
  }
  const original: PutMethod = descriptor.value as PutMethod;
  FakeIDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    value: unknown,
    key: IDBValidKey | undefined,
  ): IDBRequest<IDBValidKey> {
    const request = original.call(this, value, key);
    if (this.name === "entries") {
      request.addEventListener(
        "success",
        () => {
          onEntriesPutSuccess();
        },
        { once: true },
      );
    }
    return request;
  };
  return () => {
    FakeIDBObjectStore.prototype.put = original;
  };
}

let harnesses: Harness[] = [];

const originalCreateImageBitmap = globalThis.createImageBitmap;

beforeEach(() => {
  // Deliberately NOT re-installing a fresh IndexedDB per test - see
  // `auth-lifecycle-bridge-r6f1-cross-account-handoff.test.tsx`'s identical
  // note. Distinct TEXT markers per test stand in for isolation instead.
  resetAuth("signed-in", "alice@example.com", "user-alice-r9f1");
  __getOpenEpicRegistryForTests().disposeAll();
  __getChatSessionRegistryForTests().disposeAll();
  // jsdom has no `createImageBitmap`. The oversized fixture the retry tests
  // used to seed no longer stands in for a real image - it is now a genuine
  // small PNG that reaches real preparation, which needs this to decode it.
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: vi.fn(() =>
      Promise.resolve({ width: 16, height: 16, close: () => undefined }),
    ),
  });
});

afterEach(() => {
  cleanup();
  for (const h of harnesses) h.handle.dispose();
  harnesses = [];
  __getOpenEpicRegistryForTests().disposeAll();
  __getChatSessionRegistryForTests().disposeAll();
  resetAuth("signed-out", null, null);
  resetDraftBlobTransportForTests();
  useWorktreeIntentStagingStore.getState().resetForTests();
  imageBytesByHash.clear();
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    writable: true,
    value: originalCreateImageBitmap,
  });
});

describe("R9F1: a queued transaction, not just the caller, is fenced against a stale identity", () => {
  it("an identity change landing while a separate transaction holds the stores does not write the outgoing account's prompt through the PRIMARY save (DRIVE RED)", async () => {
    const epicId = "epic-r9f1-primary";
    const chatId = "chat-r9f1-primary";
    const TEXT = "alice's prompt behind a queued primary-save transaction";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndReject({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      content: plainContent(TEXT),
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    const release = await holdPromptStashTransactionOpen();

    // An ORDINARY disposal - the identity teardown flag is false throughout.
    // `handOffUnrecordedPromptToStash` runs and its `save()` opens a
    // transaction that queues behind the one held above.
    harness.handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The account changes while that transaction is still queued, unable to
    // so much as run its `stillCurrent()` re-check yet.
    act(() => {
      resetAuth("signed-out", null, null);
    });

    release();

    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );

    expect(await stashContainsText(TEXT)).toBe(false);
  });

  it("positive control: the same queued primary-save transaction DOES save once released, when nobody's identity changes", async () => {
    const epicId = "epic-r9f1-primary-control";
    const chatId = "chat-r9f1-primary-control";
    const TEXT = "alice's prompt through an uneventful queued transaction";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndReject({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      content: plainContent(TEXT),
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    const release = await holdPromptStashTransactionOpen();
    harness.handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    await vi.waitFor(
      async () => {
        expect(await stashContainsText(TEXT)).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 2_000 },
    );
  });

  it("an identity change landing right when the TEXT-ONLY RETRY's own entries.put succeeds does not write the outgoing account's prompt (DRIVE RED)", async () => {
    const epicId = "epic-r9f1-retry";
    const chatId = "chat-r9f1-retry";
    const TEXT =
      "alice's capacity-refused prompt behind a queued retry transaction";
    // The repository's OWN budget check, not the 5 MiB image-preparation
    // ceiling: a filler sibling entry occupies the whole budget, so even a
    // small, VALID image genuinely overflows it on the PRIMARY save and
    // falls back to a real text-only retry - a size fact by construction.
    // The oversubscribed PRIMARY attempt throws before its own first store
    // write (the budget check runs before any `put`), so the ONE
    // `entries.put` this whole handoff makes belongs to the RETRY.
    await seedCapacityFillerEntry(PROMPT_STASH_BUDGET_BYTES);
    const small = pngBytesOfSize(4096);
    const hash = await sha256Hex(small);
    imageBytesByHash.set(hash, small);

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndReject({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      content: hashOnlyContent(hash, TEXT, small.byteLength),
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    const unhook = hookEntriesPutSuccess(() => {
      // The retry's `stillCurrent()` has ALREADY passed (it runs immediately
      // before this same put) and its entry is already queued to commit.
      // Only `bumpRevision`'s `meta` requests remain - the exact window an
      // outer, pre-transaction re-check can never observe.
      act(() => {
        resetAuth("signed-out", null, null);
      });
    });

    harness.handle.dispose();

    // Let the meta requests either land (unfixed) or be cut off mid-air by
    // an aborted transaction (fixed).
    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 1_000),
    );
    unhook();

    expect(await stashContainsText(TEXT)).toBe(false);
  });

  it("positive control: the same capacity-refused prompt DOES save its text-only retry, when nobody's identity changes at that same point", async () => {
    const epicId = "epic-r9f1-retry-control";
    const chatId = "chat-r9f1-retry-control";
    const TEXT = "alice's capacity-refused prompt with nobody signing out";
    await seedCapacityFillerEntry(PROMPT_STASH_BUDGET_BYTES);
    const small = pngBytesOfSize(4096);
    const hash = await sha256Hex(small);
    imageBytesByHash.set(hash, small);

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndReject({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      content: hashOnlyContent(hash, TEXT, small.byteLength),
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    let observedEntriesPutSuccess = false;
    const unhook = hookEntriesPutSuccess(() => {
      observedEntriesPutSuccess = true;
    });

    harness.handle.dispose();

    await vi.waitFor(
      async () => {
        expect(await stashContainsText(TEXT)).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 2_000 },
    );
    unhook();
    expect(observedEntriesPutSuccess).toBe(true);
    // Proves the SAVE that landed was the text-only retry a real capacity
    // refusal produced, not the primary succeeding outright: the qualifying
    // sentence `buildTextOnlyPromptHandoff` appends only for `cause:
    // "capacity"` names this exact reason.
    expect(await stashContainsText("it did not fit in the prompt stash")).toBe(
      true,
    );
  });
});
