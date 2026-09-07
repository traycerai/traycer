/** Dismissing the dropdown by clicking anywhere must not tear the whole modal down, while a genuine backdrop
 * click with nothing nested open must still close it. */

/** `true` while a nested Radix layer (dropdown/select/menu) sits above the dialog and has claimed the pointer -
 * i.e. the dialog Content is inert to hit-testing. */
export function dialogContentInertToPointer(
  content: HTMLElement | null,
): boolean {
  return content !== null && content.style.pointerEvents === "none";
}

/** Necessary but not sufficient for closing - see the module comment; combine with
 * `dialogContentInertToPointer` sampled at pointerdown time. */
export function interactionStartedOnOverlay(
  originalEvent: Event,
  overlay: HTMLElement | null,
): boolean {
  const target = originalEvent.target;
  return overlay !== null && target instanceof Node && overlay.contains(target);
}
