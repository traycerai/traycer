/**
 * `use-chat-queue-actions.ts`'s custody-seeding half: `editQueuedItem` puts a
 * re-opened queued prompt's image hashes into the host-held set (against the
 * REAL `host-held-image-hashes` module - not mocked, per the ticket) so
 * submit's byte resolver never re-inlines megabytes the host already holds.
 * `restoreQueuedEditDraft` (reachable via `cancelQueueEditMode`) is the other
 * half: it must clear that claim when the queue-edit is abandoned.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

import {
  useChatQueueActions,
  type ChatQueueActionsInput,
} from "@/components/epic-canvas/renderers/use-chat-queue-actions";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  __resetHostHeldImageHashesForTests,
  hostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import { __resetComposerContentImageRootsForTests } from "@/lib/composer/composer-content-image-roots";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
// Side-effect only: registers the composer-draft-row root source the real
// app always has loaded by the time a chat tile runs. Without it this
// file's isolated module graph has no reader for the RESTORED row, and the
// F3 "custody transfers to the row" assertion would fail for a reason that
// has nothing to do with `use-chat-queue-actions.ts`.
import "@/lib/drafts/draft-mirror-coordinator";

const NODE_ID = "chat-queue-1";
const IMAGE_HASH = "a".repeat(64);
const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function docWithImageHash(hash: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id: "img-1",
          fileName: "screenshot.png",
          mimeType: "image/png",
          size: 128,
          hash,
        },
      },
    ],
  };
}

function queuedPromptItem(
  delivery: "same_turn" | "next_turn",
  content: JsonContent,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: "queue-1",
    messageId: "message-1",
    message: { kind: "user", content, browserAnnotations: [] },
    sender: { type: "user", userId: "user-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    delivery,
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fakeChatActions(overrides: Partial<ChatActions>): ChatActions {
  return {
    sendMessage: () => null,
    deleteMessageSuffix: () => null,
    editUserMessage: () => null,
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
    queueCancel: () => "action-1",
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
    ...overrides,
  };
}

function createHandle() {
  return createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: "epic-1",
    chatId: NODE_ID,
    userId: "user-1",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      draftBlobBridgeSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
}

function baseInput(
  overrides: Partial<ChatQueueActionsInput>,
): ChatQueueActionsInput {
  return {
    chatActions: fakeChatActions({}),
    handle: createHandle(),
    nodeId: NODE_ID,
    tileInstanceId: `${NODE_ID}-instance`,
    replaceDraftContent: () => undefined,
    clearDraftContent: () => undefined,
    currentComposerSettings: SETTINGS,
    currentEpicId: "epic-1",
    editingQueueItemId: null,
    activeEditingQueueItemId: null,
    dispatchUi: () => undefined,
    setEpicRunSettings: () => undefined,
    persistChatRunSettings: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  __resetHostHeldImageHashesForTests();
  __resetComposerContentImageRootsForTests();
});

afterEach(() => {
  useComposerDraftStore.setState({ drafts: {} });
  __resetComposerContentImageRootsForTests();
});

describe("editQueuedItem seeds host-held custody", () => {
  it("same_turn branch: the queued prompt's image hash becomes host-held", () => {
    const item = queuedPromptItem("same_turn", docWithImageHash(IMAGE_HASH));
    const { result } = renderHook(() => useChatQueueActions(baseInput({})));

    result.current.editQueuedItem(item);

    expect(hostHeldImageHashes(NODE_ID, null).has(IMAGE_HASH)).toBe(true);
  });

  it("ordinary (next_turn) branch: the queued prompt's image hash becomes host-held", () => {
    const item = queuedPromptItem("next_turn", docWithImageHash(IMAGE_HASH));
    const { result } = renderHook(() => useChatQueueActions(baseInput({})));

    result.current.editQueuedItem(item);

    expect(hostHeldImageHashes(NODE_ID, null).has(IMAGE_HASH)).toBe(true);
  });

  it("a non-sha256 hash attr is not recorded as host-held", () => {
    const item = queuedPromptItem(
      "next_turn",
      docWithImageHash("not-a-real-sha256-hash"),
    );
    const { result } = renderHook(() => useChatQueueActions(baseInput({})));

    result.current.editQueuedItem(item);

    expect(hostHeldImageHashes(NODE_ID, null).size).toBe(0);
  });

  it("cancelQueueEditMode (restoreQueuedEditDraft) clears the host-held claim", () => {
    const item = queuedPromptItem("next_turn", docWithImageHash(IMAGE_HASH));
    const { result } = renderHook(() => useChatQueueActions(baseInput({})));

    result.current.editQueuedItem(item);
    expect(hostHeldImageHashes(NODE_ID, null).has(IMAGE_HASH)).toBe(true);

    result.current.cancelQueueEditMode();

    expect(hostHeldImageHashes(NODE_ID, null).size).toBe(0);
  });
});

/**
 * F3 (batch-1 review, P2): the composer draft saved underneath a queue edit
 * has no image root of its own. `editQueuedItem` replaces the persisted row
 * with the queued prompt's content, so `draft-mirror-coordinator.ts`'s root
 * source (which reads the CURRENT row only) stops seeing the saved
 * document's hash the instant that happens - a reconcile in that window
 * reaps the bytes, and cancel hands back a hash-only draft nothing can
 * resolve. The fix holds the saved snapshot as its own GC root from capture
 * until it is restored (custody transfers to the row) or discarded, and
 * releases on unmount.
 */
describe("the saved draft snapshot underneath a queue edit is a GC root", () => {
  const SAVED_HASH = "c".repeat(64);

  function savedDraftContent(): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-saved",
            fileName: "screenshot.png",
            mimeType: "image/png",
            size: 128,
            hash: SAVED_HASH,
          },
        },
      ],
    };
  }

  /** Wires `replaceDraftContent` to the REAL composer draft store, the way
   * the chat tile does, so custody-transfer-on-restore is actually exercised
   * rather than swallowed by a no-op stub. */
  function realReplaceDraftContent(
    nodeId: string,
    content: JsonContent,
    selection: { readonly from: number; readonly to: number } | null,
  ): void {
    useComposerDraftStore.getState().replaceDraft(nodeId, content, selection);
  }

  it("stays a live root WHILE the queue edit is open, even though the row now holds different content", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(NODE_ID, savedDraftContent(), null);

    const item = queuedPromptItem(
      "next_turn",
      // The queued prompt's own content carries NO image hash, so if the
      // saved snapshot were rooted only via the current row (the
      // mirror-coordinator source), this hash would already be unrooted the
      // moment `editQueuedItem` overwrites the row.
      { type: "doc", content: [{ type: "paragraph" }] },
    );
    const { result } = renderHook(() =>
      useChatQueueActions(
        baseInput({ replaceDraftContent: realReplaceDraftContent }),
      ),
    );

    result.current.editQueuedItem(item);

    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(true);
  });

  it("stays rooted after cancelQueueEditMode restores the row (custody transfers, never a gap)", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(NODE_ID, savedDraftContent(), null);
    const item = queuedPromptItem("next_turn", {
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const { result } = renderHook(() =>
      useChatQueueActions(
        baseInput({ replaceDraftContent: realReplaceDraftContent }),
      ),
    );

    result.current.editQueuedItem(item);
    result.current.cancelQueueEditMode();

    // Now rooted via the RESTORED row itself (the mirror-coordinator source),
    // not the hold - but never unrooted in between.
    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(true);
    expect(useComposerDraftStore.getState().drafts[NODE_ID]?.content).toEqual(
      savedDraftContent(),
    );
  });

  it("releases the hold on unmount, so a tile closed mid-queue-edit does not pin the bytes forever", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(NODE_ID, savedDraftContent(), null);
    const item = queuedPromptItem("next_turn", {
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const { result, unmount } = renderHook(() =>
      useChatQueueActions(
        baseInput({ replaceDraftContent: realReplaceDraftContent }),
      ),
    );

    result.current.editQueuedItem(item);
    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(true);

    // Closed with the edit still open and never restored - nothing else
    // names the saved hash once the hold is gone (the row now holds the
    // queued content, which carries no hash of its own).
    unmount();

    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(false);
  });
});

/**
 * R1 (re-review): a SUCCESSFUL queue-edit save left the saved draft's root
 * installed forever. The discard effect (triggered when `editingQueueItemId`
 * goes back to `null`) used to clear `queuedEditRestoreDraftRef` directly,
 * without releasing `queue-edit-saved-draft:<nodeId>` - so the ref-clear and
 * the release could disagree, and a clean save (never restored, never
 * unmounted) left the discarded draft's hashes rooted for the tile's life.
 * The fix, `dropQueuedEditSnapshot`, is the ONLY place the ref is dropped and
 * always releases with it.
 */
describe("R1: a successful save (or a switch into same_turn) releases the saved-draft root", () => {
  const SAVED_HASH = "d".repeat(64);

  function savedDraftContent(): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-saved",
            fileName: "screenshot.png",
            mimeType: "image/png",
            size: 128,
            hash: SAVED_HASH,
          },
        },
      ],
    };
  }

  function realReplaceDraftContent(
    nodeId: string,
    content: JsonContent,
    selection: { readonly from: number; readonly to: number } | null,
  ): void {
    useComposerDraftStore.getState().replaceDraft(nodeId, content, selection);
  }

  function mountQueueActionsWithProps(
    initialProps: Pick<
      ChatQueueActionsInput,
      "editingQueueItemId" | "activeEditingQueueItemId"
    >,
  ) {
    const handle = createHandle();
    return renderHook(
      (
        props: Pick<
          ChatQueueActionsInput,
          "editingQueueItemId" | "activeEditingQueueItemId"
        >,
      ) =>
        useChatQueueActions(
          baseInput({
            handle,
            replaceDraftContent: realReplaceDraftContent,
            ...props,
          }),
        ),
      { initialProps },
    );
  }

  it("a successful save (editingQueueItemId -> null) releases the root, not just the ref", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(NODE_ID, savedDraftContent(), null);
    // Already mid-edit at mount, so the mount-time effect does not discard
    // anything yet.
    const { result, rerender } = mountQueueActionsWithProps({
      editingQueueItemId: "queue-1",
      activeEditingQueueItemId: null,
    });

    result.current.editQueuedItem(
      queuedPromptItem("next_turn", {
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
    );
    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(true);

    // The successful-send transition: the tile clears editing mode and the
    // send has already gone out - this draft is not coming back.
    rerender({ editingQueueItemId: null, activeEditingQueueItemId: null });

    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(false);
  });

  it("switching a normal queue edit into the same_turn branch releases the root once editing mode clears", () => {
    useComposerDraftStore
      .getState()
      .replaceDraft(NODE_ID, savedDraftContent(), null);
    const { result, rerender } = mountQueueActionsWithProps({
      editingQueueItemId: "queue-1",
      activeEditingQueueItemId: null,
    });

    result.current.editQueuedItem(
      queuedPromptItem("next_turn", {
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
    );
    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(true);

    // The same_turn branch never touches the saved-draft ref itself; it only
    // requests `editingQueueItemId: null` via `dispatchUi`, which the discard
    // effect is what actually has to act on.
    result.current.editQueuedItem(
      queuedPromptItem("same_turn", {
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
    );
    rerender({ editingQueueItemId: null, activeEditingQueueItemId: null });

    expect(landingLiveImageRootHashes().has(SAVED_HASH)).toBe(false);
  });
});
