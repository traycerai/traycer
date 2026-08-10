/**
 * Open epic tabs whose ids the host did NOT confirm as existing epics.
 *
 * `existingEpicIds` must be a positively-established set - see
 * `EpicTabExistenceReconciler`, whose only action on the result is destructive
 * (force-closing tabs), so an absent or failed lookup must never reach here as
 * an empty set.
 */
export function missingEpicIds(
  openEpicIds: ReadonlyArray<string>,
  existingEpicIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  return openEpicIds.filter((epicId) => !existingEpicIds.has(epicId));
}
