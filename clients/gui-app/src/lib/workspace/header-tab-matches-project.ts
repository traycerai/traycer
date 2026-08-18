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
>;

export function headerTabMatchesProject(
  tab: ProjectScopedHeaderTab,
  profile: ProjectProfile | null,
  hint: EpicWorkspaceHint | null,
): boolean {
  if (profile === null) return true;
  if (tab.kind !== "epic") return true;
  return historyItemMatchesProject(
    {
      epicId: tab.epicId,
      worktreePaths: hint?.worktreePaths ?? [],
      linkedWorkspaces: hint?.linkedWorkspaces ?? [],
    },
    profile,
  );
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
