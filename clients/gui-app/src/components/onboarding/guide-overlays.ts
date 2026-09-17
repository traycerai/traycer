/**
 * Which surfaces own the screen, and which own Escape.
 *
 * Shared by the coachmark, which pauses under an overlay and hands Escape to
 * one, and by the tour, whose Escape is its Skip button. Both answer the same
 * question about the same DOM, so they read the same list.
 */

/** The surfaces that own attention while they are open. */
const OVERLAY_SLOTS = [
  "dialog-content",
  "popover-content",
  "dropdown-menu-content",
  "sheet-content",
] as const;

export const OVERLAY_SELECTOR = OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"]`,
).join(", ");
export const OPEN_OVERLAY_SELECTOR = OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"][data-state="open"]`,
).join(", ");
export const CLOSING_OVERLAY_SELECTOR = OVERLAY_SLOTS.map(
  (slot) => `[data-slot="${slot}"][data-state="closed"]`,
).join(", ");

/**
 * The surfaces that answer Escape for themselves. Wider than the overlay slots
 * above, which are about who owns the SCREEN: the hand-rolled pickers sit over
 * their editor without obscuring it, mount only while they are open, carry no
 * `data-state`, and close on the very Escape a guide used to swallow - which
 * finished the guide for the session. Three are listed by slot: the composer's
 * mention/slash menu, the comment composer's mention picker, and the artifact
 * editor's link popover. The rest is the shape every Radix dismissable layer
 * shares (`select`, `context-menu`, `drawer`, and the four slots above), so a
 * new Radix one is covered the day it ships; a new hand-rolled one is not,
 * and belongs in this list.
 */
const ESCAPE_OWNER_SELECTOR = [
  OPEN_OVERLAY_SELECTOR,
  '[data-slot="composer-menu"]',
  '[data-slot="mention-suggestion"]',
  '[data-slot="artifact-link-popover"]',
  '[data-state="open"]:is([role="menu"], [role="listbox"], [role="dialog"])',
].join(", ");

/**
 * An open dismissable surface that holds none of `within`. A surface the card
 * or the step's target LIVES in is not another one, so a step inside a
 * settings dialog still dismisses on Escape. Pass nothing to ask whether any
 * such surface is open at all.
 */
export function escapeOwnedElsewhere(
  within: ReadonlyArray<Element | null>,
): boolean {
  return Array.from(document.querySelectorAll(ESCAPE_OWNER_SELECTOR)).some(
    (surface) =>
      within.every((node) => node === null || !surface.contains(node)),
  );
}
