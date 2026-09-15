/**
 * R10F1 (P1): the in-transaction `stillCurrent()` predicate is sampled ONCE,
 * and a transaction is not atomic with the check that admitted it - the
 * writes AFTER that sample are each awaited, so an identity switch landing on
 * any of them still commits. Re-sampling only narrows the interval; it cannot
 * close it, because there is always a last sample and always something after
 * it.
 *
 * The fix reaches the transaction itself: `prompt-stash-repository.ts` keeps
 * every fenced transaction in `liveFencedTransactions` for its whole body,
 * and `abortLiveFencedPromptStashWrites()` (called by
 * `disposingForIdentityTeardown` right after it bumps the generation) aborts
 * whichever ones are still open, rolling them back in full.
 *
 * This drives that fix AT THE REVIEWER'S EXACT OBSERVATION POINT: the real
 * `entries.put` SUCCESS event, not the transaction's completion. At that
 * instant `stillCurrent()` has already passed (it runs just before this same
 * put), the entry's own bytes are already queued for commit, and
 * `bumpRevision`'s `meta` requests have not been made yet - a live window
 * an outer re-check before or after the whole call could never observe,
 * because it is INSIDE the awaited chain. The identity switch is landed
 * right there, through the real `EpicSessionLifecycleBridge`, and the meta
 * requests are then let run to see whether they land or are cut off mid-air.
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
import { loadPromptStashSnapshot } from "@/lib/composer/prompt-stash-repository";
import { HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS } from "@/lib/drafts/unrecorded-prompt-handoff";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useWorktreeIntentStagingStore } from "@/stores/worktree/worktree-intent-staging-store";

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", () => ({
  resolveDraftImageBytes: () => Promise.resolve(null),
}));

const CHAT_HOST_ID = "host-r10f1";

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
 * Fires `onEntriesPutSuccess` synchronously inside the REAL `entries.put`
 * request's own "success" event - registered via `addEventListener` before
 * `savePromptStashSnapshotWhile`'s own `requestToPromise` attaches its
 * `onsuccess` property handler, so this callback runs first and can act
 * (switch identity) before that `await` even resumes. Every other store's
 * `put` passes through untouched.
 */
type PutMethod = (
  this: IDBObjectStore,
  value: unknown,
  key: IDBValidKey | undefined,
) => IDBRequest<IDBValidKey>;

/** Aborts observed on a transaction that had already written to `entries`. */
let abortedEntriesTransactions = 0;

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
      // POSITIVE observation that the teardown tore this transaction DOWN,
      // rather than merely that a predicate was consulted somewhere. Absence
      // of the entry is consistent with several mechanisms; an `abort` event
      // on the very transaction whose `put` just succeeded is only consistent
      // with one.
      this.transaction.addEventListener("abort", () => {
        abortedEntriesTransactions += 1;
      });
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

beforeEach(() => {
  abortedEntriesTransactions = 0;
  // Deliberately NOT re-installing a fresh IndexedDB per test - see
  // `auth-lifecycle-bridge-r6f1-cross-account-handoff.test.tsx`'s identical
  // note. Distinct TEXT markers per test stand in for isolation instead.
  resetAuth("signed-in", "alice@example.com", "user-alice-r10f1");
  __getOpenEpicRegistryForTests().disposeAll();
  __getChatSessionRegistryForTests().disposeAll();
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
});

describe("R10F1: an identity switch landing between entries.put's success and the revision write aborts the whole live transaction", () => {
  it("an identity change landing right after entries.put succeeds - before bumpRevision's meta requests are even made - leaves no durable entry and nothing in memory (DRIVE RED)", async () => {
    const epicId = "epic-r10f1-primary";
    const chatId = "chat-r10f1-primary";
    const TEXT = "alice's prompt whose entries.put already succeeded";

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

    const unhook = hookEntriesPutSuccess(() => {
      // `stillCurrent()` has ALREADY passed (it runs immediately before this
      // same put) and this entry's own bytes are already queued to commit.
      // Only `bumpRevision`'s `meta.get`/`meta.put` remain. Switching here,
      // through the real bridge, is the interval an outer re-check before or
      // after the whole call can never see.
      act(() => {
        resetAuth("signed-out", null, null);
      });
    });

    harness.handle.dispose();

    // Let the meta requests either land (unfixed) or be cut off mid-air by
    // an aborted transaction (fixed).
    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );
    unhook();

    expect(await stashContainsText(TEXT)).toBe(false);
    // ...and it is absent because the transaction was ABORTED mid-flight.
    expect(abortedEntriesTransactions).toBeGreaterThan(0);
  });

  it("positive control: the same entries.put success timing DOES save, when nobody's identity changes there", async () => {
    const epicId = "epic-r10f1-primary-control";
    const chatId = "chat-r10f1-primary-control";
    const TEXT = "alice's prompt through an uneventful entries.put success";

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
  });
});
