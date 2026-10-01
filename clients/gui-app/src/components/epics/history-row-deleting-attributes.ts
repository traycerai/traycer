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
