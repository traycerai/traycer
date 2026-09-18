import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";

import { useInitialChatHandoffDriver } from "@/hooks/chats/use-initial-chat-handoff-driver";
import type { HostRpcRegistry } from "@/lib/host";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  useInitialChatHandoffStore,
  type InitialChatHandoffScope,
} from "@/stores/epics/initial-chat-handoff-store";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { useAuthStore } from "@/stores/auth/auth-store";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const EPIC_ID = "epic-v3-resend";
const CHAT_ID = "chat-v3-resend";
const HOST_ID = "host-v3-resend";
const USER_ID = "user-1";

const SCOPE: InitialChatHandoffScope = {
  hostId: HOST_ID,
  userId: USER_ID,
  epicId: EPIC_ID,
};

/**
 * A host that acknowledges every `drafts.putBlob`. Both members are typed
 * against `DraftBlobClient` and neither is cast: the upload rides
 * `requestWithOptions` (it needs the idempotency key and the large-body
 * budget), and a fake carrying only `request` would type-check against nothing.
 */
const ACKING_BLOB_CLIENT: DraftBlobClient = {
  request: () => Promise.reject(new Error("unexpected request call")),
  requestWithOptions: ((method: string) =>
    method === "drafts.putBlob"
      ? Promise.resolve({ ok: true as const })
      : Promise.reject(
          new Error(`unexpected method ${method}`),
        )) as HostRequester<HostRpcRegistry>["requestWithOptions"],
};

function pngBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
}

function signedInAs(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId, username: userId },
  });
}

/**
 * `bridgeSupported` is threaded rather than defaulted - the lint gate forbids
 * default parameter values, and an explicit `false` at the legacy call site is
 * the more honest reading anyway: that case is about a document with no hash at
 * all, so the flag must not be what carries it.
 */
function noopChatStreamClientFactory(bridgeSupported: boolean) {
  return () => ({
    sendAction: () => undefined,
    sameTurnSteeringProtocolSupported: () => true,
    draftBlobBridgeSupported: () => bridgeSupported,
    requestTranscriptRange: () => undefined,
    requestResnapshot: () => undefined,
    close: () => undefined,
  });
}

function buildHandle(bridgeSupported: boolean): ChatSessionStoreHandle {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: noopChatStreamClientFactory(bridgeSupported),
  });
}

/**
 * `draftBlobBridgeSupported` is seeded on the STATE as well as answered by the
 * factory. The store recomputes the field from the live stream client when a
 * subscribe lands, and these cases never subscribe - so the factory alone would
 * leave the field at its `false` initial value and the "supported" pins would
 * pass for the wrong reason.
 */
function markSnapshotLoadedAndActable(
  handle: ChatSessionStoreHandle,
  bridgeSupported: boolean,
): void {
  const chat: Chat = {
    id: CHAT_ID,
    parentId: null,
    userId: USER_ID,
    hostId: HOST_ID,
    title: "Test Chat",
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
  handle.store.setState({
    connectionStatus: "open",
    snapshotLoaded: true,
    access: { role: "owner", ownerUserId: USER_ID, canAct: true },
    chat,
    draftBlobBridgeSupported: bridgeSupported,
  });
}

function b64ImageContent(): JsonContent {
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
              size: 12,
              byHashEligible: true,
              b64content: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
          { type: "text", text: "hello" },
        ],
      },
    ],
  };
}

function byHashImageDoc(hash: string): JsonContent {
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
              size: 12,
              byHashEligible: true,
              hash,
            },
          },
          { type: "text", text: "hello" },
        ],
      },
    ],
  };
}

function findImageAttrs(
  content: JsonContent,
): Readonly<Record<string, unknown>> | null {
  if (content.type === "imageAttachment" && content.attrs !== undefined) {
    return content.attrs;
  }
  for (const child of content.content ?? []) {
    const found = findImageAttrs(child);
    if (found !== null) return found;
  }
  return null;
}

function registerWaitingChatHandoff(content: JsonContent): void {
  const store = useInitialChatHandoffStore.getState();
  store.register({
    ...SCOPE,
    chatId: CHAT_ID,
    content,
    settings: SETTINGS,
    worktreeIntent: null,
    placement: null,
    messageId: "msg-1",
    clientActionId: "cai-1",
    createdAt: 1,
  });
  store.markChatCreated(SCOPE, CHAT_ID);
  store.markWaitingChat(SCOPE);
}

function mountDriver(handle: ChatSessionStoreHandle): void {
  // Constructed ONCE per mount, outside the render callback, and that placement
  // is load-bearing rather than tidiness. `useSeededSendContent` lists this
  // getter in an effect dependency array and that effect calls `setResolved` on
  // both arms, so an identity that changes per render is an unbounded
  // render -> effect -> setState -> render loop: it allocated past 4.5 GB and
  // killed the vitest worker, which EXITS 0, so this file reported nothing at
  // all for several passes rather than failing.
  //
  // The mounter's is `useCallback(() => …, [handle.store])`
  // (`chat-tile.tsx`'s `getDraftBlobBridgeSupported`), i.e. one identity for the
  // life of the mount. Matching it means matching BOTH halves: reading from the
  // store at resend time, and being stable across renders. The previous comment
  // here claimed to be "exactly the getter the mounter passes" while matching
  // only the first half, which is why the line read as correct.
  const getDraftBlobBridgeSupported = (): boolean =>
    handle.store.getState().draftBlobBridgeSupported;
  renderHook(() =>
    useInitialChatHandoffDriver({
      handle,
      nodeId: CHAT_ID,
      scope: SCOPE,
      profileUserId: USER_ID,
      // Read from the store at the moment of the resend, never a boolean
      // captured at mount.
      getDraftBlobBridgeSupported,
    }),
  );
}

/** The content the resend actually dispatched, once it has gone out. */
async function dispatchedResendContent(
  handle: ChatSessionStoreHandle,
): Promise<JsonContent> {
  const sent = await waitFor(() => {
    const message = handle.store
      .getState()
      .pendingUserMessages.find((candidate) => candidate.messageId === "msg-1");
    if (message === undefined) {
      throw new Error("the seeded user message has not sent yet");
    }
    return message;
  });
  return sent.content;
}

let handles: ChatSessionStoreHandle[] = [];

beforeEach(() => {
  installFreshIndexedDb();
  useInitialChatHandoffStore.getState().resetForTests();
  handles = [];
  resetDraftBlobTransportForTests();
  // `currentDraftBlobOwnerId()` reads `contextMetadata.userId` - NOT
  // `profile.userId`. Seeding the wrong one leaves the owner `null`, which
  // confirms nothing, which would make every by-hash assertion below pass
  // vacuously by inlining.
  signedInAs(USER_ID);
});

afterEach(() => {
  cleanup();
  for (const handle of handles) handle.dispose();
  handles = [];
  useInitialChatHandoffStore.getState().resetForTests();
  resetDraftBlobTransportForTests();
});

describe("initial-chat-handoff driver: legacy v3 (fully-inlined) resend", () => {
  it("sends via the FAST PATH - no hash to resolve, content goes out verbatim", () => {
    const content = b64ImageContent();
    registerWaitingChatHandoff(content);

    const handle = buildHandle(false);
    handles.push(handle);
    markSnapshotLoadedAndActable(handle, false);

    mountDriver(handle);

    // The driver's effect fires synchronously on mount (waitingChat +
    // snapshotLoaded + canAct) and the fast path needs no await: a fully-inlined
    // legacy document has no hash-only node, so `useSeededSendContent` returns
    // the recorded content in RENDER, without state and without an extra pass.
    // Asserted without `waitFor` on purpose - that is the property.
    const sentMessage = handle.store
      .getState()
      .pendingUserMessages.find((message) => message.messageId === "msg-1");
    expect(sentMessage).toBeDefined();
    if (sentMessage === undefined) {
      throw new Error("expected the seeded user message to have sent");
    }
    expect(sentMessage.content).toEqual(content);
    expect(handle.store.getState().pendingActions["cai-1"]).toBeDefined();

    // The handoff transitioned out of waitingChat into sending (about to be
    // consumed once the accepted action / message settles).
    const handoff = useInitialChatHandoffStore.getState().handoffs;
    const key = Object.keys(handoff)[0];
    expect(handoff[key]?.status).toBe("sending");
  });
});

/**
 * The resend's OWN gate. It is no longer a negotiated minor this hook reads for
 * itself: `chat.subscribe@1.12` moved the capability onto the live stream
 * (`ChatStreamClient.draftBlobBridgeSupported()`), which the chat tile hands in
 * as a getter, and the second condition is the host's confirmed custody of the
 * digest for THIS account.
 *
 * Every case below asserts the DISPATCHED CONTENT'S image node, because that is
 * the only thing that separates the two implementations. "A resend happened" is
 * true in all three, and an assertion that stopped there would keep passing if
 * the arm were deleted again - which is exactly how it came back missing from
 * the merge.
 */
describe("initial-chat-handoff driver: hash-first resend", () => {
  it("ships the resend HASH-ONLY when the bridge is supported and the digest is host-held", async () => {
    const hash = await putImage(pngBytes());
    const confirmed = await putDraftBlobs(
      HOST_ID,
      ACKING_BLOB_CLIENT,
      [hash],
      USER_ID,
    );
    // The precondition, asserted rather than assumed: if the upload silently
    // skipped this digest, the case below would inline and the failure would
    // read as a gate bug rather than a broken fixture.
    expect(confirmed).toEqual([hash]);
    registerWaitingChatHandoff(byHashImageDoc(hash));

    const handle = buildHandle(true);
    handles.push(handle);
    markSnapshotLoadedAndActable(handle, true);

    mountDriver(handle);

    const attrs = findImageAttrs(await dispatchedResendContent(handle));
    expect(attrs).not.toBeNull();
    expect(attrs?.hash).toBe(hash);
    // The whole point: the bytes did NOT cross the relay a second time.
    expect(attrs?.b64content).toBeUndefined();
  });

  it("INLINES the resend below the bridge - same document, same held digest, flag off", async () => {
    // The positive control for the case above, differing in ONE input. Without
    // it, "hash-only when supported" could be satisfied by a driver that never
    // inlines anything.
    const hash = await putImage(pngBytes());
    const confirmed = await putDraftBlobs(
      HOST_ID,
      ACKING_BLOB_CLIENT,
      [hash],
      USER_ID,
    );
    expect(confirmed).toEqual([hash]);
    registerWaitingChatHandoff(byHashImageDoc(hash));

    const handle = buildHandle(false);
    handles.push(handle);
    markSnapshotLoadedAndActable(handle, false);

    mountDriver(handle);

    const attrs = findImageAttrs(await dispatchedResendContent(handle));
    expect(attrs).not.toBeNull();
    expect(typeof attrs?.b64content).toBe("string");
    // `inlineHashOnlyImageBytes` DROPS the hash rather than carrying both - a
    // re-inlined node is indistinguishable on the wire from a fresh inline
    // paste, which is what makes an old host's ingest work unchanged.
    expect(attrs?.hash).toBeUndefined();
  });

  it("INLINES a digest the host does not hold, even with the bridge supported", async () => {
    // The flag is not sufficient on its own, and this is not a hypothetical
    // case: the handoff records the fully hash-only document, so it also names
    // images the CREATE inlined - digests the host was never given. Shipping one
    // of those bare because the stream could have carried it is a dangling hash.
    const hash = await putImage(pngBytes());
    registerWaitingChatHandoff(byHashImageDoc(hash));

    const handle = buildHandle(true);
    handles.push(handle);
    markSnapshotLoadedAndActable(handle, true);

    mountDriver(handle);

    const attrs = findImageAttrs(await dispatchedResendContent(handle));
    expect(attrs).not.toBeNull();
    expect(typeof attrs?.b64content).toBe("string");
    expect(attrs?.hash).toBeUndefined();
  });
});
