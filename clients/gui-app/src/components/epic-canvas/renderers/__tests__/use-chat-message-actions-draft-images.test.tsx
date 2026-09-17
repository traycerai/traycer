/**
 * The inline-edit submit contract's byte-custody half: `performEditSubmit` in
 * `use-chat-message-actions.ts`. This is one of only two surfaces that carry a
 * hash-only node TODAY (the other is queue-edit) - the edit composer is seeded
 * from the SENT message's own `structuredContent`, whose images are already
 * epic attachments. Proving those travel bare, unconditionally, is the
 * regression guard for "no user-visible behaviour change" this ticket promises.
 */
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import {
  useChatMessageActions,
  type ChatMessageActionsResult,
  type ChatMessageActionsInput,
} from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { InlineEditState } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import { collectImageAtoms } from "@/lib/composer/image-atoms";

const resolveMocks = vi.hoisted(() => ({
  resolveDraftImageBytes: vi.fn<
    (hash: string, target: unknown) => Promise<Uint8Array | null>
  >(() => Promise.resolve(null)),
}));

vi.mock("@/lib/drafts/resolve-draft-image-bytes", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/drafts/resolve-draft-image-bytes")
    >();
  return {
    ...actual,
    resolveDraftImageBytes: resolveMocks.resolveDraftImageBytes,
  };
});

const TARGET_MESSAGE_ID = "msg-1";
const DEFAULT_SESSION_ID = "edit-session-1";
const SENT_IMAGE_HASH = "a".repeat(64);
const ADDED_IMAGE_HASH = "b".repeat(64);
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function hashOnlyImageNode(hash: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id: `img-${hash.slice(0, 6)}`,
      fileName: "screenshot.png",
      mimeType: "image/png",
      size: 128,
      hash,
    },
  };
}

function docWithText(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function docWithImageAndText(hash: string, text: string): JsonContent {
  return {
    type: "doc",
    content: [
      hashOnlyImageNode(hash),
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function baseMessage(): ChatMessageModel {
  return {
    id: "row-1",
    role: "user",
    content: "hi",
    segments: [],
    structuredContent: docWithImageAndText(SENT_IMAGE_HASH, "hi"),
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: TARGET_MESSAGE_ID,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function inlineEdit(overrides: Partial<InlineEditState>): InlineEditState {
  return {
    sessionId: DEFAULT_SESSION_ID,
    targetMessageId: TARGET_MESSAGE_ID,
    originalMessage: baseMessage(),
    initialContent: docWithImageAndText(SENT_IMAGE_HASH, "hi"),
    currentContent: docWithImageAndText(SENT_IMAGE_HASH, "hi"),
    revision: 0,
    dirty: true,
    pendingClientActionId: null,
    pendingMessageId: null,
    ...overrides,
  };
}

function fakeChatActions(
  editUserMessage: ChatActions["editUserMessage"],
): ChatActions {
  return {
    sendMessage: () => null,
    deleteMessageSuffix: () => null,
    editUserMessage,
    revertFileChanges: () => null,
    stopTurn: () => null,
    stopBackgroundItem: () => null,
    stopAllBackgroundItems: () => null,
    stopBackgroundSession: () => null,
    pauseQueue: () => null,
    resumeQueue: () => null,
    queueEdit: () => null,
    queueSettingsUpdate: () => null,
    restampQueuedItemSettings: () => undefined,
    updateActivePermissionMode: () => null,
    updateActiveProfile: () => null,
    queueCancel: () => null,
    queueReorder: () => null,
    queueSteerNow: () => null,
    queueAbortSteer: () => null,
    approvalDecision: () => null,
    fileEditApprovalDecision: () => null,
    restoreCheckpoint: () => null,
    interviewAnswer: () => null,
    interviewSkip: () => null,
    interviewDeliveryRetry: () => null,
    ackFailedSendRestoration: () => undefined,
    ackAcceptedAction: () => undefined,
    takeSetupFailedRestoration: () => null,
  };
}

function baseInput(
  overrides: Partial<ChatMessageActionsInput>,
): ChatMessageActionsInput {
  return {
    dispatchUi: () => undefined,
    activeInlineEdit: null,
    canModifyMessages: true,
    canAct: true,
    interviewDeliveryRetryProtocolSupported: false,
    currentComposerSettings: SETTINGS,
    editSettings: SETTINGS,
    slashCatalog: null,
    mentionRoots: [],
    fallbackToGlobalMentionRoots: false,
    currentEpicId: "epic-1",
    node: { id: "chat-1", instanceId: "tile-1", name: "Chat" },
    chatTitle: null,
    chatParentId: null,
    messages: [],
    events: [],
    transcriptWindow: null,
    profile: { userId: "user-1", userName: "U", email: "u@example.com" },
    chatActions: fakeChatActions(() => null),
    pendingActions: {},
    acceptedActions: {},
    confirmingDeleteMessageId: null,
    setForkTarget: () => undefined,
    worktreeBinding: null,
    revertOnEditOpen: false,
    queuedCount: 0,
    ...overrides,
  };
}

/**
 * Type into the open inline editor the way the editor itself does - through the
 * `onSnapshot` the hook hands it.
 *
 * Deliberately NOT a rerender with a fresh `activeInlineEdit`: the interval this
 * whole mechanism exists for is the one where the dispatch has been QUEUED and
 * React has not committed it, so a test that hands the hook a new committed prop
 * is testing the state after the interval, not the interval. `dispatchUi` is a
 * no-op here, which models exactly that: the keystroke never reaches the
 * reducer, and the send still has to carry it.
 */
function typeIntoOpenEdit(
  actions: ChatMessageActionsResult,
  message: ChatMessageModel,
  content: JsonContent,
): void {
  const editing = actions.messageActionsFor(message);
  if (editing === null || editing.type !== "user") {
    throw new Error("no user message actions");
  }
  if (editing.editing === null) throw new Error("editor is not open");
  editing.editing.onSnapshot(content, { from: 0, to: 0 });
}

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <TabHostProvider hostId="host-1">{children}</TabHostProvider>;
}

beforeEach(() => {
  resolveMocks.resolveDraftImageBytes.mockReset();
  resolveMocks.resolveDraftImageBytes.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("performEditSubmit (via revertOnEdit.onDontRevert)", () => {
  it("sends a hash inherited from the sent message BARE, synchronously, with no byte resolution", () => {
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const edit = inlineEdit({});
    const { result } = renderHook(
      () =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    expect(editUserMessage).toHaveBeenCalledTimes(1);
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
    const atoms = collectImageAtoms(editUserMessage.mock.calls[0][0].content);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBe(SENT_IMAGE_HASH);
    expect(atoms[0]?.b64content).toBeNull();
  });

  it("re-inlines a hash-only node added during the edit (not present in initialContent)", async () => {
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) =>
      hash === ADDED_IMAGE_HASH
        ? Promise.resolve(IMAGE_BYTES)
        : Promise.resolve(null),
    );
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const edit = inlineEdit({
      currentContent: {
        type: "doc",
        content: [
          hashOnlyImageNode(SENT_IMAGE_HASH),
          hashOnlyImageNode(ADDED_IMAGE_HASH),
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
    });
    const { result } = renderHook(
      () =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    await waitFor(() => {
      expect(editUserMessage).toHaveBeenCalledTimes(1);
    });
    const atoms = collectImageAtoms(editUserMessage.mock.calls[0][0].content);
    expect(atoms).toHaveLength(2);
    // The inherited one travels BARE: hash intact, no bytes.
    const inherited = atoms.filter((atom) => atom.hash === SENT_IMAGE_HASH);
    expect(inherited).toHaveLength(1);
    expect(inherited[0]).toMatchObject({
      hash: SENT_IMAGE_HASH,
      b64content: null,
    });
    // The added one is re-inlined, and `inlineHashOnlyImageBytes` DROPS the
    // hash - an image node carries exactly one payload.
    const reinlined = atoms.filter((atom) => atom.hash === null);
    expect(reinlined).toHaveLength(1);
    expect(reinlined[0]?.hash).toBeNull();
    expect(typeof reinlined[0]?.b64content).toBe("string");
    // The seam itself, not just its output: the resolver was asked about the
    // added hash and never about the inherited one.
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledWith(
      ADDED_IMAGE_HASH,
      expect.anything(),
    );
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalledWith(
      SENT_IMAGE_HASH,
      expect.anything(),
    );
  });

  it("sends the LIVE currentContent re-read after resolution, not the document captured before the await", async () => {
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const initialEdit = inlineEdit({
      currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
      initialContent: docWithText("typing"),
    });
    const { result } = renderHook(
      (edit: InlineEditState) =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper, initialProps: initialEdit },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    // A further keystroke lands while the byte read is in flight, and it is
    // never committed - see `typeIntoOpenEdit`.
    const mutated = docWithImageAndText(ADDED_IMAGE_HASH, "typing more");
    act(() => {
      typeIntoOpenEdit(result.current, baseMessage(), mutated);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(editUserMessage).toHaveBeenCalledTimes(1);
    });

    const sentContent = editUserMessage.mock.calls[0][0].content;
    const text = JSON.stringify(sentContent);
    expect(text).toContain("typing more");
    const atoms = collectImageAtoms(sentContent);
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.hash).toBeNull();
    expect(typeof atoms[0]?.b64content).toBe("string");
  });

  // F4 (batch-1 review): the hash list is captured ONCE, before the await. If
  // a second hash-only image appears in the live document while the first is
  // still resolving, the final re-read includes it but the byte map does not
  // - so it is sent bare despite this client being able to resolve it. The
  // fix reconciles the live document's required hashes against the attempted
  // set before the send.
  it("F4: asks the resolver for an image added DURING resolution, and inlines it too", async () => {
    const secondAddedHash = "c".repeat(64);
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation((hash) => {
      if (hash === ADDED_IMAGE_HASH) {
        return new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        });
      }
      if (hash === secondAddedHash) return Promise.resolve(IMAGE_BYTES);
      return Promise.resolve(null);
    });
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const initialEdit = inlineEdit({
      currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
      initialContent: docWithText("typing"),
    });
    const { result } = renderHook(
      (edit: InlineEditState) =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper, initialProps: initialEdit },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    // A second hash-only node appears WHILE the first is still resolving, and
    // like the keystroke above it is never committed.
    act(() => {
      typeIntoOpenEdit(result.current, baseMessage(), {
        type: "doc",
        content: [
          hashOnlyImageNode(ADDED_IMAGE_HASH),
          hashOnlyImageNode(secondAddedHash),
          {
            type: "paragraph",
            content: [{ type: "text", text: "typing" }],
          },
        ],
      });
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(editUserMessage).toHaveBeenCalledTimes(1);
    });

    // The failure mode this guards against: the second hash sent bare
    // because it was never asked for at all.
    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledWith(
      secondAddedHash,
      expect.anything(),
    );
    const atoms = collectImageAtoms(editUserMessage.mock.calls[0][0].content);
    expect(atoms).toHaveLength(2);
    for (const atom of atoms) {
      expect(atom.hash).toBeNull();
      expect(typeof atom.b64content).toBe("string");
    }
  });

  it("abandons the send when the target message id changes mid-flight", async () => {
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const initialEdit = inlineEdit({
      currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
      initialContent: docWithText("typing"),
    });
    const { result, rerender } = renderHook(
      (edit: InlineEditState) =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper, initialProps: initialEdit },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    act(() => {
      rerender(inlineEdit({ targetMessageId: "msg-2" }));
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editUserMessage).not.toHaveBeenCalled();
  });

  // F2 (batch-1 review): cancel-and-reopen of the SAME message is a NEW
  // editing session even though `targetMessageId` is unchanged. Before the
  // fix, only `targetMessageId` was checked, so the stale job's read would
  // land and submit the newly reopened edit's content under the OLD job's
  // revert choices - a send the user never asked for.
  it("abandons the send when the edit is cancelled and REOPENED on the same message (new session, same target)", async () => {
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const initialEdit = inlineEdit({
      currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
      initialContent: docWithText("typing"),
    });
    const { result, rerender } = renderHook(
      (edit: InlineEditState) =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper, initialProps: initialEdit },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    // Same `targetMessageId`, a DIFFERENT session - the reopened edit.
    act(() => {
      rerender(inlineEdit({ sessionId: "reopened-session" }));
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editUserMessage).not.toHaveBeenCalled();
  });

  it("freezes the document the moment a send goes out, before its mark commits (DRIVE RED)", () => {
    // `dispatchUi` is a no-op here, which is exactly the window: the send and
    // its `markInlineEditPending` are dispatched together, so until that mark
    // commits the projection still says nothing is pending. A keystroke landing
    // in that gap was accepted into the live document and DROPPED by the
    // reducer - leaving a document only the next send could see.
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const edit = inlineEdit({
      currentContent: docWithText("typed"),
      initialContent: docWithText("typed"),
    });
    const { result } = renderHook(
      () =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });
    expect(editUserMessage).toHaveBeenCalledTimes(1);

    act(() => {
      typeIntoOpenEdit(result.current, baseMessage(), docWithText("late"));
    });
    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    // Still one send, and nothing carrying the keystroke the reducer refused.
    expect(editUserMessage).toHaveBeenCalledTimes(1);
  });

  it("abandons the send when a resend is already pending for this edit", async () => {
    let release: (() => void) | null = null;
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(IMAGE_BYTES);
        }),
    );
    const editUserMessage = vi.fn<ChatActions["editUserMessage"]>(() => ({
      clientActionId: "ca-1",
      messageId: "m-1",
    }));
    const initialEdit = inlineEdit({
      currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
      initialContent: docWithText("typing"),
    });
    const { result, rerender } = renderHook(
      (edit: InlineEditState) =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      { wrapper, initialProps: initialEdit },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    act(() => {
      rerender(inlineEdit({ pendingClientActionId: "already-sending" }));
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editUserMessage).not.toHaveBeenCalled();
  });
});
