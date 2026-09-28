import type { ComposerTopBannerKind } from "./chat-composer-top-banner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { plainTextPromptContent } from "@/components/epic-canvas/renderers/chat-tile-session-state";

/**
 * Whether the composer may offer the suggestion at all, before asking whether
 * there is one to offer. The suggestion is the empty composer's placeholder,
 * and → (or a tap on a touch device) fills it.
 *
 * - **Only when no banner is up.** A fallback card or a re-auth prompt is
 *   something the user has to deal with; a suggestion is not, and it does not
 *   compete for their attention with one.
 * - **Only when this surface can send.** Filling a composer that cannot send
 *   offers an action the user cannot finish. Two gates, because the
 *   composer's `sendBlocked` does not carry the workspace one: a missing or
 *   unavailable workspace refuses the send button through its own check.
 * - **Only over one empty paragraph.** Filling REPLACES the document. Trimmed
 *   plain text alone cannot decide this: whitespace and an empty code block
 *   are authored drafts whose placeholder is hidden. Clearing the document
 *   brings the suggestion back while the offer still stands.
 */
export function promptSuggestionAllowed(input: {
  readonly topBannerKind: ComposerTopBannerKind;
  readonly sendDisabled: boolean;
  readonly workspaceBlocked: boolean;
  readonly draftHasText: boolean;
  readonly draftHasImages: boolean;
  readonly draftContent: JsonContent;
}): boolean {
  return (
    input.topBannerKind === "none" &&
    !input.sendDisabled &&
    !input.workspaceBlocked &&
    !input.draftHasText &&
    !input.draftHasImages &&
    isSuggestionPlaceholderDocument(input.draftContent)
  );
}

/** Only the ordinary empty paragraph can display an actionable suggestion. */
function isSuggestionPlaceholderDocument(content: JsonContent): boolean {
  if (content.type !== "doc" || content.content?.length !== 1) return false;
  const paragraph = content.content[0];
  return (
    paragraph.type === "paragraph" && (paragraph.content?.length ?? 0) === 0
  );
}

/**
 * The editor calls a fill makes, and nothing else: no send path is reachable
 * from here, which is what makes "accepting a suggestion never sends"
 * structural rather than a convention the call site has to keep.
 */
export type SuggestionFillTarget = Pick<
  ComposerPromptEditorHandle,
  "isReady" | "getJSON" | "setContent" | "focusAtEnd"
>;

/**
 * The key that accepts the suggestion: a bare →, the inline-autosuggestion
 * convention. It is only ever consulted over an empty composer, where → has
 * nothing else to do. A modified → (word or line jumps, selection) is never
 * taken, and neither is one still composing an IME candidate.
 */
export function isPromptSuggestionAcceptKey(event: {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}): boolean {
  return (
    event.key === "ArrowRight" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}

/**
 * How far a touch may travel between down and up and still count as a tap on
 * the composer, not a scroll or a drag that happened to start there.
 */
export const PROMPT_SUGGESTION_TAP_SLOP_PX = 10;

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
  // The live editor may have changed since React offered the placeholder.
  // Never replace a draft based only on that earlier render's empty state.
  if (!isSuggestionPlaceholderDocument(editor.getJSON())) return;
  editor.setContent(plainTextPromptContent(suggestion), null);
  editor.focusAtEnd();
}
