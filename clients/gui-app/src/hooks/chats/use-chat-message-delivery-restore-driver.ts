import { useEffect } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { appendBlocks } from "@/components/chat/quote/append-quote-to-draft";

/**
 * Puts a withdrawn opening prompt back in its composer - the one restorer for
 * that message on a host that publishes a delivery view
 * (`chat.subscribe@1.15`).
 *
 * An opening prompt is either sent or back in the composer. The host withdraws
 * one it never started (worktree setup, preparation, a failed start, Stop) and
 * hands its text back through the view's `restore`. Every local copy of that
 * message stands aside for it: the store drops them in the same update that
 * seats the withdrawal, and refuses to restore the message by id while the
 * view names it, so this is the only way the prompt comes back.
 *
 * WHEN is `takeMessageDeliveryRestoration`'s call, once per message per
 * session: the chat's owner, a restore to take, and either a withdrawal this
 * session watched happen (the view named the message while it was pending or
 * preparing) or one no composer has claimed yet - so reopening a chat never
 * pushes an old prompt into a composer the user has moved on from. The tile
 * adds its own gate: an open stream it can act on, which is also what lets the
 * acknowledgement go out at once.
 *
 * MERGED, NEVER OVERWRITTEN. A composer holding a draft keeps it: the restored
 * prompt goes first and the draft follows, in one document. The withdrawal can
 * land while the user is already typing their next message, and neither text
 * is ours to drop.
 *
 * ACKNOWLEDGED ONCE RESTORED. `messageDeliveryRestored` tells the host a
 * composer holds the prompt (`restoreClaimed`); an acknowledgement that cannot
 * go out stays owed in the store, and on this device across a reload, and is
 * sent when the session can.
 */
interface ChatMessageDeliveryRestoreDriverOptions {
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
  readonly profileUserId: string | null;
}

export function useChatMessageDeliveryRestoreDriver(
  options: ChatMessageDeliveryRestoreDriverOptions,
): void {
  const { handle, nodeId, profileUserId } = options;
  const { canAct, connectionStatus, messageDelivery } = useStore(
    handle.store,
    useShallow((state) => ({
      canAct: state.access?.canAct === true,
      connectionStatus: state.connectionStatus,
      messageDelivery: state.messageDelivery,
    })),
  );
  const replaceDraft = useComposerDraftStore((state) => state.replaceDraft);

  useEffect(() => {
    if (messageDelivery?.state.phase !== "withdrawn") return;
    if (connectionStatus !== "open" || !canAct || profileUserId === null) {
      return;
    }
    const store = handle.store.getState();
    const restoration = store.takeMessageDeliveryRestoration();
    if (restoration === null) return;
    // Read live, never through a subscription: the draft that counts is the
    // one in the composer at the moment the prompt lands in it.
    const draft = readComposerDraftSnapshot(nodeId).content;
    replaceDraft(nodeId, mergedIntoDraft(restoration.content, draft), null);
    store.messageDeliveryRestored({
      messageId: restoration.messageId,
      expectedRevision: restoration.revision,
    });
  }, [
    canAct,
    connectionStatus,
    handle.store,
    messageDelivery,
    nodeId,
    profileUserId,
    replaceDraft,
  ]);
}

/**
 * The composer's document once the restored prompt is back in it: the prompt
 * alone over an empty draft, and the prompt followed by the draft over one the
 * user had started. "Started" is {@link contentIsSubmittable}, so an
 * attachment-only draft is kept too - images cannot be retyped.
 */
function mergedIntoDraft(
  restored: JsonContent,
  draft: JsonContent,
): JsonContent {
  if (!contentIsSubmittable(draft)) return restored;
  return appendBlocks(restored, draft.content ?? []);
}
