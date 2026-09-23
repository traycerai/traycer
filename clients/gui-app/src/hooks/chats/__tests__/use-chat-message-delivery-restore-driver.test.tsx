import {
  act,
  cleanup,
  renderHook,
  type RenderHookResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatMessageDelivery } from "@traycer/protocol/host/agent/gui/message-delivery";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import { useChatMessageDeliveryRestoreDriver } from "@/hooks/chats/use-chat-message-delivery-restore-driver";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { appendBlocks } from "@/components/chat/quote/append-quote-to-draft";

/**
 * `useChatMessageDeliveryRestoreDriver` puts a withdrawn opening back in its
 * composer - the one restorer for that message. Covers checklist item 7 (the
 * driver) and the coordinator's reload addendum (#4): a fresh store for the
 * same chat must not merge the draft a second time, but must still resend the
 * acknowledgement.
 *
 * jsdom does NOT clear localStorage between tests in one file - the
 * acknowledgement marker is persisted, so every test resets it.
 */
const EPIC_ID = "epic-restore-driver";
const CHAT_ID = "chat-restore-driver";
const OWNER_ID = "owner-restore-driver";
const HOST_ID = "host-restore-driver";

const RESTORED: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "restored prompt" }] },
  ],
};

function typedDraft(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function whitespaceOnlyDraft(): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "   " }] }],
  };
}

function imageOnlyDraft(): JsonContent {
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
              b64content: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        ],
      },
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

function withdrawnDelivery(
  messageId: string,
  revision: number,
  options: { readonly restore: JsonContent },
): ChatMessageDelivery {
  return {
    messageId,
    revision,
    state: {
      phase: "withdrawn",
      code: "MESSAGE_START_INTERRUPTED",
      reason: "The opening message was not sent. Retry when ready.",
      missingHashes: [],
      restore: { content: options.restore },
      restoreClaimed: false,
    },
  };
}

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  options: {
    readonly messageDelivery?: ChatMessageDelivery | null;
    readonly canAct?: boolean;
  },
): void {
  callbacks.onConnectionStatus("open", null, null);
  const chat: Chat = {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: HOST_ID,
    title: "Chat",
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
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat,
      access: {
        role: "owner",
        ownerUserId: OWNER_ID,
        canAct: options.canAct ?? true,
      },
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
      messageDelivery: options.messageDelivery ?? null,
    },
  });
}

function mountDriver(
  handle: ChatSessionStoreHandle,
  nodeId: string,
  profileUserId: string | null,
): RenderHookResult<void, { readonly profileUserId: string | null }> {
  return renderHook(
    (props: { readonly profileUserId: string | null }) =>
      useChatMessageDeliveryRestoreDriver({
        handle,
        nodeId,
        profileUserId: props.profileUserId,
      }),
    { initialProps: { profileUserId } },
  );
}

function firstSentFrame(
  harness: Harness,
): Extract<
  ChatSubscribeClientFrame,
  { readonly kind: "messageDeliveryRestored" }
> {
  if (harness.sent.length === 0) {
    throw new Error("expected a frame to have gone out");
  }
  const frame = harness.sent[0];
  if (frame.kind !== "messageDeliveryRestored") {
    throw new Error(
      "expected a messageDeliveryRestored frame to have gone out",
    );
  }
  return frame;
}

let handles: ChatSessionStoreHandle[] = [];

beforeEach(() => {
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  window.localStorage.clear();
  handles = [];
});

afterEach(() => {
  cleanup();
  for (const handle of handles) handle.dispose();
  handles = [];
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  window.localStorage.clear();
});

describe("useChatMessageDeliveryRestoreDriver: merges with the composer draft", () => {
  it("merges the restored prompt FIRST, the existing draft after", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    useComposerDraftStore
      .getState()
      .replaceDraft(CHAT_ID, typedDraft("my typed draft"), null);
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    const merged = readComposerDraftSnapshot(CHAT_ID).content;
    expect(merged).toEqual(
      appendBlocks(RESTORED, typedDraft("my typed draft").content ?? []),
    );
    // Order, asserted directly rather than only through the equality above:
    // the restored paragraph leads, the draft's own paragraph follows.
    expect(merged.content?.at(0)).toEqual(RESTORED.content?.at(0));
    expect(merged.content?.at(1)).toEqual(
      typedDraft("my typed draft").content?.at(0),
    );
  });

  it("keeps an attachment-only draft after the restored prompt - an image cannot be retyped", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    const draft = imageOnlyDraft();
    useComposerDraftStore.getState().replaceDraft(CHAT_ID, draft, null);
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(
      appendBlocks(RESTORED, draft.content ?? []),
    );
  });

  it("replaces a draft nobody typed into (the composer default) with the restored prompt alone", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
  });

  it("replaces a whitespace-only draft with the restored prompt alone", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    useComposerDraftStore
      .getState()
      .replaceDraft(CHAT_ID, whitespaceOnlyDraft(), null);
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
  });
});

describe("useChatMessageDeliveryRestoreDriver: gated on connected and able to act", () => {
  it("does nothing while disconnected, then restores once the connection opens", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });
    act(() => {
      harness.handle.store.setState({ connectionStatus: "connecting" });
    });
    const before = readComposerDraftSnapshot(CHAT_ID).content;

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(before);
    expect(harness.sent).toHaveLength(0);

    act(() => {
      harness.handle.store.setState({ connectionStatus: "open" });
    });

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
    expect(harness.sent).toHaveLength(1);
  });

  it("does nothing while the session cannot act, then restores once it can", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      canAct: false,
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });
    const before = readComposerDraftSnapshot(CHAT_ID).content;

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(before);
    expect(harness.sent).toHaveLength(0);

    act(() => {
      harness.handle.store.setState((state) => ({
        access:
          state.access === null ? null : { ...state.access, canAct: true },
      }));
    });

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
    expect(harness.sent).toHaveLength(1);
  });

  it("does nothing while there is no signed-in profile, then restores once one is available", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });
    const before = readComposerDraftSnapshot(CHAT_ID).content;

    const { rerender } = mountDriver(harness.handle, CHAT_ID, null);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(before);
    expect(harness.sent).toHaveLength(0);

    act(() => {
      rerender({ profileUserId: OWNER_ID });
    });

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
    expect(harness.sent).toHaveLength(1);
  });
});

describe("useChatMessageDeliveryRestoreDriver: one restoration per message, however many tiles watch it", () => {
  it("a second tile mounted after the first already restored takes nothing and sends nothing", () => {
    const harness = createHarness();
    handles.push(harness.handle);
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, {
      messageDelivery: withdrawnDelivery("message-1", 1, { restore: RESTORED }),
    });

    mountDriver(harness.handle, CHAT_ID, OWNER_ID);
    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
    expect(harness.sent).toHaveLength(1);

    // A second tile on the same chat - e.g. a split pane - mounts its own
    // driver instance against the SAME handle.
    mountDriver(harness.handle, CHAT_ID, OWNER_ID);

    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
    expect(harness.sent).toHaveLength(1);
  });
});

describe("useChatMessageDeliveryRestoreDriver: reload (coordinator addendum #4)", () => {
  it("does not merge the draft a second time after a reload, but DOES resend the acknowledgement", () => {
    const first = createHarness();
    handles.push(first.handle);
    emitSnapshot(first.callbacks(), {
      messageDelivery: withdrawnDelivery("message-1", 4, { restore: RESTORED }),
    });
    mountDriver(first.handle, CHAT_ID, OWNER_ID);
    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(RESTORED);
    expect(first.sent).toHaveLength(1);
    const firstFrame = firstSentFrame(first);

    // The tile unmounts and its store disposes - a reload.
    cleanup();
    first.handle.dispose();

    // The user kept typing after the restore; that continuation must survive
    // the reload untouched.
    useComposerDraftStore
      .getState()
      .replaceDraft(
        CHAT_ID,
        appendBlocks(RESTORED, typedDraft("still typing").content ?? []),
        null,
      );
    const beforeReload = readComposerDraftSnapshot(CHAT_ID).content;

    const second = createHarness();
    handles.push(second.handle);
    // The reload's first snapshot re-states the SAME still-unclaimed
    // withdrawal - the host has not seen the acknowledgement yet either.
    emitSnapshot(second.callbacks(), {
      messageDelivery: withdrawnDelivery("message-1", 4, { restore: RESTORED }),
    });
    mountDriver(second.handle, CHAT_ID, OWNER_ID);

    // Not merged a second time: the composer holds exactly what it held
    // right before the reload.
    expect(readComposerDraftSnapshot(CHAT_ID).content).toEqual(beforeReload);
    // The acknowledgement IS resent, under a fresh clientActionId, because the
    // host's own record still shows the withdrawal unclaimed.
    expect(second.sent).toHaveLength(1);
    const secondFrame = firstSentFrame(second);
    expect(secondFrame.messageId).toBe("message-1");
    expect(secondFrame.expectedRevision).toBe(4);
    expect(secondFrame.clientActionId).not.toBe(firstFrame.clientActionId);
  });
});
