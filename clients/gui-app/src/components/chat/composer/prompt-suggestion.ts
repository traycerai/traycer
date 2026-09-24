import type { ComposerTopBannerKind } from "./chat-composer-top-banner";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { plainTextPromptContent } from "@/components/epic-canvas/renderers/chat-tile-session-state";

/**
 * Whether the composer has room for the suggestion chip at all, before asking
 * whether there is a suggestion to show.
 *
 * - **Only when no banner holds the slot.** The banner chain is strictly one at
 *   a time and the chip is below every entry in it: a fallback card or a
 *   re-auth prompt is something the user has to deal with, a suggestion is
 *   not.
 * - **Only when this surface can send.** Filling a composer that cannot send
 *   offers an action the user cannot finish.
 * - **Only over an empty draft.** Filling REPLACES the document, so a chip
 *   over a draft would be one click from destroying it. Typing hides the chip;
 *   clearing the draft brings it back while the suggestion still stands.
 */
export function promptSuggestionChipAllowed(input: {
  readonly topBannerKind: ComposerTopBannerKind;
  readonly sendDisabled: boolean;
  readonly draftHasText: boolean;
  readonly draftHasImages: boolean;
}): boolean {
  return (
    input.topBannerKind === "none" &&
    !input.sendDisabled &&
    !input.draftHasText &&
    !input.draftHasImages
  );
}

/**
 * The editor calls a fill makes, and nothing else: no send path is reachable
 * from here, which is what makes "the chip never sends" structural rather than
 * a convention the call site has to keep.
 */
export type SuggestionFillTarget = Pick<
  ComposerPromptEditorHandle,
  "isReady" | "setContent" | "focusAtEnd"
>;

/**
 * Fills the composer with the suggestion and focuses it. `setContent` is the
 * real editor mutation, so the draft store records it exactly as it would a
 * paste, and the user still presses Enter. A no-op before the editor is ready.
 */
export function fillComposerWithSuggestion(
  editor: SuggestionFillTarget | null,
  suggestion: string,
): void {
  if (editor === null || !editor.isReady()) return;
  editor.setContent(plainTextPromptContent(suggestion), null);
  editor.focusAtEnd();
}
