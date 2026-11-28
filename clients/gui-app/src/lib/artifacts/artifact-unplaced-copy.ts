/** Its parent is deleted, hidden, unreadable or itself has no place. */
const HIDDEN_PARENT_COPY =
  "This artifact is inside one that isn't shown, so it can't be opened.";
/** A folder on its path is held for another artifact. */
const RESERVED_PREFIX_COPY =
  "This artifact's folder is in use by another artifact, so it can't be opened yet.";
/** Its own fields name no location, or its parent is a file. */
const NO_PATH_COPY =
  "This artifact has no location in the task, so it can't be opened.";
/** It shares a name with another and no shorter form of the name fits. */
const NO_SUFFIX_FITS_COPY =
  "This artifact's name is too long to tell it apart from another with the same name. Rename it to open it.";
/** It is nested inside itself. */
const PARENT_CYCLE_COPY =
  "This artifact is nested inside itself, so it can't be opened.";
/** A reason this app does not know: plain "unplaced", no reason of its own. */
const UNPLACED_COPY = "This artifact can't be opened.";

const COPY_BY_REASON: Readonly<Record<string, string>> = Object.freeze({
  "hidden-parent": HIDDEN_PARENT_COPY,
  "reserved-prefix": RESERVED_PREFIX_COPY,
  "no-path": NO_PATH_COPY,
  "no-suffix-fits": NO_SUFFIX_FITS_COPY,
  "parent-cycle": PARENT_CYCLE_COPY,
});

/** What an artifact the host could not place says in place of its page. */
export function artifactUnplacedCopy(reason: string): string {
  return Object.hasOwn(COPY_BY_REASON, reason)
    ? COPY_BY_REASON[reason]
    : UNPLACED_COPY;
}
