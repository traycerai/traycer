import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  appendBlocks,
  buildQuoteBlockquote,
  type QuoteTextSnapshot,
} from "./append-quote-to-draft";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

/** Instruction line prefixed to the quoted selection in a translation request. */
export const TRANSLATE_TO_SPANISH_INSTRUCTION =
  "Traduce al español el siguiente texto:";

/**
 * Builds the composer document for a translate-to-Spanish request over a
 * validated selection: the instruction paragraph followed by the selection
 * quoted verbatim (a blockquote, or a code block when the selection sat inside
 * a code fence). The agent reads the instruction and translates only the quoted
 * portion.
 */
export function buildTranslateToSpanishRequest(
  snapshot: QuoteTextSnapshot,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: TRANSLATE_TO_SPANISH_INSTRUCTION }],
      },
      buildQuoteBlockquote(snapshot),
    ],
  };
}

/**
 * Appends a translate-to-Spanish request for `snapshot` to the chat tab's
 * composer draft. Non-destructive by design: existing draft content is kept via
 * `appendBlocks`, matching `appendQuoteToDraft`'s contract. Riding
 * `replaceDraft(taskId, next, null)` reuses the composer's
 * `setContent(..., null)` -> `focus("end")` path, so the user lands in the
 * composer with the request ready to send.
 */
export function appendTranslateToSpanishToDraft(
  taskId: string,
  snapshot: QuoteTextSnapshot,
): void {
  const request = buildTranslateToSpanishRequest(snapshot);
  const draft = readComposerDraftSnapshot(taskId);
  const next = appendBlocks(draft.content, [
    ...(request.content ?? []),
    { type: "paragraph" },
  ]);
  useComposerDraftStore.getState().replaceDraft(taskId, next, null);
}
