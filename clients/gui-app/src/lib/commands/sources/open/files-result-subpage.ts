/**
 * Shared identity for the Files opener's step-2 RESULT sub-pages (the artifact
 * step and each code workspace/worktree step).
 *
 * Step 2 lists come straight from `workspace.searchPaths` - already scoped to
 * the query and ranked by the host's Fuse (typo/transposition tolerant). The
 * pane opener recognizes these ids to turn cmdk's own filtering OFF for them, so
 * the host order is preserved unchanged and cmdk's strict subsequence scorer
 * neither re-ranks the rows nor hides typo matches or the typed
 * notice/truncation rows. cmdk filtering stays ON for the step-1 SOURCE picker
 * (`open:category:files`) and every unrelated opener page.
 *
 * The target is carried IN the id (like `search-target.ts`) so no other sub-page
 * constructor or the shared `CommandSubpage` type has to change.
 */

const ARTIFACTS_ID = "open:files:artifacts";
const CODE_PREFIX = "open:files:ws:";

export function filesArtifactsResultSubpageId(): string {
  return ARTIFACTS_ID;
}

/**
 * `hostId` is left verbatim (it is a colon-free device id) and `runningDir` is
 * `encodeURIComponent`d (which escapes `:` and `/`, so a Windows `C:\…` root
 * cannot collide with the field separator or the prefix).
 */
export function filesCodeRootResultSubpageId(
  hostId: string,
  runningDir: string,
): string {
  return `${CODE_PREFIX}${hostId}:${encodeURIComponent(runningDir)}`;
}

/** True for a step-2 host-result sub-page; false for the step-1 source picker. */
export function isFilesResultSubpageId(id: string): boolean {
  return id === ARTIFACTS_ID || id.startsWith(CODE_PREFIX);
}
