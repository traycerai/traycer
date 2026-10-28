import { contentIsSubmittable } from "@/lib/composer/composer-content";
import { submitComposerDraft } from "@/lib/drafts/draft-mirror-coordinator";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

/**
 * Moves a chat composer's unsent draft to the composer of the chat that
 * continues it - a clone on another host - and retires it here exactly as a
 * send would, so it neither stays behind nor lands in Drafts. Nothing is sent:
 * the clone's composer shows it, and that composer's own Send judges it. A
 * composer with nothing to send moves nothing.
 */
export function carryComposerDraft(fromChatId: string, toChatId: string): void {
  const draft = readComposerDraftSnapshot(fromChatId);
  if (
    !contentIsSubmittable(draft.content) &&
    draft.browserAnnotations.length === 0
  )
    return;
  const store = useComposerDraftStore.getState();
  store.replaceDraft(toChatId, draft.content, draft.selection);
  store.restoreBrowserAnnotations(toChatId, draft.browserAnnotations);
  void submitComposerDraft(fromChatId);
}
