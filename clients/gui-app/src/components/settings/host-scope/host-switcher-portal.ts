/**
 * The marker every container uses to recognise the host switcher's own list.
 *
 * The list is a Radix popover, so it portals OUTSIDE whatever surface it was
 * opened from. Every click in it therefore reaches that surface as an
 * interaction from OUTSIDE, and a surface that dismisses on outside
 * interactions closes itself the moment someone picks a host — that is, the
 * picker closes the panel it exists to scope, and no host can ever be chosen.
 * The header's usage popover hit this first; the worktree pickers embed the
 * same switcher inside their own popovers and would each hit it in turn.
 *
 * So the guard is written once, keyed on a marker the switcher sets, instead of
 * each container re-deriving "was that click one of mine" from a test id it
 * happens to know about. A container that forgets it does not fail subtly: its
 * panel shuts on the first click in the list.
 */
export const HOST_SWITCHER_LIST_ATTRIBUTE = "data-host-switcher-list";

/**
 * Whether an outside-interaction event came from the host switcher's list —
 * i.e. from a surface that is visually inside the container even though the
 * DOM says otherwise.
 */
export function isHostSwitcherListInteraction(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(`[${HOST_SWITCHER_LIST_ATTRIBUTE}]`) !== null;
}
