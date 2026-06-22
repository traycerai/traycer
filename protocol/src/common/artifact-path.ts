/**
 * Browser-safe authority for the on-disk artifact path shape
 * (`…/epics/<epicId>/artifacts/<chain>/index.md`). Pure string operations,
 * NO `node:path` / filesystem access, so the same scanner runs in the host
 * (Node), the RPC resolver, and the gui-app renderer (browser).
 *
 * This is the single home for the ROOT-AGNOSTIC subsequence scan that used to
 * be copy-pasted in the host (the external Traycer Host) and
 * `clients/gui-app/src/markdown/links/artifact-link-path.ts`. Both now
 * consume {@link deriveArtifactPathLayoutRootAgnostic}; the host's local
 * root-CHECKED deriver reuses {@link artifactLayoutFromChain} for the shared
 * tail while keeping its own prefix gate.
 */

export const EPICS_DIRNAME = "epics";
export const EPIC_ARTIFACTS_DIRNAME = "artifacts";
export const EPIC_ARTIFACT_INDEX_FILENAME = "index.md";

/**
 * The structural shape recovered from an artifact `index.md` path: the chain
 * folder that directly contains the `index.md` (`folderName`) plus the chain of
 * ancestor folders above it (`parentSegments`, empty for a top-level artifact),
 * and the `epicId` lifted from the `epics/<epicId>/artifacts` marker.
 */
export type ArtifactPathLayout = {
  epicId: string;
  folderName: string;
  parentSegments: string[];
};

/**
 * Split a path on BOTH separators (so a Windows-authored path resolves on a
 * POSIX viewer and vice-versa), drop empty segments, and normalize `.` / `..`
 * segments (CL-15): `.` is dropped and `..` pops the preceding segment. Without
 * this, a dot segment sitting between `epics/<epicId>` and `artifacts` would
 * break the marker match and a dot inside the chain would leak into the layout.
 */
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
 * Build the `{ folderName, parentSegments }` layout from the chain of folders
 * between `artifacts/` and the trailing `index.md`. Returns `null` when the
 * chain is empty (a bare `…/artifacts/index.md` is not an artifact). The single
 * tail shared by both the root-agnostic scan and the host's root-checked
 * deriver, so the two cannot drift on how a chain maps to a layout.
 */
export function artifactLayoutFromChain(
  chain: string[],
): { folderName: string; parentSegments: string[] } | null {
  if (chain.length === 0) return null;
  return {
    folderName: chain[chain.length - 1],
    parentSegments: chain.slice(0, -1),
  };
}

/**
 * Locate the `epics/<epicId>/artifacts/<chain>/index.md` SUBSEQUENCE anywhere
 * inside `filePath`, regardless of the leading disk root (C1). An artifact link
 * authored on another machine / by another user carries an absolute path under
 * a different home prefix (`/Users/them/.traycer/...`, `C:\Users\...`); gating
 * on a local prefix would silently fail every cross-machine link, so this
 * matches purely on the structural marker.
 *
 * When `expectedEpicId` is non-null the scan pins the epicId at the marker
 * (the host RPC knows which epic it is resolving for, so a foreign epic's path
 * must NOT match); when `null` the first `epics/<id>/artifacts` marker wins and
 * its id is lifted into the result (the client pre-check has no epicId yet).
 *
 * Returns `null` when the basename is not `index.md`, the marker is absent, the
 * pinned epicId does not match, or no chain folder follows `artifacts/`. Does
 * NOT touch the filesystem or any local root.
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
  // Scan left-to-right; pinning the epicId (when known) makes the marker
  // unambiguous, so worktree / .codex / .opencode decoys that happen to contain
  // an `artifacts` dir never collide.
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
