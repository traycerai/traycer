/**
 * Browser-safe authority for the on-disk artifact path shape (`…/epics/<epicId>/artifacts/<chain>/index.md`).
 */

export const EPICS_DIRNAME = "epics";
export const EPIC_ARTIFACTS_DIRNAME = "artifacts";
export const EPIC_ARTIFACT_INDEX_FILENAME = "index.md";

/**
 * The two projection directories that live INSIDE an artifact folder, as siblings of its `index.md`.
 * Named here rather than as bare literals at each site so the sweep exemption, the ingest rejection, and the writers cannot drift apart on the spelling.
 */
export const EPIC_ARTIFACT_IMAGES_DIRNAME = "images";
export const EPIC_ARTIFACT_COMMENTS_DIRNAME = ".comments";

export type ArtifactPathLayout = {
  epicId: string;
  folderName: string;
  parentSegments: string[];
};

function normalizeArtifactPathSegments(filePath: string): string[] {
  const raw = filePath.split(/[\\/]+/u).filter((s) => s.length > 0);
  const normalized: string[] = [];
  for (const segment of raw) {
    if (segment === ".") continue;
    if (segment === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

/**
 * Case fold, not lowercase, for reserved-name comparison. `toLowerCase` misses U+017F; upper-then-lower is the approximation.
 */
function caseFold(value: string): string {
  return value.toUpperCase().toLowerCase();
}

/**
 * Strip the trailing dots and spaces Win32 drops from a path component.
 * `CreateFile(".comments.")` and `CreateFile(".comments ")` both open `.comments` - the trailing padding never reaches the filesystem.
 */
function stripWin32TrailingPadding(value: string): string {
  return value.replace(/[. ]+$/u, "");
}

/**
 * Whether a directory name addresses the reserved comment-projection directory on any supported platform.
 * Share this predicate with host file-sync; over-reserving is safe because `slugify` cannot mint a leading dot.
 */
export function isEpicArtifactCommentsDirName(name: string): boolean {
  // Padding first: it is positional, and folding can change length (`ß` to `ss`), so stripping a tail afterwards would be reasoning about the wrong string.
  return (
    caseFold(stripWin32TrailingPadding(name)) === EPIC_ARTIFACT_COMMENTS_DIRNAME
  );
}

/**
 * Layout from the chain between `artifacts/` and `index.md`. Returns `null` for an empty chain or any reserved `.comments` segment.
 * Do not reject every dot-prefixed segment; do not reserve `images`. Comparison is case-folded.
 */
export function artifactLayoutFromChain(
  chain: string[],
): { folderName: string; parentSegments: string[] } | null {
  if (chain.length === 0) return null;
  if (chain.some(isEpicArtifactCommentsDirName)) return null;
  return {
    folderName: chain[chain.length - 1],
    parentSegments: chain.slice(0, -1),
  };
}

/**
 * Locate `epics/<epicId>/artifacts/<chain>/index.md` by structure, not local prefix. Non-null `expectedEpicId` must match; `null` takes the first marker.
 */
export function deriveArtifactPathLayoutRootAgnostic(
  filePath: string,
  expectedEpicId: string | null,
): ArtifactPathLayout | null {
  const segments = normalizeArtifactPathSegments(filePath);
  if (segments.length === 0) return null;
  if (segments[segments.length - 1] !== EPIC_ARTIFACT_INDEX_FILENAME) {
    return null;
  }
  // Scan left-to-right; pinning the epicId (when known) makes the marker unambiguous, so worktree / .codex / .opencode decoys that happen to contain an `artifacts` dir never collide.
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (
      segments[i] !== EPICS_DIRNAME ||
      segments[i + 2] !== EPIC_ARTIFACTS_DIRNAME
    ) {
      continue;
    }
    if (expectedEpicId !== null && segments[i + 1] !== expectedEpicId) {
      continue;
    }
    const layout = artifactLayoutFromChain(
      segments.slice(i + 3, segments.length - 1),
    );
    if (layout === null) return null;
    return { epicId: segments[i + 1], ...layout };
  }
  return null;
}
