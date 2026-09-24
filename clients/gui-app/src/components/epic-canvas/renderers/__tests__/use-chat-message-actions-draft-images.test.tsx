/**
 * The inline-edit submit contract's byte-custody half: `performEditSubmit` in
 * `use-chat-message-actions.ts`. This is one of only two surfaces that carry a
 * hash-only node TODAY (the other is queue-edit) - the edit composer is seeded
 * from the SENT message's own `structuredContent`, whose images are already
 * epic attachments. Proving those travel bare, unconditionally, is the
 * regression guard for "no user-visible behaviour change" this ticket promises.
 *
 * ## The default here is BRIDGE DOWN
 *
 * `baseInput` answers `false` for `getDraftBlobBridgeSupported`, so every case
 * that does not say otherwise runs the pre-bridge behaviour byte for byte: an
 * image added during the edit is re-inlined, and nothing is uploaded. That is
 * deliberate rather than incidental - these cases are about the RECONCILE
 * contract (live re-read, session identity, the send freeze), and an arm that
 * silently sent some of them by hash would change what they are measuring
 * without changing what they assert.
 *
 * The two cases that DO drive the bridge are the pair at the end, which exist
 * to show the same document taking two different wires. The fuller by-hash
 * behaviour - a mixed message, an inherited hash, the upload-before-read order -
 * lives in `use-chat-message-actions-edit-by-hash.test.tsx`.
 */
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HostClient,
  HostRequester,
} from "@traycer-clients/shared/host-client/host-client";

import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import {
  useChatMessageActions,
  type ChatMessageActionsResult,
  type ChatMessageActionsInput,
} from "@/components/epic-canvas/renderers/use-chat-message-actions";
import type { InlineEditState } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import type { HostRpcRegistry } from "@/lib/host";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { resetDraftBlobTransportForTests } from "@/lib/drafts/draft-blob-transport";
import { useAuthStore } from "@/stores/auth/auth-store";

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

/**
 * The bytes `putDraftBlobs` reads before it uploads. Mocked at the SAME seam
 * the landing and chat composers write through - `localBytesForHash` calls
 * `getImageBytes` - so the transport itself stays the production one.
 */
const imageStoreMocks = vi.hoisted(() => ({
  getImageBytes: vi.fn<(hash: string) => Promise<Uint8Array | undefined>>(() =>
    Promise.resolve(undefined),
  ),
}));
vi.mock("@/lib/composer/landing-image-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/composer/landing-image-store")>();
  return { ...actual, getImageBytes: imageStoreMocks.getImageBytes };
});

const clientMocks = vi.hoisted(() => ({
  putBlobCalls: [] as string[],
  ackedHashes: new Set<string>(),
}));

/**
 * A `DraftBlobClient`-shaped stub for the tab's `HostClient`. `putDraftBlobs`
 * reaches exactly `requestWithOptions("drafts.putBlob", …)`; the cast is to the
 * concrete requester member types rather than through `unknown`, so a newly
 * called member is a compile error here and not a runtime one.
 */
const TAB_CLIENT = {
  request: (() =>
    Promise.reject(
      new Error("unexpected request call"),
    )) as HostRequester<HostRpcRegistry>["request"],
  requestWithOptions: ((method: string, params: unknown) => {
    if (method !== "drafts.putBlob") {
      return Promise.reject(new Error(`unexpected method ${method}`));
    }
    const sha256 = (params as { readonly sha256: string }).sha256;
    clientMocks.putBlobCalls.push(sha256);
    return Promise.resolve(
      clientMocks.ackedHashes.has(sha256)
        ? { ok: true as const }
        : { ok: false as const, reason: "digest-mismatch" as const },
    );
  }) as HostRequester<HostRpcRegistry>["requestWithOptions"],
} as HostClient<HostRpcRegistry>;

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => TAB_CLIENT,
}));

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
    messageDeliveryRestored: () => null,
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
    messageDelivery: null,
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
    // Bridge DOWN by default - see the file docblock. Every case below that
    // does not override this runs the pre-bridge behaviour unchanged.
    getDraftBlobBridgeSupported: () => false,
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
  imageStoreMocks.getImageBytes.mockReset();
  imageStoreMocks.getImageBytes.mockResolvedValue(undefined);
  clientMocks.putBlobCalls.length = 0;
  clientMocks.ackedHashes.clear();
  // A null owner records and confirms nothing, so without this the bridge-UP
  // case below would upload, be forgotten, re-inline, and read exactly like
  // the bridge-DOWN case it is paired against.
  useAuthStore.setState({
    profile: { userId: "user-1", userName: "U", email: "u@example.com" },
    contextMetadata: { userId: "user-1", username: "user-1" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ profile: null, contextMetadata: null });
  resetDraftBlobTransportForTests();
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

  it("re-inlines a hash-only node added during the edit (not present in initialContent) when the stream cannot bridge draft blobs", async () => {
    // EVERY condition the by-hash case below has, except the getter. Without
    // the local bytes and the host's ack seeded here this case would still pass
    // with the bridge gate DELETED - the upload would simply find nothing to
    // send - and it would be reading "no bytes" while claiming to read "no
    // bridge". Established by ablation, not by inspection.
    imageStoreMocks.getImageBytes.mockImplementation((hash) =>
      Promise.resolve(hash === ADDED_IMAGE_HASH ? IMAGE_BYTES : undefined),
    );
    clientMocks.ackedHashes.add(ADDED_IMAGE_HASH);
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
    // And nothing was offered to the host: with the bridge down there is no
    // session that could materialize a bare hash, so uploading would buy a
    // round trip and change nothing.
    expect(clientMocks.putBlobCalls).toEqual([]);
  });

  // The INVERSE of the case above, same document, same added image: with the
  // bridge up and the host acking the bytes, the node the user just added
  // travels as 64 characters instead of a base64 screenshot. The two cases
  // together are the whole user-visible claim of this arm - one document, two
  // wires, and the only difference is what the stream negotiated.
  it("sends a hash-only node added during the edit BY HASH when the stream bridges draft blobs", async () => {
    imageStoreMocks.getImageBytes.mockImplementation((hash) =>
      Promise.resolve(hash === ADDED_IMAGE_HASH ? IMAGE_BYTES : undefined),
    );
    clientMocks.ackedHashes.add(ADDED_IMAGE_HASH);
    // Resolvable, so a red is the arm failing to take the by-hash path and NOT
    // a byte source that could not answer. If the gate silently closed, this
    // mock is exactly what the fallback would use, and the node would arrive
    // inline rather than the send failing.
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
            getDraftBlobBridgeSupported: () => true,
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

    // The added image was uploaded, and the INHERITED one was not - it is
    // already an epic attachment, so putting it back on the host would be a
    // round trip per Save.
    expect(clientMocks.putBlobCalls).toEqual([ADDED_IMAGE_HASH]);
    // Nothing was read for bytes at all. This is the order claim: the reconcile
    // loop resolves its initial set unconditionally, so a required set computed
    // before the upload would have asked for these bytes anyway and committed
    // them over the top of a perfectly good hash.
    expect(resolveMocks.resolveDraftImageBytes).not.toHaveBeenCalled();
    const atoms = collectImageAtoms(editUserMessage.mock.calls[0][0].content);
    expect(atoms).toHaveLength(2);
    // BOTH nodes keep their hash, and neither carries bytes.
    expect([...atoms].map((atom) => atom.hash).sort()).toEqual(
      [SENT_IMAGE_HASH, ADDED_IMAGE_HASH].sort(),
    );
    for (const atom of atoms) expect(atom.b64content).toBeNull();
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

  /**
   * B2-2, rehomed. An inline edit whose images have to be read back is
   * CANCELLABLE across that read - Escape and the Cancel button both just clear
   * the inline-edit state - and a settled read that dispatched anyway rewrote
   * message history and reverted files on disk for an edit the user took back.
   * No later undo puts that right, so the guard has to land before the FIRST
   * write.
   *
   * `inlineEditIsPending` is no defence: it is set INSIDE the dispatch, so
   * during the read there is nothing for Cancel to refuse and nothing for the
   * dispatch to notice. The live record following `activeInlineEdit` down to
   * `null` is.
   *
   * The sibling cases - retarget, reopen, already-pending - are the three above;
   * this is the fourth way out of a session and the only one that leaves NO
   * record for `commit` to compare against.
   *
   * TWO lines enforce it and EITHER is sufficient, so neither ablates alone:
   * the layout effect drops the live record when `activeInlineEdit` goes null,
   * and `currentLiveInlineEdit` answers null on a null committed record.
   * Removing both together is what reds this case - and only this case, which
   * is what makes it the pin for cancel rather than a second reading of the
   * retarget one. Stated because a reviewer ablating one line would conclude
   * this test proves nothing.
   */
  it("abandons the send when the edit is CANCELLED during the read", async () => {
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
    // `Props` is spelled out rather than inferred. `renderHook` infers it from
    // `initialProps`, which is a live edit here, so inference lands on
    // `InlineEditState` and `rerender(null)` - the cancel this case IS - fails
    // to typecheck against `Props | undefined`. Annotating the callback
    // parameter alone does not move it; the generic argument does.
    const { result, rerender } = renderHook<
      ChatMessageActionsResult,
      InlineEditState | null
    >(
      (edit) =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: edit,
            chatActions: fakeChatActions(editUserMessage),
          }),
        ),
      {
        wrapper,
        initialProps: inlineEdit({
          currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
          initialContent: docWithText("typing"),
        }),
      },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    act(() => {
      rerender(null);
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editUserMessage).not.toHaveBeenCalled();
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

  it("starts no second preparation when a resubmit lands while the read is in flight", async () => {
    // The window BETWEEN the two cells above. "freezes the document the moment
    // a send goes out" covers a resubmit with no read in flight, and "abandons
    // the send when a resend is already pending" covers a read in flight whose
    // pending mark has COMMITTED. Here a read is in flight and no mark has
    // committed, so neither `sentRevision` nor the projection can answer yet -
    // the prep-flight latch is the only thing that can, and this is the only
    // cell that observes it.
    //
    // The witness is the READ count, not the send count: one send is already
    // guaranteed by the freeze even without the latch (the second commit finds
    // `sentRevision` set), so counting sends would pass either way and pin
    // nothing. What a missing latch actually costs is a duplicate preparation -
    // a second set of byte reads and a second upload of the same hashes.
    const releases: (() => void)[] = [];
    resolveMocks.resolveDraftImageBytes.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(IMAGE_BYTES));
        }),
    );
    const { result } = renderHook(
      () =>
        useChatMessageActions(
          baseInput({
            activeInlineEdit: inlineEdit({
              currentContent: docWithImageAndText(ADDED_IMAGE_HASH, "typing"),
              initialContent: docWithText("typing"),
            }),
          }),
        ),
      { wrapper },
    );

    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });
    act(() => {
      result.current.revertOnEdit.onDontRevert();
    });

    await act(async () => {
      for (const release of releases) release();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resolveMocks.resolveDraftImageBytes).toHaveBeenCalledTimes(1);
  });
});
