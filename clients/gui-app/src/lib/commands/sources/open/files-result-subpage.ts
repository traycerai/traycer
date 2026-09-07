/**
 * Shared identity for the Files opener's step-2 RESULT sub-pages (the artifact step and each code workspace/worktree step).
 */

const ARTIFACTS_ID = "open:files:artifacts";
const CODE_PREFIX = "open:files:ws:";

export function filesArtifactsResultSubpageId(): string {
  return ARTIFACTS_ID;
}

/**
 * `hostId` is left verbatim (it is a colon-free device id) and `runningDir` is `encodeURIComponent`d (which escapes `:` and `/`, so a Windows `C:\…` root cannot collide with the field separator or the prefix).
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
