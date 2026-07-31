/**
 * True when a key event landed inside a text field, so a BARE-LETTER shortcut
 * must defer to normal typing.
 *
 * Only for shortcuts bound WIDER than the field - a window listener, or a
 * container that a text input lives inside. A shortcut whose surface holds no
 * editable node needs no guard, and a pointer-anchored overlay may
 * deliberately claim the key anyway (see `worktree-owner-metadata.tsx`, where
 * the open hover card - not the caret - owns `R`).
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "TEXTAREA" ||
    target.tagName === "INPUT" ||
    target.isContentEditable
  );
}
