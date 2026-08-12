import { useCallback } from "react";
import { useStore } from "zustand";
import { useActivePaneEffect } from "@/components/epic-tabs/pane-visibility-context";
import { addWithFifoEviction } from "@/lib/bounded-set";
import {
  MAX_DELIVERED_RESTORE_COMPLETIONS,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { showRestoreResultToast } from "./chat-tile-session-state";

interface ChatTileRestoreResultToastsProps {
  readonly handle: ChatSessionStoreHandle;
}

export function ChatTileRestoreResultToasts(
  props: ChatTileRestoreResultToastsProps,
): null {
  const { handle } = props;
  const restore = useStore(handle.store, (state) => state.restore);
  const syncCompletedRestore = useCallback(() => {
    if (restore === null || restore.kind !== "completed") return;

    const completionKey = JSON.stringify([
      restore.checkpointId,
      restore.finishedAt,
    ]);
    const delivered = handle.deliveredRestoreCompletionKeys;
    if (delivered.has(completionKey)) return;
    addWithFifoEviction(
      delivered,
      completionKey,
      MAX_DELIVERED_RESTORE_COMPLETIONS,
    );
    showRestoreResultToast(restore.results);
  }, [handle, restore]);
  useActivePaneEffect(syncCompletedRestore);

  return null;
}
