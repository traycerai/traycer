import { useCallback, useState } from "react";
import type {
  ChatQueuedItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  decideSteerSettings,
  type SteerSettingsDecision,
} from "@/lib/chats/decide-steer-settings";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import type { ChatTileUiAction } from "./chat-tile-session-state";

export interface ChatQueueActionsInput {
  readonly chatActions: ChatActions;
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
  readonly replaceDraftContent: (
    nodeId: string,
    content: JsonContent,
    context: null,
  ) => void;
  readonly currentComposerSettings: ChatRunSettings;
  readonly currentEpicId: string;
  readonly editingQueueItemId: string | null;
  readonly activeEditingQueueItemId: string | null;
  readonly dispatchUi: (action: ChatTileUiAction) => void;
  readonly setEpicRunSettings: (
    epicId: string,
    settings: ChatRunSettings,
    timestamp: number,
  ) => void;
}

export interface ChatQueueActionsResult {
  readonly editQueuedItem: (item: ChatQueuedItem) => void;
  readonly cancelQueuedItem: (item: ChatQueuedItem) => void;
  readonly abortSteerQueuedItem: (item: ChatQueuedItem) => void;
  readonly cancelQueueEditMode: () => void;
  readonly reorderQueuedItem: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly steerQueuedItemNow: (item: ChatQueuedItem) => void;
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
 * All callbacks preserve the same `useCallback` dependency structure as the
 * original view-model so memoized children are not disturbed.
 */
export function useChatQueueActions(
  input: ChatQueueActionsInput,
): ChatQueueActionsResult {
  const {
    chatActions,
    handle,
    nodeId,
    replaceDraftContent,
    currentComposerSettings,
    currentEpicId,
    editingQueueItemId,
    activeEditingQueueItemId,
    dispatchUi,
    setEpicRunSettings,
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

  const editQueuedItem = useCallback(
    (item: ChatQueuedItem): void => {
      if (item.delivery === "same_turn") {
        const actionId = chatActions.queueCancel(item.queueItemId);
        if (actionId === null) return;
        replaceDraftContent(nodeId, item.message.content, null);
        dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
        return;
      }
      replaceDraftContent(nodeId, item.message.content, null);
      dispatchUi({
        type: "setEditingQueueItemId",
        editingQueueItemId: item.queueItemId,
      });
    },
    [chatActions, dispatchUi, nodeId, replaceDraftContent],
  );

  const cancelQueuedItem = useCallback(
    (item: ChatQueuedItem): void => {
      const actionId = chatActions.queueCancel(item.queueItemId);
      if (actionId === null) return;
      if (editingQueueItemId === item.queueItemId) {
        dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
      }
    },
    [chatActions, dispatchUi, editingQueueItemId],
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
    dispatchUi({ type: "setEditingQueueItemId", editingQueueItemId: null });
  }, [dispatchUi]);

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
        currentComposerSettings,
      );
      if (decision.kind === "silent_inject") {
        // No turn-start-baked setting changed: fold into the running turn at the
        // next safe point. Pass the live toolbar settings explicitly (they match
        // the running turn) so the host's mode decision can't race a lagging
        // restamp of this item.
        chatActions.queueSteerNow(item.queueItemId, currentComposerSettings);
        return;
      }
      // A change the running turn can't absorb: confirm ending the turn first.
      setPendingSteerRestart({ item, decision });
    },
    [chatActions, currentComposerSettings, handle.store],
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
      setEpicRunSettings(currentEpicId, settings, Date.now());
      handle.store.getState().setCurrentComposerSettings(settings);
      // Live-mirror: pending queued prompts always resolve the latest toolbar
      // settings. Exclude the item open for editing (it commits on submit); the
      // store also skips no-op updates and when there are no pending items.
      chatActions.restampQueuedItemSettings(settings, activeEditingQueueItemId);
      // Read the live turn at call time (see steerQueuedItemNow): closing over the
      // per-snapshot `state.activeTurn` object would re-create this callback every
      // streamed token → lowerComposer → composerModel churn → composer re-render.
      if (
        handle.store.getState().activeTurn !== null &&
        permissionModeChanged
      ) {
        chatActions.updateActivePermissionMode(settings.permissionMode);
      }
    },
    [
      activeEditingQueueItemId,
      chatActions,
      currentComposerSettings.permissionMode,
      currentEpicId,
      handle.store,
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
