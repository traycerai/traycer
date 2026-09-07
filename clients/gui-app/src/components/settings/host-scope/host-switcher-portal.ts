/** So the guard is written once, keyed on a marker the switcher sets, instead of each container re-deriving
 * "was that click one of mine" from a test id it happens to know about. */
export const HOST_SWITCHER_LIST_ATTRIBUTE = "data-host-switcher-list";

/** Whether an outside-interaction event came from the host switcher's list - i.e. from a surface that is
 * visually inside the container even though the DOM says otherwise. */
export function isHostSwitcherListInteraction(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(`[${HOST_SWITCHER_LIST_ATTRIBUTE}]`) !== null;
}
