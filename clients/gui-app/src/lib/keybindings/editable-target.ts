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

/**
 * Diffs renders its contenteditable inside an open shadow root. The window
 * keybinding listener therefore sees the shadow host as `event.target`; the
 * composed path is the reliable way to keep canvas shortcuts out of the
 * editor while still allowing its native text-editing and find commands.
 */
export function isDiffsEditorEvent(event: Event): boolean {
  let insideDiffsEditor = false;
  let hasEditableTarget = false;

  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    if (target.hasAttribute("data-diffs-editor-boundary")) {
      insideDiffsEditor = true;
    }
    // `isContentEditable` (not raw attribute presence) so an explicit
    // `contenteditable="false"` node inside the boundary is correctly NOT
    // treated as editable - `getAttribute(...) !== null` would wrongly match
    // it too, since the attribute is present regardless of its value.
    if (target.isContentEditable) {
      hasEditableTarget = true;
    }
  }

  return insideDiffsEditor && hasEditableTarget;
}
