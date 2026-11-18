import type { ComposerTopBannerKind } from "./chat-composer-top-banner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { plainTextPromptContent } from "@traycer-clients/shared/epic/plain-text-content";
import { chordMatchesEvent, type ChordString } from "@/lib/keybindings/chord";
import type { PendingChatAction } from "@/stores/chats/chat-session-store";

/**
 * Whether the composer may offer the suggestion at all, before asking whether
 * there is one to offer. The suggestion is the empty composer's placeholder,
 * and the accept key (→ unless rebound) or a rightward swipe on a touch
 * device fills it.
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
 * Whether a keydown is the one that accepts the suggestion: the chord bound
 * to `composer.suggestion.accept` (a bare → by default, Tab for a person who
 * rebinds it), and nothing else.
 *
 * It is only ever consulted over an empty composer showing a suggestion. Even
 * then it yields to:
 * - an unbound action (`null`): the suggestion is then swipe- or type-over
 *   only, never an invisible fallback to →;
 * - a key something earlier already took (`defaultPrevented`);
 * - an open mention or slash picker, which owns Tab (commit) and the arrows;
 * - an IME still composing a candidate, or an AltGr chord typing a character;
 * - OS key-repeat, so a held key cannot fill and then act again on the text
 *   it just filled.
 *
 * `chordMatchesEvent` compares the physical key and the exact modifier set,
 * so a modified → or Tab (word jumps, selection, backward focus traversal)
 * never matches a bare binding.
 */
export function isPromptSuggestionAcceptEvent(input: {
  readonly binding: ChordString | null;
  readonly event: KeyboardEvent;
  readonly pickerOpen: boolean;
}): boolean {
  const { binding, event, pickerOpen } = input;
  if (binding === null) return false;
  if (event.defaultPrevented || event.repeat || pickerOpen) return false;
  if (event.isComposing) return false;
  // AltGr is Ctrl+Alt to the event on Windows and Linux, and it types a
  // character (AltGr+Q is @ on a German layout). The key is the text's,
  // whatever the binding - the same rule the global provider applies, which
  // cannot reach this editor-local match.
  if (event.getModifierState("AltGraph")) return false;
  return chordMatchesEvent(binding, event);
}

/**
 * The suggestion this surface may offer, given the actions it has in flight.
 *
 * The host retires the suggestion on any send - an edit-and-resend included -
 * and broadcasts that clear BEFORE it acknowledges the action (`handleSend`
 * drops it ahead of the accept, and a run opening clears it ahead of an edit's
 * accept). So while a `send` or `editUserMessage` is still pending, the value
 * this client holds is either the one that send retires or one a frame the
 * host emitted before it saw the send; offering it would let the accept key
 * fill a prompt for a conversation that has already moved on. Once the ack lands, the held
 * value is the host's again: cleared, or - for a send the host refused before
 * retiring anything - the suggestion it still stands by.
 */
export function suggestionOfferableWhilePending(
  suggestedPrompt: string | undefined,
  pendingActions: Readonly<Record<string, Pick<PendingChatAction, "action">>>,
): string | undefined {
  const sendPending = Object.values(pendingActions).some(
    (pending) =>
      pending.action === "send" || pending.action === "editUserMessage",
  );
  return sendPending ? undefined : suggestedPrompt;
}

/**
 * Fills the composer with the suggestion and focuses it. `setContent` is the
 * real editor mutation, so the draft store records it exactly as it would a
 * paste, and the user still presses Enter. A no-op before the editor is ready.
 *
 * Returns whether it filled, so the accept handler takes the key only when it
 * did: a declined fill leaves the key its ordinary job (moving the caret, or
 * moving focus for a Tab binding).
 */
export function fillComposerWithSuggestion(
  editor: SuggestionFillTarget | null,
  suggestion: string,
): boolean {
  if (editor === null || !editor.isReady()) return false;
  // The live editor may have changed since React offered the placeholder.
  // Never replace a draft based only on that earlier render's empty state.
  if (!isSuggestionPlaceholderDocument(editor.getJSON())) return false;
  editor.setContent(plainTextPromptContent(suggestion), null);
  editor.focusAtEnd("reveal-caret");
  return true;
}
