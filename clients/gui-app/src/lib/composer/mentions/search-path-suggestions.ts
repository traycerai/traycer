import type {
  WorkspaceFileMentionSuggestion,
  WorkspaceFolderMentionSuggestion,
  WorkspaceSearchPathResult,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { dirnameOfPath } from "@/lib/path";

/**
 * Rebuilds file/folder @-mention suggestions from a `workspace.searchPaths`
 * result. The scoped RPC deliberately does NOT return a host-absolute path as
 * authority; the renderer reconstructs the mention's fields from the root it
 * already holds (and already authorized by selecting it) plus the host-returned
 * relative path. The reconstruction mirrors the host's legacy
 * `workspace.mentionFiles`/`mentionFolders` suggestion shape so downstream
 * mention rendering, preview, and serialization are identical whichever RPC
 * produced the entry.
 *
 * `root` is the caller's known workspace/worktree root (never widened from the
 * RPC result). `relPath` is host-canonical POSIX. The absolute path is a
 * display/serialization target, not new authority.
 */

export function fileSuggestionFromSearchResult(
  root: string,
  result: WorkspaceSearchPathResult,
): WorkspaceFileMentionSuggestion {
  const relPath = normalizeRel(result.relPath);
  const description = mentionDescription(relPath);
  return {
    kind: "file",
    id: `file:${root}:${relPath}`,
    label: result.name,
    relPath,
    absolutePath: joinWithinRoot(root, relPath),
    workspacePath: root,
    description,
  };
}

export function folderSuggestionFromSearchResult(
  root: string,
  result: WorkspaceSearchPathResult,
): WorkspaceFolderMentionSuggestion {
  const relPath = normalizeRel(result.relPath);
  const description = mentionDescription(relPath);
  // The legacy folder suggestion carries a trailing-slash `relPath`; match it so
  // the two RPCs produce indistinguishable folder entries.
  return {
    kind: "folder",
    id: `folder:${root}:${relPath}/`,
    label: result.name,
    relPath: `${relPath}/`,
    absolutePath: joinWithinRoot(root, relPath),
    workspacePath: root,
    description,
  };
}

function mentionDescription(relPath: string): string {
  const dir = dirnameOfPath(relPath);
  return dir === "" ? "" : dir;
}

// Strip any leading slash and reject parent-traversal segments defensively -
// the host already jails the relative path, so this only guards against a
// malformed payload; it never fabricates authority.
function normalizeRel(rawRelPath: string): string {
  const trimmed = rawRelPath.replace(/^\/+/, "").replace(/\/+$/, "");
  const safe = trimmed
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "..")
    .join("/");
  return safe;
}

/**
 * Joins a POSIX relative path onto a host root, honoring the root's separator
 * convention so the absolute path resolves on the host the agent runs on. The
 * relative path is host-provided and jailed (see {@link normalizeRel}), so the
 * result always stays within `root`.
 */
export function joinWithinRoot(root: string, posixRelPath: string): string {
  const rel = normalizeRel(posixRelPath);
  const windows = isWindowsRoot(root);
  const separator = windows ? "\\" : "/";
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  const nativeRel = windows ? rel.replaceAll("/", "\\") : rel;
  if (nativeRel.length === 0) return trimmedRoot;
  return `${trimmedRoot}${separator}${nativeRel}`;
}

function isWindowsRoot(root: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(root) || root.includes("\\");
}
