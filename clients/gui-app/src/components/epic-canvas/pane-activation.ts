/**
 * Pane activation deferral contract.
 *
 * `TabGroupView` claims pane focus on `pointerdowncapture` (capture phase,
 * before any child handler runs) so clicking anywhere in a pane activates it.
 * That is wrong for subtrees whose own click must run first: activating a pane
 * triggers a synchronous re-render that can reorder/remount sibling tiles and
 * disrupt the in-flight click (e.g. a chat minimap jump landing on the wrong
 * row). Such subtrees opt out by spreading {@link paneActivationDeferProps};
 * `TabGroupView` then defers their activation to the bubble-phase `click`,
 * which fires after the child's own handler.
 *
 * Both the producer (the marker) and the consumer (the selector) derive from
 * the single attribute name below, so the contract cannot silently drift.
 */
const PANE_ACTIVATION_DEFER_ATTRIBUTE = "data-pane-activation-defer";

export const paneActivationDeferProps = {
  [PANE_ACTIVATION_DEFER_ATTRIBUTE]: "true",
} as const;

const PANE_ACTIVATION_DEFER_SELECTOR = `[${PANE_ACTIVATION_DEFER_ATTRIBUTE}="true"]`;

export function isPaneActivationDeferred(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(PANE_ACTIVATION_DEFER_SELECTOR) !== null;
}
