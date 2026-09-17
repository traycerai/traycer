import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";

/**
 * Restarts the pending-image rewrite whenever this composer gets a document it
 * has not scanned yet.
 *
 * The rewrite has to restart on TWO independent events, and keying it on only
 * the first left a dead end.
 *
 * Editor readiness is the obvious one: a b64 node already in the document when
 * a mount begins has no job attached to it. But readiness alone is not enough.
 * Open a chat before its remote draft arrives and the editor becomes ready on
 * an EMPTY document - the restart finds nothing, and the host draft lands
 * afterwards. `applyComposerHostDocument` bumps `resetEpoch` and the reset
 * bridge installs that document through `syncContent`, which deliberately emits
 * no document-change callback, and readiness never fires again. A legacy inline
 * image arriving that way started no job at all, and with the collector's
 * pending-node guard the draft was then withheld forever, taking every later
 * keystroke with it.
 *
 * So the key is the PAIR: this editor instance, and this replacement
 * generation. `editorReadyTick` is a counter rather than a boolean precisely so
 * a torn-down and re-created editor re-fires, which keeps the remount case
 * covered without a second call site - an earlier shape ran the restart inside
 * the ready callback AND here, starting two jobs for the same node on every
 * first readiness.
 *
 * Call it AFTER `useChatComposerDraft`, so the reset bridge's own effect has
 * already installed the replacement by the time this one runs in the same
 * commit. Idempotent regardless: `putImage` is content-addressed and
 * single-flight, and the rewrite is by node id.
 *
 * A real hook rather than an inline effect in `chat-composer.tsx` so a test can
 * drive THIS code. An earlier test harness re-declared the effect body and
 * proved only that the copy worked - it stayed green with the composer's own
 * effect deleted, and had already drifted from it by one key.
 */
export function useComposerReingestOnReplacement(args: {
  readonly chatId: string;
  readonly editorReadyTick: number;
  readonly reingestPendingImages: () => void;
}): void {
  const { chatId, editorReadyTick, reingestPendingImages } = args;
  const draftResetEpoch = useComposerDraftStore(
    (state) => state.drafts[chatId]?.resetEpoch ?? 0,
  );
  const reingestedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (editorReadyTick === 0) return;
    const key = `${String(editorReadyTick)}:${String(draftResetEpoch)}`;
    if (reingestedKeyRef.current === key) return;
    reingestedKeyRef.current = key;
    reingestPendingImages();
  }, [draftResetEpoch, editorReadyTick, reingestPendingImages]);
}
