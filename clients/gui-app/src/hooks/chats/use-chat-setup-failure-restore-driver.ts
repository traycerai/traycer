import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { selectRestorableSetupInterruption } from "@/stores/chats/chat-session-selectors";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

/**
 * Drives the "restore-to-composer" half of Flow 8 for chats.
 *
 * Watches the latest restorable setup interruption chat event for this
 * chat-session handle. When a new failure/cancellation event arrives that
 * names a `messageId`, the driver:
 *
 *  1. Pulls the locally-cached pending content out of `pendingUserMessages`
 *     via the chat-session store's `takeSetupFailedRestoration` action.
 *     That action removes the matching pending entry so the queued message
 *     no longer appears as in-flight; later queued messages stay in the
 *     queue (the host decides queue state, not the renderer).
 *  2. Pushes the recovered structured content back into the composer draft
 *     for `nodeId` via `replaceDraft`, which bumps the editor reset epoch
 *     so the Tiptap editor re-seeds with the restored prompt.
 *  3. For a path-less failure (the generic `SETUP_AWAIT_FAILED` catch-all,
 *     which the in-transcript setup card cannot anchor without a
 *     `workspacePath`), toasts the failure so it isn't silent - the parity
 *     the old failure banner provided. This fires strictly after a successful
 *     restoration (step 1 returned content), so a historical failure replayed
 *     on a cold snapshot open never re-announces itself.
 *
 * The hook reads `selectRestorableSetupInterruption` rather than the latest
 * setup status event. The orchestrator's binding-change observer can append a
 * transition-only setup event (`messageId: null`) for the same transition that
 * already produced the gating event carrying the queued message id; selecting
 * strictly the latest event would let that transition-only emission shadow the
 * gating one and skip the restore. The restorable selector keeps the gating
 * event visible regardless of arrival order while banners continue to read the
 * freshest setup status separately.
 *
 * Already-restored events are tracked by `eventId` so a stale snapshot or a
 * `setup.failed` echoed across reconnects does not re-restore a draft the
 * user may have edited. The ref is keyed per `nodeId`/`chatId` so opening
 * the same chat again starts with a fresh dedupe set. That guard carries more
 * weight on the windowed line, where the interruption is not an event the
 * client can watch arrive once but a VALUE re-delivered on every snapshot -
 * `eventId` is then the only thing distinguishing "a new failure" from "the
 * same failure, restated".
 */
interface ChatSetupFailureRestoreDriverOptions {
  readonly handle: ChatSessionStoreHandle;
  readonly nodeId: string;
}

export function useChatSetupFailureRestoreDriver(
  options: ChatSetupFailureRestoreDriverOptions,
): void {
  const { handle, nodeId } = options;
  const events = useStore(handle.store, (state) => state.events);
  // Both inputs are subscribed separately and combined in a memo rather than
  // selected in one `useStore` call, because the selector BUILDS its result on
  // the legacy path - a fresh object every invocation would fail
  // `useSyncExternalStore`'s stability requirement and re-render forever. Here
  // the memo's output is stable while its two inputs are, and on the windowed
  // line it is a property read off the snapshot's own payload.
  const transcriptDerived = useStore(
    handle.store,
    (state) => state.transcriptDerived,
  );
  // The third input, and the one that makes the windowed answer live rather
  // than as-of-the-last-snapshot: the records the host pushed since. Subscribed
  // as the window itself, whose identity the store replaces whenever any of
  // this moves, rather than as `.liveEvents` - a selector returning a nested
  // array is stable only by luck of the reducer.
  const transcriptWindow = useStore(
    handle.store,
    (state) => state.transcriptWindow,
  );
  const interruption = useMemo(
    () =>
      selectRestorableSetupInterruption({
        events,
        transcriptDerived,
        transcriptWindow,
      }),
    [events, transcriptDerived, transcriptWindow],
  );
  const replaceDraft = useComposerDraftStore((state) => state.replaceDraft);
  // Dedupe set is keyed alongside the chat-session handle so opening a
  // fresh chat on the same nodeId doesn't inherit the previous chat's
  // already-handled eventIds. Storing the bound handle in `useState` and
  // resetting on render-time prop change is the React 19 idiomatic way
  // to reset derived state without an effect (the runtime restarts the
  // render after the in-render `setState`, so the rest of the hook reads
  // the fresh `Set`).
  const [dedupe, setDedupe] = useState<{
    readonly handle: ChatSessionStoreHandle;
    readonly ids: Set<string>;
  }>(() => ({ handle, ids: new Set() }));
  if (dedupe.handle !== handle) {
    setDedupe({ handle, ids: new Set() });
  }

  useEffect(() => {
    if (interruption === null) return;
    const eventId = interruption.eventId;
    if (dedupe.ids.has(eventId)) return;
    dedupe.ids.add(eventId);
    const restored = handle.store
      .getState()
      .takeSetupFailedRestoration(interruption.messageId);
    if (restored === null) return;
    replaceDraft(nodeId, restored, null);
    // A path-less setup failure (the generic `SETUP_AWAIT_FAILED` catch-all,
    // which carries no `workspacePath`) produces NO setup card - the deriver
    // can't anchor a card without a workspace - so this toast is the only
    // failure feedback, restoring the parity the old failure banner provided.
    // It fires only after an actual restoration (`restored !== null`), so a
    // historical path-less failure replayed on a cold snapshot open or a driver
    // remount - where the one-shot restore slot is already consumed - does not
    // re-announce a stale failure. Path-ful failures render an inline failure
    // card, so they need no toast.
    if (
      interruption.eventType === "setup.failed" &&
      (interruption.workspacePath === null ||
        interruption.workspacePath.length === 0)
    ) {
      reportableErrorToast(
        "Setup failed before the first message could run.",
        undefined,
        {
          title: "Workspace setup failed",
          message: "Setup failed before the first message could run.",
          code: null,
          source: "Chat setup",
        },
      );
    }
  }, [dedupe, interruption, handle.store, nodeId, replaceDraft]);
}
