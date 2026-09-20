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

/**
 * The same surfaces, hand-rolled. A surface that is not built on a primitive
 * carries no `data-slot` / `data-state` pair to read, and must not be given
 * one: the slot is what hands a surface the primitive's own fill and motion
 * CSS (`styles/theme-surfaces.css`), which is exactly what a hand-rolled one
 * is avoiding. The installed mobile app's navigation drawer is the one so far
 * - it owns its transform outright so a finger can reverse it mid-flight
 * (`mobile-nav-drawer-surface.tsx`) - and it states the same two facts, "I am
 * an overlay" and "I am open", on this single attribute.
 */
const OVERLAY_SURFACE_ATTRIBUTE = "data-overlay-surface";

export const OVERLAY_SELECTOR = [
  ...OVERLAY_SLOTS.map((slot) => `[data-slot="${slot}"]`),
  `[${OVERLAY_SURFACE_ATTRIBUTE}]`,
].join(", ");
export const OPEN_OVERLAY_SELECTOR = [
  ...OVERLAY_SLOTS.map((slot) => `[data-slot="${slot}"][data-state="open"]`),
  `[${OVERLAY_SURFACE_ATTRIBUTE}="open"]`,
].join(", ");
export const CLOSING_OVERLAY_SELECTOR = [
  ...OVERLAY_SLOTS.map((slot) => `[data-slot="${slot}"][data-state="closed"]`),
  `[${OVERLAY_SURFACE_ATTRIBUTE}="closed"]`,
].join(", ");

/**
 * The overlays a card is portalled INTO rather than floated over, because they
 * are the ones that go MODAL: each seals every body-level sibling off - inert
 * (`use-modal-surface-containment.ts`), `aria-hidden`, or `pointer-events:
 * none` on the body (Radix's own containment) - so a card left beside them
 * would be on screen and dead. Inside, it is part of the surface that is still
 * reachable, and Floating UI is given the same node as its boundary.
 *
 * The pickers are deliberately absent. They seal nothing, so a card beside one
 * still works, and a card INSIDE one would be clipped to a surface the size of
 * its own trigger.
 */
export const MODAL_OVERLAY_SELECTOR = [
  '[data-slot="dialog-content"]',
  '[data-slot="sheet-content"]',
  `[${OVERLAY_SURFACE_ATTRIBUTE}="open"]`,
].join(", ");

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
