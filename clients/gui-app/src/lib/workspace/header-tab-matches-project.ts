import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { SplitSide, StripItem } from "@/stores/tabs/layout";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";
import { historyItemMatchesProject } from "@/lib/workspace/history-item-matches-project";

export type ProjectScopedHeaderTab =
  | { readonly kind: "epic"; readonly epicId: string }
  | { readonly kind: "draft" }
  | { readonly kind: "history" }
  | { readonly kind: "settings" };

export type EpicWorkspaceHint = Pick<
  HistoryItem,
  "worktreePaths" | "linkedWorkspaces"
> & {
  readonly primaryPath?: string | null;
};

const TRAYCER_WORKTREES_MARKER = "/.traycer/worktrees/";

function hintPrimaryPath(hint: EpicWorkspaceHint | null): string | null {
  if (hint === null) return null;
  if (typeof hint.primaryPath === "string" && hint.primaryPath.length > 0) {
    return hint.primaryPath;
  }
  const linked = hint.linkedWorkspaces[0]?.workspacePath;
  if (linked !== undefined && linked.length > 0) return linked;
  const worktree = hint.worktreePaths[0];
  if (worktree !== undefined && worktree.length > 0) return worktree;
  return null;
}

export function resolveEpicWorkspaceHint(input: {
  readonly live: EpicWorkspaceHint | null;
  readonly stamped: EpicWorkspaceHint | null;
}): EpicWorkspaceHint | null {
  if (hintPrimaryPath(input.live) !== null) return input.live;
  if (hintPrimaryPath(input.stamped) !== null) return input.stamped;
  return null;
}

export function stampedWorkspaceHintForEpic(
  tabsById: Readonly<
    Record<
      string,
      | {
          readonly epicId: string;
          readonly projectWorkspace?: EpicWorkspaceHint | null;
        }
      | undefined
    >
  >,
  epicId: string,
): EpicWorkspaceHint | null {
  for (const tab of Object.values(tabsById)) {
    if (tab === undefined || tab.epicId !== epicId) continue;
    const stamp = tab.projectWorkspace;
    if (stamp === undefined || stamp === null) continue;
    if (hintPrimaryPath(stamp) === null) continue;
    return stamp;
  }
  return null;
}

export function workspaceHintFromHistoryItem(
  item: Pick<HistoryItem, "linkedWorkspaces" | "worktreePaths">,
): EpicWorkspaceHint {
  return {
    worktreePaths: item.worktreePaths,
    linkedWorkspaces: item.linkedWorkspaces,
    primaryPath:
      item.linkedWorkspaces[0]?.workspacePath ?? item.worktreePaths[0] ?? null,
  };
}

export function workspaceHintFromSnapshotFolders(
  folders: ReadonlyArray<{
    readonly hostId: string;
    readonly workspacePath: string;
  }>,
): EpicWorkspaceHint | null {
  if (folders.length === 0) return null;
  return {
    worktreePaths: [],
    linkedWorkspaces: folders.map((folder) => ({
      hostId: folder.hostId,
      workspacePath: folder.workspacePath,
    })),
    primaryPath: folders[0]?.workspacePath ?? null,
  };
}

function epicOwnedByProfile(
  epicId: string,
  hint: EpicWorkspaceHint | null,
  profile: ProjectProfile,
): boolean {
  const primary = hintPrimaryPath(hint);
  if (primary === null) return profile.epicIds.includes(epicId);
  return historyItemMatchesProject(
    {
      epicId: "",
      linkedWorkspaces: primary.includes(TRAYCER_WORKTREES_MARKER)
        ? []
        : [{ hostId: "", workspacePath: primary }],
      worktreePaths: primary.includes(TRAYCER_WORKTREES_MARKER) ? [primary] : [],
    },
    { ...profile, epicIds: [] },
  );
}

export function headerTabMatchesProject(
  tab: ProjectScopedHeaderTab,
  profile: ProjectProfile | null,
  hint: EpicWorkspaceHint | null,
): boolean {
  if (profile === null) return true;
  if (tab.kind !== "epic") return true;
  return epicOwnedByProfile(tab.epicId, hint, profile);
}

export function resolveOwningProjectProfile(
  profiles: ReadonlyArray<ProjectProfile>,
  epicId: string,
  hint: EpicWorkspaceHint | null,
): ProjectProfile | null {
  const owners = profiles.filter((profile) =>
    epicOwnedByProfile(epicId, hint, profile),
  );
  return owners.length === 1 ? owners[0] : null;
}

export function headerTabProjectBadge(
  activeProfile: ProjectProfile | null,
  owner: ProjectProfile | null,
): { readonly color: ProjectProfile["color"]; readonly name: string } | null {
  if (activeProfile !== null) return null;
  if (owner === null) return null;
  return { color: owner.color, name: owner.name };
}

export function filterHeaderStripItemIdsForProject(input: {
  readonly itemIds: ReadonlyArray<string>;
  readonly items: ReadonlyArray<StripItem>;
  readonly profile: ProjectProfile | null;
  readonly epicIdForTabId: (tabId: string) => string | null;
  readonly workspaceHintForEpic: (epicId: string) => EpicWorkspaceHint | null;
}): ReadonlyArray<string> {
  const profile = input.profile;
  if (profile === null) return input.itemIds;
  const byId = new Map(input.items.map((item) => [item.id, item]));
  return input.itemIds.filter((itemId) => {
    const item = byId.get(itemId);
    if (item === undefined) return true;
    return stripItemMatchesProject(
      item,
      profile,
      input.epicIdForTabId,
      input.workspaceHintForEpic,
    );
  });
}

function stripItemMatchesProject(
  item: StripItem,
  profile: ProjectProfile,
  epicIdForTabId: (tabId: string) => string | null,
  workspaceHintForEpic: (epicId: string) => EpicWorkspaceHint | null,
): boolean {
  if (item.kind === "tab") {
    return tabRefMatchesProject(
      item.ref.kind,
      item.ref.id,
      profile,
      epicIdForTabId,
      workspaceHintForEpic,
    );
  }
  return (
    sideMatchesProject(
      item.left,
      profile,
      epicIdForTabId,
      workspaceHintForEpic,
    ) &&
    sideMatchesProject(
      item.right,
      profile,
      epicIdForTabId,
      workspaceHintForEpic,
    )
  );
}

function sideMatchesProject(
  side: SplitSide,
  profile: ProjectProfile,
  epicIdForTabId: (tabId: string) => string | null,
  workspaceHintForEpic: (epicId: string) => EpicWorkspaceHint | null,
): boolean {
  if (side.kind !== "tab") return true;
  return tabRefMatchesProject(
    side.ref.kind,
    side.ref.id,
    profile,
    epicIdForTabId,
    workspaceHintForEpic,
  );
}

function tabRefMatchesProject(
  kind: string,
  tabId: string,
  profile: ProjectProfile,
  epicIdForTabId: (tabId: string) => string | null,
  workspaceHintForEpic: (epicId: string) => EpicWorkspaceHint | null,
): boolean {
  if (kind !== "epic") {
    return headerTabMatchesProject({ kind: scopedKind(kind) }, profile, null);
  }
  const epicId = epicIdForTabId(tabId);
  if (epicId === null) return false;
  return headerTabMatchesProject(
    { kind: "epic", epicId },
    profile,
    workspaceHintForEpic(epicId),
  );
}

function scopedKind(
  kind: string,
): Exclude<ProjectScopedHeaderTab["kind"], "epic"> {
  if (kind === "history") return "history";
  if (kind === "settings") return "settings";
  return "draft";
}

export function headerTabRecordMatchesProject(
  tab: { readonly kind: string; readonly epicId?: string },
  profile: ProjectProfile | null,
  hint: EpicWorkspaceHint | null,
): boolean {
  if (tab.kind === "epic") {
    const epicId = tab.epicId;
    if (epicId === undefined) return false;
    return headerTabMatchesProject({ kind: "epic", epicId }, profile, hint);
  }
  return headerTabMatchesProject({ kind: scopedKind(tab.kind) }, profile, hint);
}
