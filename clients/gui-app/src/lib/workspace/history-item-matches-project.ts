import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";

/**
 * An existing chat belongs to a project when it was claimed, or when one of
 * its worktrees is that project's folder (or a Traycer worktree of it).
 * Fan-out chats still match the project they actually touched.
 */
export function historyItemMatchesProject(
  item: Pick<HistoryItem, "epicId" | "worktreePaths">,
  profile: ProjectProfile,
): boolean {
  if (profile.epicIds.includes(item.epicId)) return true;
  if (profile.folderPaths.length === 0) return false;
  return item.worktreePaths.some((worktreePath) =>
    profile.folderPaths.some((folder) =>
      worktreeTouchesProjectFolder(worktreePath, folder),
    ),
  );
}

export function filterHistoryItemsForProject<
  T extends Pick<HistoryItem, "epicId" | "worktreePaths">,
>(
  items: ReadonlyArray<T>,
  profile: ProjectProfile | null,
): ReadonlyArray<T> {
  if (profile === null) return items;
  return items.filter((item) => historyItemMatchesProject(item, profile));
}

function worktreeTouchesProjectFolder(
  worktreePath: string,
  folder: string,
): boolean {
  if (pathIsInsideFolder(worktreePath, folder)) return true;
  const name = workspaceFolderName(folder).toLowerCase();
  if (name.length === 0) return false;
  const haystack = worktreePath.toLowerCase();
  return (
    haystack.includes(`__${name}/`) ||
    haystack.includes(`/${name}/`) ||
    haystack.endsWith(`/${name}`)
  );
}

function pathIsInsideFolder(path: string, folder: string): boolean {
  if (path === folder) return true;
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  return path.startsWith(prefix);
}
