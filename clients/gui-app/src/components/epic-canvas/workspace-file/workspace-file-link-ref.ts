/**
 * Resolves user/model-authored markdown file links into workspace-file tabs.
 *
 * This intentionally lives beside, not inside, `workspace-file-ref.ts`.
 * `workspace-file-ref.ts` builds refs from host-canonical file-tree tokens;
 * this module handles messy markdown inputs and turns them into those refs.
 */
import {
  getBasename,
  getDirname,
  isAbsolutePath,
  isWindowsLikePath,
  joinPath,
  normalizePath,
  pathComparisonKey,
  resolveAbsolutePath,
} from "@/lib/path/cross-platform-path";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import { workspaceFileRefFromTreePath } from "./workspace-file-ref";

/**
 * Builds a `WorkspaceFileRef` for a file path taken from a chat markdown link.
 *
 * - an absolute path under one of the roots becomes that root plus a relative
 *   file path;
 * - an absolute path outside every bound root resolves to `null` (it falls back
 *   to normal plain-file handling rather than a synthesized workspace);
 * - a relative path resolves against the primary root.
 */
export function workspaceFileRefFromLinkPath(
  hostId: string,
  roots: ReadonlyArray<string>,
  linkPath: string,
): WorkspaceFileRef | null {
  const trimmed = linkPath.trim();
  if (trimmed.length === 0) return null;

  if (isAbsolutePath(trimmed)) {
    // When bound roots overlap (e.g. `/repo` and `/repo/sub`), the MOST SPECIFIC
    // (longest) matching root wins. Returning on the first match would bind a
    // path like `/repo/sub/app.ts` to `/repo` with relative `sub/app.ts`,
    // keying a different tab than the canonical `/repo/sub` + `app.ts` and so
    // opening a duplicate for the same file.
    const best = roots.reduce<{ root: string; relative: string } | null>(
      (acc, root) => {
        const relative = stripRootPrefix(root, trimmed);
        if (relative === null) return acc;
        if (
          acc === null ||
          normalizePath(root).length > normalizePath(acc.root).length
        ) {
          return { root, relative };
        }
        return acc;
      },
      null,
    );

    // An absolute path contained by no bound root is not a workspace file.
    // Returning null lets the link fall back to normal plain-file handling
    // instead of synthesizing a fake `{ workspacePath: dirname }` root that the
    // host would then be trusted to read from.
    if (best === null) return null;
    // The path is itself a bound root (a directory), not a file under it.
    if (best.relative.length === 0) return null;
    return workspaceFileRefFromTreePath(
      hostId,
      best.root,
      best.relative,
      getBasename(best.relative),
    );
  }

  if (roots.length === 0) return null;
  // Canonicalize before building the ref so non-canonical inputs (`./x`,
  // `a/../b`) key the same tab as their canonical form rather than a duplicate.
  // A trailing-separator (directory) ref, a degenerate `.`, or a root-escaping
  // `..` path denotes no file under the root, so decline it.
  if (hasTrailingSeparator(trimmed)) return null;
  const normalized = normalizePath(trimmed);
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolutePath(normalized)
  ) {
    return null;
  }
  return workspaceFileRefFromTreePath(
    hostId,
    roots[0],
    normalized,
    getBasename(normalized),
  );
}

/** The directory-href convention: a href naming a directory opens ITS `index.md`. */
const DIRECTORY_INDEX_FILENAME = "index.md";

/**
 * Builds the ordered list of relative targets to probe for `normalized` (a
 * link path already trimmed + `normalizePath`d): the direct file first (skipped
 * for a trailing-separator href, which unambiguously names a directory), then
 * that same path's `index.md` as a directory fallback - `workspace.readFile`
 * cannot distinguish "missing" from "is a directory" (`content: null` either
 * way), so a plain `content === null` on the direct probe can't by itself
 * decide whether the directory fallback applies; probing both and letting
 * root-major, target-minor order pick the winner sidesteps that ambiguity.
 */
function relativeLinkTargets(
  trimmedHref: string,
  normalized: string,
): readonly string[] {
  const directoryIndex = joinPath(normalized, DIRECTORY_INDEX_FILENAME);
  return hasTrailingSeparator(trimmedHref)
    ? [directoryIndex]
    : [normalized, directoryIndex];
}

/**
 * Builds one candidate `WorkspaceFileRef` per (root, target) pair for a
 * RELATIVE chat markdown link path, flattened in ROOT-MAJOR, target-minor
 * priority order - i.e. every candidate for root 0 (direct file, then its
 * `index.md`) before any candidate for root 1. Unlike an absolute path (whose
 * longest-matching bound root is deterministic via prefix match), a relative
 * path is ambiguous across multiple roots that may be unrelated siblings on
 * disk - the caller probes each candidate for existence (host RPC, at click
 * time; see `resolveAndOpenRelativeWorkspaceFile`), preserving this priority
 * order so the first-BY-ORDER hit wins regardless of which probe settles
 * first.
 *
 * A `..`-escaping href (`normalized` starts with `../`, or is exactly `..`)
 * is resolved CLIENT-SIDE into a canonical absolute target per root, then
 * addressed via `workspaceFileRefFromAbsoluteFilePath`'s single-file
 * synthesized root (`{ workspacePath: dirname, filePath: basename }`) -
 * `workspace.readFile` enforces containment within its SUPPLIED
 * `workspacePath`, so a candidate built as `{ workspacePath: root, filePath:
 * "../sibling/file.ts" }` would always fail the host's guard even when the
 * resolved absolute file is perfectly readable. An in-root target keeps the
 * existing root-relative candidate (`{ workspacePath: root, filePath:
 * target }`) unchanged.
 *
 * Returns `null` for an empty/degenerate/`.`-only path, an absolute path (the
 * caller routes those through `workspaceFileRefFromLinkPath` instead), or
 * when no roots are bound.
 */
export function candidateWorkspaceFileRefsForRelativeLinkPath(
  hostId: string,
  roots: ReadonlyArray<string>,
  linkPath: string,
): ReadonlyArray<WorkspaceFileRef> | null {
  const trimmed = linkPath.trim();
  if (trimmed.length === 0 || roots.length === 0) return null;
  const normalized = normalizePath(trimmed);
  if (
    normalized.length === 0 ||
    (normalized === "." && !hasTrailingSeparator(trimmed)) ||
    isAbsolutePath(normalized)
  ) {
    return null;
  }
  const escapesRoot = normalized === ".." || normalized.startsWith("../");
  const targets = relativeLinkTargets(trimmed, normalized);
  const refs = roots.flatMap((root) =>
    targets.flatMap((target) => {
      const ref = escapesRoot
        ? workspaceFileRefFromAbsoluteFilePath(
            hostId,
            resolveAbsolutePath(root, target),
          )
        : workspaceFileRefFromTreePath(
            hostId,
            root,
            target,
            getBasename(target),
          );
      return ref === null ? [] : [ref];
    }),
  );
  return refs.length === 0 ? null : refs;
}

/**
 * Resolves one ABSOLUTE target into a ref: the most-specific bound root it
 * falls under, or (when it belongs to no bound root) the out-of-root
 * synthesized single-file root. The shared "how do we address an absolute
 * path" step behind both a direct open and each candidate in
 * {@link candidateWorkspaceFileRefsForAbsoluteLinkPath} - existence is NOT
 * checked here, only how to ADDRESS the target once probed.
 */
function workspaceFileRefForAbsoluteTarget(
  hostId: string,
  roots: ReadonlyArray<string>,
  absoluteTarget: string,
): WorkspaceFileRef | null {
  return (
    workspaceFileRefFromLinkPath(hostId, roots, absoluteTarget) ??
    workspaceFileRefFromAbsoluteFilePath(hostId, absoluteTarget)
  );
}

/**
 * Builds the ordered candidate refs for an ambiguous ABSOLUTE link path,
 * mirroring {@link relativeLinkTargets}'s direct-file-then-`index.md`
 * shape for the absolute case: an explicit trailing separator is
 * unambiguous (directory), so it's canonicalized straight to its
 * `index.md`; a slashless target can't be told apart from a directory
 * reference by spelling alone, so BOTH the direct file and its `index.md`
 * fallback are returned - the caller probes each for existence (the same
 * ambiguity `workspace.readFile` already forces the relative case to
 * sidestep this way: `content: null` either way for "missing" and "is a
 * directory") and opens whichever wins.
 *
 * Returns `null` for a non-absolute or degenerate path, or when neither
 * candidate can be addressed at all (no bound root match AND the
 * out-of-root synthesis itself fails, e.g. a bare filesystem root).
 */
export function candidateWorkspaceFileRefsForAbsoluteLinkPath(
  hostId: string,
  roots: ReadonlyArray<string>,
  absolutePath: string,
): ReadonlyArray<WorkspaceFileRef> | null {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0 || !isAbsolutePath(trimmed)) return null;
  const directoryIndex = joinPath(trimmed, DIRECTORY_INDEX_FILENAME);
  const targets = hasTrailingSeparator(trimmed)
    ? [directoryIndex]
    : [trimmed, directoryIndex];
  const refs = targets.flatMap((target) => {
    const ref = workspaceFileRefForAbsoluteTarget(hostId, roots, target);
    return ref === null ? [] : [ref];
  });
  return refs.length === 0 ? null : refs;
}

/**
 * Builds a `WorkspaceFileRef` for an ABSOLUTE file path that belongs to no bound
 * workspace root, by treating the file's own directory as the workspace root
 * (`{ workspacePath: dirname, filePath: basename }`). This is the deliberate,
 * intentional re-introduction of the synthesized-root behavior CL-1 removed,
 * scoped to NON-artifact links so a user can open any file the agent emits.
 * Returns `null` for a non-absolute or degenerate path.
 *
 * Two callers: the chat link policy for an out-of-root ABSOLUTE link, and
 * `candidateWorkspaceFileRefsForRelativeLinkPath` for a RELATIVE link resolved
 * (client-side, against a bound root) into an absolute path that escapes that
 * root via `../`.
 *
 * HOST DEPENDENCY (load-bearing): this works only because `workspace.readFile`
 * validates the target stays within the SUPPLIED `workspacePath` WITHOUT checking
 * that the directory is a bound root. Hardening `workspace.readFile` to reject
 * non-bound-root workspaces would make every read produced here fail - that
 * hardening and this helper are mutually exclusive as written; migrate this path
 * to a dedicated validated absolute-file read before doing it.
 */
export function workspaceFileRefFromAbsoluteFilePath(
  hostId: string,
  absolutePath: string,
): WorkspaceFileRef | null {
  const trimmed = absolutePath.trim();
  if (trimmed.length === 0 || !isAbsolutePath(trimmed)) return null;
  const directory = getDirname(trimmed);
  const name = getBasename(trimmed);
  if (directory.length === 0 || name.length === 0) return null;
  return workspaceFileRefFromTreePath(hostId, directory, name, name);
}

/**
 * Resolves a link inside a rendered markdown file preview. Relative links are
 * relative to the current file, not the workspace root.
 */
export function workspaceFileRefFromWorkspaceMarkdownLink(
  hostId: string,
  workspacePath: string,
  currentFilePath: string,
  linkPath: string,
): WorkspaceFileRef | null {
  const trimmed = linkPath.trim();
  if (trimmed.length === 0) return null;
  if (isAbsolutePath(trimmed)) {
    return workspaceFileRefFromLinkPath(hostId, [workspacePath], trimmed);
  }
  if (hasTrailingSeparator(trimmed)) return null;

  const resolved = resolveWorkspaceRelativePath(currentFilePath, trimmed);
  if (resolved === null || resolved.length === 0) return null;
  return workspaceFileRefFromTreePath(
    hostId,
    workspacePath,
    resolved,
    getBasename(resolved),
  );
}

function resolveWorkspaceRelativePath(
  currentFilePath: string,
  linkPath: string,
): string | null {
  const baseDir = getDirname(currentFilePath);
  const resolved = normalizePath(
    baseDir.length > 0 ? `${baseDir}/${linkPath}` : linkPath,
  );
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
    return null;
  }
  return isAbsolutePath(resolved) ? null : resolved;
}

function stripRootPrefix(root: string, path: string): string | null {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  const caseInsensitive =
    isWindowsLikePath(normalizedRoot) || isWindowsLikePath(normalizedPath);
  const rootKey = pathComparisonKey(normalizedRoot, caseInsensitive);
  const pathKey = pathComparisonKey(normalizedPath, caseInsensitive);
  if (pathKey === rootKey) return "";
  const prefixKey = rootKey.endsWith("/") ? rootKey : `${rootKey}/`;
  if (!pathKey.startsWith(prefixKey)) return null;
  const prefix = normalizedRoot.endsWith("/")
    ? normalizedRoot
    : `${normalizedRoot}/`;
  return normalizedPath.slice(prefix.length);
}

function hasTrailingSeparator(path: string): boolean {
  return path.endsWith("/") || path.endsWith("\\");
}
