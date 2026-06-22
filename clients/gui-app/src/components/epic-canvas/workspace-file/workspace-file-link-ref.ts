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
  normalizePath,
  pathComparisonKey,
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

/**
 * Builds a `WorkspaceFileRef` for an ABSOLUTE file path that belongs to no bound
 * workspace root, by treating the file's own directory as the workspace root
 * (`{ workspacePath: dirname, filePath: basename }`). This is the deliberate,
 * intentional re-introduction of the synthesized-root behavior CL-1 removed,
 * scoped by its single caller (the chat link policy) to NON-artifact links so a
 * user can open any file the agent emits. Returns `null` for a non-absolute or
 * degenerate path.
 *
 * HOST DEPENDENCY (load-bearing): this works only because `workspace.readFile`
 * validates the target stays within the SUPPLIED `workspacePath` WITHOUT checking
 * that the directory is a bound root. Hardening `workspace.readFile` to reject
 * non-bound-root workspaces would make every read produced here fail — that
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
