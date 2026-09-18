import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import {
  recordNegotiatedStreamMethodVersions,
  resetNegotiatedStreamVersions,
} from "@traycer-clients/shared/host-transport/negotiated-stream-version-registry";

import { useInitialChatHandoffDriver } from "@/hooks/chats/use-initial-chat-handoff-driver";
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
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

// The hash-first resend cases below need a bound host client to reach - the
// legacy fully-inlined case above never touches this seam at all, so it is
// mocked here rather than at the top of the file.
const byHashClient = {
  getActiveHostId: () => HOST_ID,
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  requestWithOptions: vi.fn(
    // Underscored, not dropped: the branch only reads `method`, but the shape
    // this mock is handed is half of what the assertions below are about.
    (method: string, _params: { readonly sha256: string }) =>
      method === "drafts.putBlob"
        ? Promise.resolve({ ok: true })
        : Promise.resolve({}),
  ),
};
vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    hostClient: {
      createRequesterForHostId: (hostId: string) =>
        hostId === HOST_ID ? byHashClient : null,
    },
  }),
}));

const imageStoreMocks = vi.hoisted(() => ({
  sessionImageBytes: vi.fn<(hash: string) => Uint8Array | null>(() => null),
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));
vi.mock("@/lib/composer/composer-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/composer/composer-image-store")
    >();
  return {
    ...actual,
    sessionImageBytes: imageStoreMocks.sessionImageBytes,
    getImageBytes: imageStoreMocks.getImageBytes,
  };
});

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

function noopChatStreamClientFactory() {
  return {
    sendAction: () => undefined,
    sameTurnSteeringProtocolSupported: () => true,
    requestTranscriptRange: () => undefined,
    requestResnapshot: () => undefined,
    close: () => undefined,
  };
}

function buildHandle(): ChatSessionStoreHandle {
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
    streamClientFactory: noopChatStreamClientFactory,
  });
}

function markSnapshotLoadedAndActable(handle: ChatSessionStoreHandle): void {
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

// A real-looking sha256 hex digest - `putDraftBlobs` keys the upload's
// idempotency on the hash itself.
const BY_HASH_SHA256 =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

function byHashImageDoc(): JsonContent {
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
              hash: BY_HASH_SHA256,
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

let handles: ChatSessionStoreHandle[] = [];

beforeEach(() => {
  useInitialChatHandoffStore.getState().resetForTests();
  handles = [];
  imageStoreMocks.sessionImageBytes.mockReset();
  imageStoreMocks.sessionImageBytes.mockReturnValue(null);
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  byHashClient.requestWithOptions.mockClear();
  resetDraftBlobTransportForTests();
});

afterEach(() => {
  cleanup();
  for (const handle of handles) handle.dispose();
  handles = [];
  useInitialChatHandoffStore.getState().resetForTests();
  resetNegotiatedStreamVersions();
  resetDraftBlobTransportForTests();
});

describe("initial-chat-handoff driver: legacy v3 (fully-inlined) resend", () => {
  it("sends via the FAST PATH - no hash to resolve, content goes out verbatim", () => {
    const content = b64ImageContent();
    registerWaitingChatHandoff(content);

    const handle = buildHandle();
    handles.push(handle);
    markSnapshotLoadedAndActable(handle);

    renderHook(() =>
      useInitialChatHandoffDriver({
        handle,
        nodeId: CHAT_ID,
        scope: SCOPE,
        profileUserId: USER_ID,
      }),
    );

    // The driver's effect fires synchronously on mount (waitingChat +
    // snapshotLoaded + canAct), and the fast path
    // (`inlineImageHashesFromSession`) needs no await - there is no
    // hash-only node in a fully-inlined legacy document, so nothing is
    // resolved asynchronously and the send goes out in the same tick.
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

// Item 41: the resend's OWN gate, `chat.subscribe`'s negotiated minor - a
// DIFFERENT method and line than the create's `epic.createChat` gate, so a
// host that shipped hashes at create time is not assumed to still be able to
// at resend, and vice versa.
describe("initial-chat-handoff driver: hash-first resend", () => {
  it("ships the resend hash-only on a chat.subscribe@1.11 host", async () => {
    recordNegotiatedStreamMethodVersions(
      HOST_ID,
      new Map([["chat.subscribe", { major: 1, minor: 11 }]]),
    );
    imageStoreMocks.getImageBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const content = byHashImageDoc();
    registerWaitingChatHandoff(content);

    const handle = buildHandle();
    handles.push(handle);
    markSnapshotLoadedAndActable(handle);

    renderHook(() =>
      useInitialChatHandoffDriver({
        handle,
        nodeId: CHAT_ID,
        scope: SCOPE,
        profileUserId: USER_ID,
      }),
    );

    await waitFor(() => {
      const sent = handle.store
        .getState()
        .pendingUserMessages.find((message) => message.messageId === "msg-1");
      expect(sent).toBeDefined();
    });
    // Positive control: the upload actually happened - a document that
    // silently took the inline arm would pass the assertions below for the
    // wrong reason.
    expect(byHashClient.requestWithOptions).toHaveBeenCalledWith(
      "drafts.putBlob",
      expect.objectContaining({ sha256: BY_HASH_SHA256 }),
      expect.anything(),
    );
    const sentMessage = handle.store
      .getState()
      .pendingUserMessages.find((message) => message.messageId === "msg-1");
    if (sentMessage === undefined) throw new Error("expected a sent message");
    const attrs = findImageAttrs(sentMessage.content);
    expect(attrs?.hash).toBe(BY_HASH_SHA256);
    expect(attrs?.b64content ?? null).toBeNull();
  });

  it("inlines the resend below chat.subscribe@1.11", async () => {
    recordNegotiatedStreamMethodVersions(
      HOST_ID,
      new Map([["chat.subscribe", { major: 1, minor: 10 }]]),
    );
    imageStoreMocks.getImageBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const content = byHashImageDoc();
    registerWaitingChatHandoff(content);

    const handle = buildHandle();
    handles.push(handle);
    markSnapshotLoadedAndActable(handle);

    renderHook(() =>
      useInitialChatHandoffDriver({
        handle,
        nodeId: CHAT_ID,
        scope: SCOPE,
        profileUserId: USER_ID,
      }),
    );

    await waitFor(() => {
      const sent = handle.store
        .getState()
        .pendingUserMessages.find((message) => message.messageId === "msg-1");
      expect(sent).toBeDefined();
    });
    expect(byHashClient.requestWithOptions).not.toHaveBeenCalledWith(
      "drafts.putBlob",
      expect.anything(),
      expect.anything(),
    );
    const sentMessage = handle.store
      .getState()
      .pendingUserMessages.find((message) => message.messageId === "msg-1");
    if (sentMessage === undefined) throw new Error("expected a sent message");
    const attrs = findImageAttrs(sentMessage.content);
    expect(attrs?.b64content).not.toBeNull();
  });
});
