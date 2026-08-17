import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

const TRAYCER_WORKTREES_MARKER = "/.traycer/worktrees/";

/**
 * An existing chat belongs to a project when it was claimed, when one of
 * its originating workspace paths is that project's folder, or when a
 * leftover Traycer worktree was created from that folder's repo slug.
 */
export function historyItemMatchesProject(
  item: Pick<HistoryItem, "epicId" | "worktreePaths" | "linkedWorkspaces">,
  profile: ProjectProfile,
): boolean {
  if (profile.epicIds.includes(item.epicId)) return true;
  if (profile.folderPaths.length === 0) return false;
  const folders = profile.folderPaths.map(normalizePathSeparators);
  if (
    item.linkedWorkspaces.some((workspace) =>
      folders.some((folder) =>
        pathIsInsideFolder(
          normalizePathSeparators(workspace.workspacePath),
          folder,
        ),
      ),
    )
  ) {
    return true;
  }
  // When the cloud row already named its folders, do not also guess from
  // worktree basenames — two checkouts named Titanos would collide.
  if (item.linkedWorkspaces.length > 0) return false;
  return item.worktreePaths.some((worktreePath) =>
    folders.some((folder) =>
      isDocumentedTraycerWorktreeOfFolder(
        normalizePathSeparators(worktreePath),
        folder,
      ),
    ),
  );
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
  if (isWindowsDrivePath(withSlashes)) {
    return withSlashes.toLowerCase();
  }
  return withSlashes;
}

function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(path);
}
