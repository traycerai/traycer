/**
 * Decides whether an outside-dismissal interaction on a promotable modal is a
 * genuine backdrop click that should close the modal.
 *
 * Returns `true` ONLY when the interaction that fired the dismissal originated on
 * the dialog's own dimmed overlay. Any other origin - a click on a nested Radix
 * layer portaled outside the content (the tier-filter / sort `DropdownMenu`, a
 * `Select`, a tooltip), or on the modal's own body - is a gesture some inner layer
 * owns, and the modal must be kept open (the caller `preventDefault()`s the
 * dismissal). This is the fix for the dropdown-inside-dialog dismissal: a
 * pointer-down outside an open dropdown dismisses the dropdown's `DismissableLayer`
 * and the SAME gesture reaches the dialog's layer; gating on the overlay lets the
 * dropdown close on its own without tearing the whole modal down, while a real
 * backdrop click still closes it.
 */
export function interactionStartedOnOverlay(
  originalEvent: Event,
  overlay: HTMLElement | null,
): boolean {
  const target = originalEvent.target;
  return overlay !== null && target instanceof Node && overlay.contains(target);
}
