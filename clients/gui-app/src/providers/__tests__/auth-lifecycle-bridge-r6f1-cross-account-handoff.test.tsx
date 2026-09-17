/**
 * R6F1 (P1, cross-account leak): the durable handoff must NOT install the
 * outgoing account's prompt as a start-page draft on sign-out / user-switch.
 *
 * `disposingForIdentityTeardown` wraps the WHOLE bridge teardown in a module
 * flag; `dispose()` in chat-session-store checks it and skips
 * `handOffUnrecordedPromptToStash` while it is set - matching the bridge's
 * existing policy of dismissing the retained-draft toast on the same
 * boundary. The landing draft store is keyed per WINDOW with no account of its
 * own, so without this a draft installed during a sign-out/user-switch is a
 * draft the NEXT identity finds in their Drafts list.
 *
 * R7F1 is the half the flag cannot cover: an ORDINARY disposal whose image
 * read is still in flight when the account changes. The flag is `false`
 * throughout that one, and `identityGeneration` - re-asked synchronously
 * immediately before the install - is what fences it.
 *
 * This drives the transition through the ACTUAL bridge (mounted, real
 * `useAuthStore` transition), not by calling the internal flag/function
 * directly - matching `src/providers/__tests__/auth-lifecycle-bridge.test.tsx`'s
 * existing pattern - and reads the REAL landing draft store rather than a
 * mock, which is where the handoff's durable row now lands.
 *
 * The retired prompt stash's own mechanisms - a queued transaction (R9F1), an
 * aborted live one (R10F1) and a hydrate-time switch (R8F1) - had their suites
 * deleted with it: the install is synchronous now, so none of those phases
 * exists to fence.
 */
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
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";
import {
  handedOffDrafts,
  resetHandedOffDrafts,
} from "@/stores/chats/__tests__/handoff-draft-observer";
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

/**
 * Waits until the handoff has actually reached the held read. The handoff runs
 * several awaits before it gets there (it materializes any inline images
 * first), so a single microtask tick is not enough - and a `deferred` that is
 * still `null` would make the tests below pass for the wrong reason, by
 * timing out into the text-only path instead of exercising the fence.
 */
async function waitForHeldRead(): Promise<{ resolve: () => void }> {
  await vi.waitFor(() => {
    expect(imageResolver.deferred).not.toBeNull();
  });
  const deferred = imageResolver.deferred;
  if (deferred === null) throw new Error("expected a held read");
  return deferred;
}

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
          // A real 64-char hex digest: anything else is filtered out as a
          // non-hash before the resolver is ever consulted, and the handoff
          // would take the text-only path without holding anything open.
          hash: "a".repeat(64),
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

/** Whether the handoff's durable destination holds a draft carrying `text`. */
function draftsContainText(text: string): boolean {
  return handedOffDrafts().some((draft) =>
    JSON.stringify(draft.content).includes(text),
  );
}

let harnesses: Harness[] = [];

beforeEach(() => {
  // A fresh factory per test is fine now: the destination is the landing draft
  // store, and nothing here opens a connection at module load. The retired
  // stash store did, which is why this file used to need an eager fixture.
  installFreshIndexedDb();
  resetHandedOffDrafts();
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
  resetHandedOffDrafts();
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("R6F1: the cross-account identity teardown drops the outgoing account's unrecorded prompt", () => {
  it("a sign-out never installs the outgoing account's prompt as a draft, even after the handoff's own timeout (DRIVE RED)", async () => {
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
    expect(draftsContainText(TEXT)).toBe(false);

    // AND it stays absent past the handoff's own resolution window - the
    // handoff is async/fire-and-forget, so a check right after the
    // transition alone would not catch a leak that lands seconds later.
    await new Promise((resolve) =>
      setTimeout(resolve, HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 500),
    );
    expect(draftsContainText(TEXT)).toBe(false);
  });

  it("a user-switch never installs the outgoing account's prompt as a draft, even after the handoff's own timeout (DRIVE RED)", async () => {
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
    expect(draftsContainText(TEXT)).toBe(false);
  });

  it("positive control: an ORDINARY disposal (not an identity transition) still installs the prompt normally", async () => {
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
      () => {
        expect(draftsContainText(TEXT)).toBe(true);
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

  it("an ORDINARY disposal whose image read is still pending when the user signs out does not install the outgoing account's prompt (DRIVE RED)", async () => {
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
    await waitForHeldRead();

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

    expect(draftsContainText(TEXT)).toBe(false);
  });

  it("positive control: the same in-flight capture DOES install when no identity change happens", async () => {
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
    const heldRead = await waitForHeldRead();
    heldRead.resolve();

    await vi.waitFor(
      () => {
        expect(draftsContainText(TEXT)).toBe(true);
      },
      { timeout: HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS + 2_000 },
    );
  });
});
