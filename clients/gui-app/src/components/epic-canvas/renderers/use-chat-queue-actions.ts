import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatQueuedItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  isChatRunInProgress,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  decideSteerSettings,
  type SteerSettingsDecision,
} from "@/lib/chats/decide-steer-settings";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import {
  EMPTY_COMPOSER_DRAFT,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import {
  clearHostHeldImageHashes,
  setHostHeldImageHashes,
} from "@/lib/composer/host-held-image-hashes";
import {
  holdComposerContentImageRoots,
  releaseComposerContentImageRoots,
} from "@/lib/composer/composer-content-image-roots";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import type { ChatTileUiAction } from "./chat-tile-session-state";

interface QueuedEditDraftSnapshot {
  readonly hadDraft: boolean;
  readonly content: JsonContent;
  readonly selection: { readonly from: number; readonly to: number } | null;
}

export interface ChatQueueActionsInput {
  readonly chatActions: ChatActions;
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
  /**
   * The mounted TAB, not the chat. Used only as the image-root holder identity:
   * two tiles can show one chat, each with its own saved-draft snapshot in its
   * own ref, and a holder keyed by the chat id would have them share one entry
   * in a process-wide map - so one tile's cleanup releases the other's roots
   * while its restore still needs those bytes. Everything else here is keyed by
   * `nodeId`, correctly: the draft row and the host-held hashes are the CHAT's.
   */
  readonly tileInstanceId: string;
  readonly replaceDraftContent: (
    nodeId: string,
    content: JsonContent,
    selection: { readonly from: number; readonly to: number } | null,
  ) => void;
  readonly clearDraftContent: (nodeId: string) => void;
  readonly currentComposerSettings: ChatRunSettings;
  /**
   * The same tuple after the tile's permission clamp - what may go ON THE WIRE.
   *
   * Separate from `currentComposerSettings` because the two are asked different
   * questions here and only one of them is a frame. Steer sends a
   * `newSettings` tuple that `carriesAutoPermissionMode` inspects, so it takes
   * the clamped value; `handleComposerSettingsChange` compares an incoming edit
   * against what the user is PRESENTED, so it keeps the raw one - comparing
   * against a clamped value would read "no change" for an edit to the very mode
   * the clamp had substituted.
   *
   * Safe to substitute here because `decideSteerSettings` compares harness,
   * model, reasoning effort, service tier and profile - never `permissionMode`
   * - so the clamp cannot move its verdict, and `newSettings` is the tuple it
   * was handed, which is how `confirmSteerRestart` inherits the clamp too.
   */
  readonly nextStepSettings: ChatRunSettings;
  readonly currentEpicId: string;
  readonly editingQueueItemId: string | null;
  readonly activeEditingQueueItemId: string | null;
  readonly dispatchUi: (action: ChatTileUiAction) => void;
  readonly setEpicRunSettings: (
    epicId: string,
    settings: ChatRunSettings,
    timestamp: number,
  ) => void;
  /**
   * Fire-and-forget durable sync of the chat's run settings to the host
   * (`epic.updateChatRunSettings`), so a profile/model switch that is never
   * followed by a send still governs headless turns (e.g. incoming
   * agent-to-agent messages). Failures (old host: E_HOST_UNSUPPORTED) fall
   * back to the legacy persist-on-next-send behavior.
   */
  readonly persistChatRunSettings: (settings: ChatRunSettings) => void;
}

export interface ChatQueueActionsResult {
  readonly editQueuedItem: (item: ChatQueuedPromptItem) => void;
  readonly cancelQueuedItem: (item: ChatQueuedItem) => void;
  readonly abortSteerQueuedItem: (item: ChatQueuedPromptItem) => void;
  readonly cancelQueueEditMode: () => void;
  readonly reorderQueuedItem: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly steerQueuedItemNow: (item: ChatQueuedPromptItem) => void;
  readonly handleComposerSettingsChange: (settings: ChatRunSettings) => void;
  readonly steerRestart: {
    readonly open: boolean;
    readonly changed: ReadonlyArray<string>;
    readonly onOpenChange: (open: boolean) => void;
    readonly onRestart: () => void;
  };
}

/**
 * Encapsulates the queue steer/edit/cancel/reorder action callbacks and the
 * pending-steer-restart confirmation state. The `handleComposerSettingsChange`
 * callback lives here because it drives `restampQueuedItemSettings` and the
 * live permission-mode update (both queue-scoped side effects).
 *
 * Callbacks stay memoized around stable queue/action inputs so memoized
 * children are not disturbed during streaming updates.
 */
export function useChatQueueActions(
  input: ChatQueueActionsInput,
): ChatQueueActionsResult {
  const {
    chatActions,
    handle,
    nodeId,
    tileInstanceId,
    replaceDraftContent,
    clearDraftContent,
    currentComposerSettings,
    nextStepSettings,
    currentEpicId,
    editingQueueItemId,
    activeEditingQueueItemId,
    dispatchUi,
    setEpicRunSettings,
    persistChatRunSettings,
  } = input;

  // Set when steering a queued prompt requires ending the running turn (a
  // turn-start-baked setting differs); drives the confirm dialog.
  const [pendingSteerRestart, setPendingSteerRestart] = useState<{
    readonly item: ChatQueuedItem;
    readonly decision: Extract<
      SteerSettingsDecision,
      { readonly kind: "interrupt_restart" }
    >;
  } | null>(null);
  const queuedEditRestoreDraftRef = useRef<QueuedEditDraftSnapshot | null>(
    null,
  );
  /**
   * The composer draft saved underneath a queue edit is held ONLY by the ref
   * above: `editQueuedItem` replaces the persisted row with the queued content,
   * so from that moment no root source names the saved document's images. A
   * reconcile in that window reaps their bytes, and the cancel that restores the
   * document hands back a hash-only draft that can no longer be resolved.
   */
  const savedDraftHolderId = `queue-edit-saved-draft:${tileInstanceId}`;
  // Released on unmount too - a tile closed mid-queue-edit would otherwise pin
  // those bytes for the life of the renderer.
  useEffect(
    () => () => {
      releaseComposerContentImageRoots(savedDraftHolderId);
    },
    [savedDraftHolderId],
  );

  /**
   * The ONLY place the saved-draft ref is dropped, and it always releases the
   * root with it.
   *
   * Written as one function on purpose. The two were separate, and the discard
   * effect below cleared the ref without releasing - so a SUCCESSFUL queue-edit
   * save left the discarded draft's image hashes rooted for the life of the
   * mounted tile. Any future path that drops this snapshot has to come through
   * here, which is what stops the next one from forgetting.
   */
  const dropQueuedEditSnapshot =
    useCallback((): QueuedEditDraftSnapshot | null => {
      const snapshot = queuedEditRestoreDraftRef.current;
      queuedEditRestoreDraftRef.current = null;
      releaseComposerContentImageRoots(savedDraftHolderId);
      return snapshot;
    }, [savedDraftHolderId]);

  const restoreQueuedEditDraft = useCallback((): void => {
    // Peek at the snapshot WITHOUT dropping it. Both branches below do their
    // store write first and only then call `dropQueuedEditSnapshot`, which is
    // what releases the root - so the hold outlives the write and custody is
    // handed over rather than dropped on the floor. Dropping here instead
    // would release before either branch had written anything.
    const snapshot = queuedEditRestoreDraftRef.current;
    if (snapshot === null) return;
    // The inherited document is being put back, so its host-custody claim goes
    // with it. Cleared unconditionally rather than per branch: whichever way
    // the restore goes, the queued prompt's images are no longer in this
    // composer.
    clearHostHeldImageHashes(nodeId);
    if (!snapshot.hadDraft) {
      // Nothing to transfer custody TO - the draft is being discarded - so the
      // clear and the release are simply ordered, not paired.
      clearDraftContent(nodeId);
      dropQueuedEditSnapshot();
      return;
    }
    // Custody TRANSFERS to the restored row, and the ORDER is the mechanism:
    // the write lands first, so the composer-draft root source already names
    // these hashes by the time the hold is released. There is never a moment
    // when no root names them. Releasing first would open exactly the window a
    // debounced reconcile runs in.
    replaceDraftContent(nodeId, snapshot.content, snapshot.selection);
    dropQueuedEditSnapshot();
  }, [clearDraftContent, dropQueuedEditSnapshot, nodeId, replaceDraftContent]);

  /**
   * A queued prompt's content comes from the HOST, so every image in it is
   * already an epic attachment and travels to the wire as a bare hash - as it
   * has since message editing existed. Recording that here is what stops
   * submit's byte resolver from re-inlining megabytes of base64 for an image
   * the host can resolve itself. See `lib/composer/host-held-image-hashes.ts`.
   *
   * No incarnation to name from here (this hook does not hold the editor
   * handle), so the claim matches whichever editor the composer is running -
   * which is correct, because the content it describes was just written into
   * that composer's draft row.
   */
  const inheritQueuedItemImageCustody = useCallback(
    (content: JsonContent): void => {
      setHostHeldImageHashes(nodeId, null, blobHashesFromContent(content));
    },
    [nodeId],
  );

  const editQueuedItem = useCallback(
    (item: ChatQueuedPromptItem): void => {
      if (item.delivery === "same_turn") {
        const actionId = chatActions.queueCancel(item.queueItemId);
        if (actionId === null) return;
        inheritQueuedItemImageCustody(item.message.content);
        replaceDraftContent(nodeId, item.message.content, null);
        dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
        return;
      }
      if (queuedEditRestoreDraftRef.current === null) {
        const draft = useComposerDraftStore.getState().drafts[nodeId];
        const snapshot = {
          hadDraft: draft !== undefined,
          content: draft?.content ?? EMPTY_COMPOSER_DRAFT.content,
          selection: draft?.selection ?? null,
        };
        queuedEditRestoreDraftRef.current = snapshot;
        // Held from capture until restored or discarded. The row this content
        // came from is about to be overwritten by the queued prompt.
        holdComposerContentImageRoots(savedDraftHolderId, snapshot.content);
      }
      inheritQueuedItemImageCustody(item.message.content);
      replaceDraftContent(nodeId, item.message.content, null);
      dispatchUi({
        type: "setEditingQueueItemId",
        editingQueueItemId: item.queueItemId,
      });
    },
    [
      chatActions,
      dispatchUi,
      inheritQueuedItemImageCustody,
      nodeId,
      replaceDraftContent,
      savedDraftHolderId,
    ],
  );

  useEffect(() => {
    if (editingQueueItemId === null) {
      // The SUCCESSFUL-SAVE path (and the switch into the `same_turn` branch).
      // The saved draft is deliberately discarded here - the queued item took
      // its place and the composer has already been cleared - but the discard
      // still has to release the root, or those hashes stay live for the life
      // of this tile with nothing able to restore them.
      dropQueuedEditSnapshot();
      return;
    }
    if (activeEditingQueueItemId !== null) return;
    restoreQueuedEditDraft();
    dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
  }, [
    activeEditingQueueItemId,
    dispatchUi,
    dropQueuedEditSnapshot,
    editingQueueItemId,
    restoreQueuedEditDraft,
  ]);

  const cancelQueuedItem = useCallback(
    (item: ChatQueuedItem): void => {
      const actionId = chatActions.queueCancel(item.queueItemId);
      if (actionId === null) return;
      if (editingQueueItemId === item.queueItemId) {
        restoreQueuedEditDraft();
        dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
      }
    },
    [chatActions, dispatchUi, editingQueueItemId, restoreQueuedEditDraft],
  );

  const abortSteerQueuedItem = useCallback(
    (item: ChatQueuedItem): void => {
      // Un-stage a still-pending steer: the host reverts it to a plain queued
      // item. Rejected host-side if the steer already began folding into the
      // turn - the row's affordance is only shown while it is safe to undo.
      chatActions.queueAbortSteer(item.queueItemId);
    },
    [chatActions],
  );

  const cancelQueueEditMode = useCallback((): void => {
    restoreQueuedEditDraft();
    dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
  }, [dispatchUi, restoreQueuedEditDraft]);

  const reorderQueuedItem = useCallback(
    (item: ChatQueuedItem, beforeQueueItemId: string | null): void => {
      chatActions.queueReorder(item.queueItemId, beforeQueueItemId);
    },
    [chatActions],
  );

  const steerQueuedItemNow = useCallback(
    (item: ChatQueuedItem): void => {
      // Read the live turn at call time instead of closing over `state.activeTurn`
      // (the store assigns a fresh object every snapshot, so depending on it would
      // re-create this callback every streamed token → lowerQueue → composerModel
      // churn -> composer re-render).
      const decision = decideSteerSettings(
        handle.store.getState().activeTurn,
        nextStepSettings,
      );
      if (decision.kind === "silent_inject") {
        // No turn-start-baked setting changed: fold into the running turn at the
        // next safe point. Pass the settings explicitly so the host's mode
        // decision can't race a lagging restamp of this item.
        //
        // They match WHAT THE COMPOSER WOULD SEND, not necessarily the running
        // turn - and the difference is real rather than pedantic. The clamp is
        // computed from this tab's evidence, so a tab with no recorded harness
        // line demotes a mode a turn may genuinely be running at. That is the
        // direction this whole gate is built to fail in: a steer the host
        // refuses outright kills the button for the session, while a demoted
        // one still lands and costs the judge on a turn the user can re-run.
        chatActions.queueSteerNow(item.queueItemId, nextStepSettings);
        return;
      }
      // A change the running turn can't absorb: confirm ending the turn first.
      setPendingSteerRestart({ item, decision });
    },
    [chatActions, nextStepSettings, handle.store],
  );

  const confirmSteerRestart = useCallback((): void => {
    if (pendingSteerRestart === null) return;
    const { decision, item } = pendingSteerRestart;
    const actionId = chatActions.queueSteerNow(
      item.queueItemId,
      decision.newSettings,
    );
    if (actionId === null) return;
    setPendingSteerRestart(null);
  }, [chatActions, pendingSteerRestart]);

  const handleSteerRestartOpenChange = useCallback((open: boolean): void => {
    if (open) return;
    setPendingSteerRestart(null);
  }, []);

  const handleComposerSettingsChange = useCallback(
    (settings: ChatRunSettings): void => {
      const permissionModeChanged =
        settings.permissionMode !== currentComposerSettings.permissionMode;
      const profileChanged =
        settings.profileId !== currentComposerSettings.profileId &&
        settings.harnessId === currentComposerSettings.harnessId;
      setEpicRunSettings(currentEpicId, settings, Date.now());
      handle.store.getState().setCurrentComposerSettings(settings);
      // Durable sync: the host's per-chat settings must not lag the composer,
      // or a headless agent-to-agent turn runs on the previously sent profile.
      persistChatRunSettings(settings);
      // Live-mirror: pending queued prompts always resolve the latest toolbar
      // settings. Exclude the item open for editing (it commits on submit); the
      // store also skips no-op updates and when there are no pending items.
      chatActions.restampQueuedItemSettings(settings, activeEditingQueueItemId);
      // Both live-turn forwards below read store state at call time (see
      // steerQueuedItemNow): closing over per-snapshot objects would
      // re-create this callback every streamed token → lowerComposer →
      // composerModel churn → composer re-render. Both gate on `runStatus`
      // rather than `activeTurn`: the pre-spawn window they target begins at
      // accept, before an activeTurn is broadcast, and the host honors both
      // updates through that whole window (`turnActivating` onward).
      if (
        permissionModeChanged &&
        isChatRunInProgress(handle.store.getState().runStatus)
      ) {
        chatActions.updateActivePermissionMode(settings.permissionMode);
      }
      // Narrow in-flight profile switch (same shape as the permission-mode
      // update above): a same-harness profile change while a run is in
      // progress is forwarded so a turn still parked on worktree setup
      // adopts the switched profile before it spawns, instead of erroring
      // on the rate-limited profile the user just moved off. A
      // cross-harness change is NOT a profile switch (profile ids are
      // harness-scoped) - the full tuple on the next send covers it.
      if (
        profileChanged &&
        isChatRunInProgress(handle.store.getState().runStatus)
      ) {
        chatActions.updateActiveProfile(settings.harnessId, settings.profileId);
      }
    },
    [
      activeEditingQueueItemId,
      chatActions,
      currentComposerSettings.permissionMode,
      currentComposerSettings.profileId,
      currentComposerSettings.harnessId,
      currentEpicId,
      handle.store,
      persistChatRunSettings,
      setEpicRunSettings,
    ],
  );

  return {
    editQueuedItem,
    cancelQueuedItem,
    abortSteerQueuedItem,
    cancelQueueEditMode,
    reorderQueuedItem,
    steerQueuedItemNow,
    handleComposerSettingsChange,
    steerRestart: {
      open: pendingSteerRestart !== null,
      changed: pendingSteerRestart?.decision.changed ?? [],
      onOpenChange: handleSteerRestartOpenChange,
      onRestart: confirmSteerRestart,
    },
  };
}
