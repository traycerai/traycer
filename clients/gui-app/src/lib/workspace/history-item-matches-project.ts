import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

const TRAYCER_WORKTREES_MARKER = "/.traycer/worktrees/";

/**
 * An existing chat belongs to a project when every workspace path sits
 * inside that project's folders (or a documented Traycer worktree of
 * them). Claim wins only when there is no path. Fan-out that also
 * touched another repo is not this project's History row.
 */
export function historyItemMatchesProject(
  item: Pick<HistoryItem, "epicId" | "worktreePaths" | "linkedWorkspaces">,
  profile: ProjectProfile,
): boolean {
  if (profile.folderPaths.length === 0) {
    return profile.epicIds.includes(item.epicId);
  }
  const folders = profile.folderPaths.map(normalizePathSeparators);
  if (item.linkedWorkspaces.length > 0) {
    return item.linkedWorkspaces.every((workspace) =>
      folders.some((folder) =>
        pathIsInsideFolder(
          normalizePathSeparators(workspace.workspacePath),
          folder,
        ),
      ),
    );
  }
  // When the cloud row already named its folders, do not also guess from
  // worktree basenames — two checkouts named Titanos would collide.
  if (item.worktreePaths.length > 0) {
    return item.worktreePaths.every((worktreePath) =>
      folders.some((folder) =>
        isDocumentedTraycerWorktreeOfFolder(
          normalizePathSeparators(worktreePath),
          folder,
        ),
      ),
    );
  }
  return profile.epicIds.includes(item.epicId);
}

export function filterHistoryItemsForProject<
  T extends Pick<HistoryItem, "epicId" | "worktreePaths" | "linkedWorkspaces">,
>(
  items: ReadonlyArray<T>,
  profile: ProjectProfile | null,
): ReadonlyArray<T> {
  if (profile === null) return items;
  return items.filter((item) => historyItemMatchesProject(item, profile));
}

export type HistoryListEmptyState =
  | "no-tasks"
  | "no-filter-matches"
  | "hidden-by-active-project";

/**
 * Which empty copy the history list shows. When a project profile hides every
 * row while chats still exist outside it, the list must say so - the plain
 * "No tasks yet" copy reads as if the chats were deleted. `preProjectFilterCount`
 * is the list size BEFORE the project filter (search filters still applied),
 * so a search that matches only outside the project also gets the project copy.
 */
export function historyListEmptyState(input: {
  readonly visibleCount: number;
  readonly preProjectFilterCount: number;
  readonly hasActiveFilters: boolean;
  readonly projectFilterActive: boolean;
}): HistoryListEmptyState | null {
  if (input.visibleCount > 0) return null;
  if (input.projectFilterActive && input.preProjectFilterCount > 0) {
    return "hidden-by-active-project";
  }
  return input.hasActiveFilters ? "no-filter-matches" : "no-tasks";
}

function isDocumentedTraycerWorktreeOfFolder(
  worktreePath: string,
  folder: string,
): boolean {
  if (pathIsInsideFolder(worktreePath, folder)) return true;
  const slug = workspaceFolderName(folder).toLowerCase();
  if (slug.length === 0) return false;
  const haystack = worktreePath.toLowerCase();
  const markerAt = haystack.indexOf(TRAYCER_WORKTREES_MARKER);
  if (markerAt < 0) return false;
  const repoSeg = haystack
    .slice(markerAt + TRAYCER_WORKTREES_MARKER.length)
    .split("/")[0];
  return repoSeg.endsWith(`__${slug}`);
}

function pathIsInsideFolder(path: string, folder: string): boolean {
  if (path === folder) return true;
  return path.startsWith(`${folder}/`);
}

function normalizePathSeparators(path: string): string {
  const withSlashes = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (isCaseInsensitiveWindowsPath(withSlashes)) {
    return withSlashes.toLowerCase();
  }
  return withSlashes;
}

function isCaseInsensitiveWindowsPath(path: string): boolean {
  return isWindowsDrivePath(path) || isWindowsUncPath(path);
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(path);
}

function isWindowsUncPath(path: string): boolean {
  return /^\/\/[^/]+/.test(path);
}
