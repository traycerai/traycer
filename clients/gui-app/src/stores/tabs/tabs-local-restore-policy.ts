/**
 * Whether the tab store may READ its persisted layout back.
 *
 * Deliberately its own module, importing nothing. The store rehydrates while
 * it is being CREATED - at module evaluation, before any component mounts and
 * long before a layout effect could run - so a shell that must not restore has
 * to be able to say so before the store's module is even reached. A flag that
 * lived beside the store could only ever be set too late, which is a silent
 * failure: the read has already happened and nothing later undoes it.
 *
 * The write half is separate and lives with the store, because a write can be
 * disabled at any point and still be correct from then on. A read cannot.
 */
let restoreEnabled = true;

/**
 * Declares that this shell's persisted tab layout must not be read back.
 *
 * Irreversible on purpose. The only caller is a shell entry stating a fact
 * about itself that does not change while the document lives, and a
 * re-enabling path would exist solely to reintroduce the race this module
 * exists to remove.
 */
export function suppressTabsLocalRestore(): void {
  restoreEnabled = false;
}

export function isTabsLocalRestoreEnabled(): boolean {
  return restoreEnabled;
}

/** Test-only reset; production has no path back to the permissive state. */
export function resetTabsLocalRestorePolicyForTests(): void {
  restoreEnabled = true;
}
