/**
 * R6F1 (P1, cross-account leak): the durable handoff must NOT write the
 * outgoing account's prompt into the prompt stash on sign-out / user-switch.
 *
 * `disposingForIdentityTeardown` wraps the WHOLE bridge teardown in a module
 * flag; `dispose()` in chat-session-store checks it and skips
 * `handOffUnrecordedPromptToStash` while it is set - matching the bridge's
 * existing policy of dismissing the retained-draft toast on the same
 * boundary. The prompt stash is ONE IndexedDB database with no per-account
 * partition, so without this a prompt written during a sign-out/user-switch
 * is a prompt the NEXT identity's composer finds.
 *
 * This drives the transition through the ACTUAL bridge (mounted, real
 * `useAuthStore` transition), not by calling the internal flag/function
 * directly - matching `src/providers/__tests__/auth-lifecycle-bridge.test.tsx`'s
 * existing pattern - and uses the REAL prompt-stash store/repository (fake
 * IndexedDB) rather than a mock, so both the in-memory rows and durable
 * storage are checked.
 */
import "./install-fresh-indexeddb-eagerly";

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

/**
 * R7F1 needs a capture that is STILL RUNNING when the account changes, and the
 * only slow step in a handoff is the image read. This is that seam, held open
 * by the test.
 */
const imageResolver = vi.hoisted(() => ({
  deferred: null as null | { resolve: () => void },
  hold: false,
}));
vi.mock("@/lib/drafts/resolve-draft-image-bytes", () => ({
  resolveDraftImageBytes: () => {
    if (!imageResolver.hold) return Promise.resolve(null);
    return new Promise<null>((resolve) => {
      imageResolver.deferred = {
        resolve: () => {
          resolve(null);
        },
      };
    });
  },
}));

vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  draftMirrorClientForHost: () => null,
}));

const CHAT_HOST_ID = "host-r6f1";

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

function sendAndRejectUnrecordedPrompt(args: {
  readonly harness: Harness;
  readonly epicId: string;
  readonly chatId: string;
  readonly ownerId: string;
  readonly text: string;
}): void {
  const { harness, epicId, chatId, ownerId, text } = args;
  const action = harness.handle.store.getState().sendMessage({
    content: plainContent(text),
    sender: { type: "user", userId: ownerId },
    settings: SETTINGS,
    attachments: buildAttachmentsFromJSONContent(plainContent(text)),
    deliveryPolicy: "auto",
    restore: { content: plainContent(text), browserAnnotations: [] },
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

function hashOnlyContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "image-r7f1",
          fileName: "shot.png",
          mimeType: "image/png",
          size: 64,
          hash: "hash-r7f1-held",
        },
      },
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function sendAndRejectHashOnlyPrompt(args: {
  readonly harness: Harness;
  readonly epicId: string;
  readonly chatId: string;
  readonly ownerId: string;
  readonly text: string;
}): void {
  const { harness, epicId, chatId, ownerId, text } = args;
  const content = hashOnlyContent(text);
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

let harnesses: Harness[] = [];

beforeEach(() => {
  // Deliberately NOT re-installing a fresh IndexedDB per test: the real
  // `usePromptStashStore` module already opened (and cached) its connection
  // against the database `install-fresh-indexeddb-eagerly` set up at import
  // time - see that module's doc comment. Swapping `globalThis.indexedDB`
  // again here would not move the already-open connection, so the tests
  // below share one database and rely on distinct TEXT markers instead.
  resetAuth("signed-in", "alice@example.com", "user-alice-r6f1");
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

describe("R6F1: the cross-account identity teardown drops the outgoing account's unrecorded prompt", () => {
  it("a sign-out never writes the outgoing account's prompt to the stash, even after the handoff's own timeout (DRIVE RED)", async () => {
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicId = "epic-r6f1-signout";
    const chatId = "chat-r6f1-signout";
    const TEXT = "alice's unsent prompt at sign-out";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectUnrecordedPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(plainContent(TEXT));

    chatRegistry.acquire(
      { epicId, chatId, hostId: CHAT_HOST_ID, scopeKey: "r6f1-signout" },
      () => harness.handle,
    );

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-out", null, null);
    });

    // Immediately after the transition: not present.
    expect(await stashContainsText(TEXT)).toBe(false);

    // AND it stays absent past the handoff's own resolution window - the
    // handoff is async/fire-and-forget, so a check right after the
    // transition alone would not catch a leak that lands seconds later.
    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );
    expect(await stashContainsText(TEXT)).toBe(false);
  });

  it("a user-switch never writes the outgoing account's prompt to the stash, even after the handoff's own timeout (DRIVE RED)", async () => {
    const chatRegistry = __getChatSessionRegistryForTests();
    const epicId = "epic-r6f1-switch";
    const chatId = "chat-r6f1-switch";
    const TEXT = "alice's unsent prompt at user-switch";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectUnrecordedPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });

    chatRegistry.acquire(
      { epicId, chatId, hostId: CHAT_HOST_ID, scopeKey: "r6f1-switch" },
      () => harness.handle,
    );

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    act(() => {
      resetAuth("signed-in", "bob@example.com", "user-bob-r6f1");
    });

    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );
    expect(await stashContainsText(TEXT)).toBe(false);
  });

  it("positive control: an ORDINARY disposal (not an identity transition) still stashes the prompt normally", async () => {
    const epicId = "epic-r6f1-control";
    const chatId = "chat-r6f1-control";
    const TEXT = "alice's unsent prompt, ordinary disposal";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectUnrecordedPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });

    // No bridge, no identity transition - a bare disposal, exactly like a
    // warm-cap eviction or an idle-expiry teardown.
    harness.handle.dispose();

    await vi.waitFor(
      async () => {
        expect(await stashContainsText(TEXT)).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS * 2 + 2_000 },
    );
  });
});

describe("R7F1: a capture already in flight when the account changes is fenced by generation", () => {
  afterEach(() => {
    imageResolver.hold = false;
    imageResolver.deferred = null;
  });

  it("an ORDINARY disposal whose image read is still pending when the user signs out does not write the outgoing account's prompt (DRIVE RED)", async () => {
    const epicId = "epic-r7f1-inflight";
    const chatId = "chat-r7f1-inflight";
    const TEXT = "alice's prompt captured before the switch";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectHashOnlyPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    // ORDINARY disposal - a closed tab, NOT an identity teardown. The
    // synchronous flag is false throughout, which is the whole point: this is
    // the case it cannot see.
    imageResolver.hold = true;
    harness.handle.dispose();
    await Promise.resolve();
    expect(imageResolver.deferred).not.toBeNull();

    // The account changes while that read is still outstanding.
    act(() => {
      resetAuth("signed-out", null, null);
    });

    // Only now does the read return, and the save would run under the NEW
    // identity with the OLD account's prompt in hand.
    imageResolver.deferred?.resolve();
    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );

    expect(await stashContainsText(TEXT)).toBe(false);
  });

  it("positive control: the same in-flight capture DOES save when no identity change happens", async () => {
    const epicId = "epic-r7f1-control";
    const chatId = "chat-r7f1-control";
    const TEXT = "alice's prompt with nobody signing out";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectHashOnlyPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });

    imageResolver.hold = true;
    harness.handle.dispose();
    await Promise.resolve();
    imageResolver.deferred?.resolve();

    await vi.waitFor(
      async () => {
        expect(await stashContainsText(TEXT)).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 2_000 },
    );
  });
});

/**
 * SUBSUMED, and kept deliberately. These cases were written when the check
 * right after `await get().hydrate()` was the guarantee; R9F1 then moved the
 * real fence INSIDE the repository transaction, which is reached on every
 * path, so reverting the hydrate line alone no longer turns any of this red.
 *
 * That does not make the scenario worthless - "an identity change lands during
 * hydration and nothing is written" is still a behaviour worth pinning, and it
 * is pinned here. What it is no longer is a drive-red for the hydrate check
 * specifically, so the name does not claim to be one. The hydrate check earns
 * its place as a cheap early exit, not as the guarantee, and its own comment
 * says so. The guarantee's drive-red lives in
 * `auth-lifecycle-bridge-r9f1-transaction-queued-across-identity-switch.test.tsx`.
 */
describe("R8F1: an identity change during hydration writes nothing (guarantee now enforced in-transaction by R9F1)", () => {
  afterEach(() => {
    imageResolver.hold = false;
    imageResolver.deferred = null;
  });

  it("an identity change landing DURING the stash's hydrate does not write the outgoing account's prompt", async () => {
    const epicId = "epic-r8f1-hydrate";
    const chatId = "chat-r8f1-hydrate";
    const TEXT = "alice's prompt caught inside hydrate";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectUnrecordedPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });

    render(
      <EpicSessionLifecycleBridge>
        <div />
      </EpicSessionLifecycleBridge>,
    );

    // Hold HYDRATION, not the image read. This is the gap a pre-call check
    // cannot see: the generation was current when `save` was invoked, and the
    // account changes while `save` is still awaiting `hydrate()`.
    let releaseHydrate: () => void = () => undefined;
    const realHydrate = usePromptStashStore.getState().hydrate;
    const held = new Promise<void>((resolve) => {
      releaseHydrate = () => {
        resolve();
      };
    });
    usePromptStashStore.setState({
      hydrate: async () => {
        await held;
        await realHydrate();
      },
    });

    // An ORDINARY disposal - the teardown flag is false throughout.
    harness.handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));

    act(() => {
      resetAuth("signed-out", null, null);
    });

    releaseHydrate();
    usePromptStashStore.setState({ hydrate: realHydrate });
    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );

    expect(await stashContainsText(TEXT)).toBe(false);
  });

  it("positive control: the same held hydration DOES save when no identity change happens", async () => {
    const epicId = "epic-r8f1-control";
    const chatId = "chat-r8f1-control";
    const TEXT = "alice's prompt through a slow but uneventful hydrate";

    const harness = createHarness(epicId, chatId, "alice@example.com");
    harnesses.push(harness);
    emitOwnerSnapshot(harness.callbacks(), epicId, chatId, "alice@example.com");
    sendAndRejectUnrecordedPrompt({
      harness,
      epicId,
      chatId,
      ownerId: "alice@example.com",
      text: TEXT,
    });

    let releaseHydrate: () => void = () => undefined;
    const realHydrate = usePromptStashStore.getState().hydrate;
    const held = new Promise<void>((resolve) => {
      releaseHydrate = () => {
        resolve();
      };
    });
    usePromptStashStore.setState({
      hydrate: async () => {
        await held;
        await realHydrate();
      },
    });

    harness.handle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseHydrate();
    usePromptStashStore.setState({ hydrate: realHydrate });

    await vi.waitFor(
      async () => {
        expect(await stashContainsText(TEXT)).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 2_000 },
    );
  });
});
