/**
 * Pure decision helpers for the promotable-modal outside-dismissal guard.
 *
 * The scenario being guarded: a Radix `DropdownMenu` (modal, the default) open
 * inside the modal dialog. Dismissing the dropdown by clicking anywhere must NOT
 * tear the whole modal down, while a genuine backdrop click with nothing nested
 * open must still close it.
 *
 * Why the overlay-origin of the gesture is NOT sufficient on its own: while a
 * nested modal layer is open, Radix sets the dialog Content layer to
 * `pointer-events: none`, but the dialog Overlay keeps an inline
 * `pointer-events: auto` and spans the viewport - so EVERY pointerdown outside
 * the dropdown (backdrop and modal body alike) hit-tests to the overlay. The
 * dialog also defers its pointer-down-outside dispatch to the subsequent `click`
 * (the overlay is a registered "dismissable surface"), by which time the
 * dropdown has already closed and the dialog is the top layer again. Net: the
 * dismissal fires with `originalEvent.target === overlay` for exactly the
 * gesture that should be owned by the dropdown.
 *
 * The reliable discriminator is Radix's own layer arithmetic, sampled at
 * pointerdown time: the dialog Content carries inline `pointer-events: none`
 * precisely while a nested layer with outside-pointer-events disabled sits above
 * it. The frame samples that in the overlay's `onPointerDown` and feeds it here.
 */

/**
 * `true` while a nested Radix layer (dropdown/select/menu) sits above the dialog
 * and has claimed the pointer - i.e. the dialog Content is inert to hit-testing.
 * Reads the inline style Radix `DismissableLayer` maintains on the content node.
 */
export function dialogContentInertToPointer(
  content: HTMLElement | null,
): boolean {
  return content !== null && content.style.pointerEvents === "none";
}

/**
 * `true` when the interaction that fired the dismissal originated on the
 * dialog's own dimmed overlay. Necessary but NOT sufficient for closing - see
 * the module comment; combine with `dialogContentInertToPointer` sampled at
 * pointerdown time.
 */
export function interactionStartedOnOverlay(
  originalEvent: Event,
  overlay: HTMLElement | null,
): boolean {
  const target = originalEvent.target;
  return overlay !== null && target instanceof Node && overlay.contains(target);
}
