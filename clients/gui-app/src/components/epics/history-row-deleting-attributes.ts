/**
 * The marks a history row's card carries while its task is being deleted, and
 * nothing at rest. One place so the desktop and mobile rows cannot drift.
 */
export function historyRowDeletingAttributes(isDeleting: boolean): {
  readonly "data-deleting": "true" | undefined;
  readonly "aria-busy": true | undefined;
} {
  return isDeleting
    ? { "data-deleting": "true", "aria-busy": true }
    : { "data-deleting": undefined, "aria-busy": undefined };
}

/**
 * What a row's open link takes while its task is being deleted. `disabled`
 * drops the link's destination, so the browser's own link operations (open in
 * a new tab, drag) have nothing to act on - a click guard alone leaves those
 * live. A link without a destination also leaves the tab order, so `tabIndex`
 * keeps the row reachable by keyboard. `aria-disabled` is stated here rather
 * than left to the router's `Link`, so the mark does not depend on which
 * component renders the anchor.
 */
export function historyRowDeletingLinkProps(isDeleting: boolean): {
  readonly disabled: boolean;
  readonly "aria-disabled": true | undefined;
  readonly tabIndex: 0 | undefined;
} {
  return isDeleting
    ? { disabled: true, "aria-disabled": true, tabIndex: 0 }
    : { disabled: false, "aria-disabled": undefined, tabIndex: undefined };
}
