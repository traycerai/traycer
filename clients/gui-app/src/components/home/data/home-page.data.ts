import type {
  PermissionRole,
  ListTaskLight,
  TaskOwnershipScope,
  TaskWorkspaceIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import { formatDistanceToNow } from "date-fns";
import { displayTitle } from "@/lib/display-title";
import { isEditableRole } from "@/lib/epic-permissions";

export type HistoryRecencyBucket = "today" | "yesterday" | "earlier";
export type HistoryItemTaskType = "epic" | "phase";
export type HistoryMatchMode = "any" | "all";
export type HistoryOwnershipScope = TaskOwnershipScope;
export type HistoryWorkspaceRef = TaskWorkspaceIdentifier;
export type HistorySortOption =
  "recent" | "oldest" | "title-asc" | "title-desc" | "relevance";

export const DEFAULT_SORT: HistorySortOption = "recent";

const BUCKET_ORDER: Record<HistoryRecencyBucket, number> = {
  today: 0,
  yesterday: 1,
  earlier: 2,
};

export interface HistoryItem {
  id: string;
  epicId: string;
  taskType: HistoryItemTaskType;
  title: string;
  // Raw user prompt (empty for phases); render sites derive the display-title
  // fallback from it via `epicDisplayTitle`.
  initialUserPrompt: string;
  updatedAtMs: number;
  updatedLabel: string;
  updatedBucket: HistoryRecencyBucket;
  linkedRepos: ReadonlyArray<string>;
  linkedWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  pullRequestNumbers: ReadonlyArray<string>;
  ownership: HistoryOwnershipScope;
  permissionRole: PermissionRole | null;
  isPinned: boolean;
}

export interface HistoryFilters {
  repoNames: ReadonlyArray<string>;
  repoMatchMode: HistoryMatchMode;
  workspaces: ReadonlyArray<HistoryWorkspaceRef>;
  workspaceMatchMode: HistoryMatchMode;
  ownershipScopes: ReadonlyArray<HistoryOwnershipScope>;
}

export interface HistoryGroup {
  bucket: HistoryRecencyBucket;
  label: string;
  items: ReadonlyArray<HistoryItem>;
}

const HISTORY_GROUP_LABELS: Record<HistoryRecencyBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};

export function buildHistoryItemsFromTasks(
  tasks: ReadonlyArray<ListTaskLight>,
  nowMs: number,
  userId: string | null,
): ReadonlyArray<HistoryItem> {
  return tasks.flatMap((task, index): HistoryItem[] => {
    const epic = task.epic?.light;
    if (epic !== null && epic !== undefined) {
      return [
        buildHistoryItem({
          light: epic,
          taskType: "epic",
          initialUserPrompt: epic.initialUserPrompt,
          task,
          index,
          userId,
          nowMs,
          role: task.epic?.permission?.role ?? null,
          isPinned: task.pinned ?? false,
        }),
      ];
    }

    const phase = task.phase?.light;
    if (phase === null || phase === undefined) {
      return [];
    }

    return [
      buildHistoryItem({
        light: phase,
        taskType: "phase",
        // Phases have no user prompt; epic-only field stays empty.
        initialUserPrompt: "",
        task,
        index,
        userId,
        nowMs,
        role: task.phase?.permission?.role ?? null,
        isPinned: false,
      }),
    ];
  });
}

function buildHistoryItem(args: {
  light: { id: string; title: string; updatedAt: number; createdBy: string };
  taskType: "epic" | "phase";
  initialUserPrompt: string;
  task: ListTaskLight;
  index: number;
  userId: string | null;
  nowMs: number;
  role: PermissionRole | null;
  isPinned: boolean;
}): HistoryItem {
  const {
    light,
    taskType,
    initialUserPrompt,
    task,
    index,
    userId,
    nowMs,
    role,
    isPinned,
  } = args;
  const ownership = light.createdBy === userId ? "mine" : "shared";
  return {
    id: itemId(light.id, taskType, index),
    epicId: light.id,
    taskType,
    // Epics keep the RAW title - it flows into tab-store mutations via
    // `openEpicFromList` -> `resolveTargetTabForEpic`, so the empty-title
    // fallback must be applied at the render site only. Phases render verbatim
    // downstream, so the fallback is baked here (single-sourced via
    // `displayTitle`).
    title:
      taskType === "epic" ? light.title : displayTitle(light.title, "phase"),
    initialUserPrompt,
    updatedAtMs: light.updatedAt,
    updatedLabel: formatDistanceToNow(light.updatedAt, { addSuffix: true }),
    updatedBucket: toHistoryRecencyBucket(light.updatedAt, nowMs),
    linkedRepos: readTaskRepos(task),
    linkedWorkspaces: readTaskWorkspaces(task),
    pullRequestNumbers: [],
    ownership,
    permissionRole: historyPermissionRole(ownership, role),
    isPinned,
  };
}

/**
 * Adds the PR numbers discovered from the task's local worktrees to history
 * items. Worktree activity is deliberately fetched separately from cloud task
 * history, so this stays a pure projection that can update as probes finish.
 */
export function withHistoryItemPullRequestNumbers(
  items: ReadonlyArray<HistoryItem>,
  worktreesByEpicId: ReadonlyMap<string, readonly WorktreeHostEntryV12[]>,
): ReadonlyArray<HistoryItem> {
  return items.map((item) => ({
    ...item,
    pullRequestNumbers: historyPullRequestNumbers(
      worktreesByEpicId.get(item.epicId) ?? [],
    ),
  }));
}

function historyPullRequestNumbers(
  worktrees: readonly WorktreeHostEntryV12[],
): ReadonlyArray<string> {
  return Array.from(
    new Set(
      worktrees
        .flatMap((worktree) => [
          worktree.prNumber,
          ...worktree.submodules.map((submodule) => submodule.prNumber),
        ])
        .filter((prNumber): prNumber is number => prNumber !== null)
        .flatMap((prNumber) => [
          String(prNumber),
          `#${prNumber}`,
          `PR #${prNumber}`,
        ]),
    ),
  );
}

export function canEditHistoryItemTitle(item: HistoryItem): boolean {
  return item.taskType === "epic" && isEditableRole(item.permissionRole);
}

export function canDeleteHistoryItem(item: HistoryItem): boolean {
  return isEditableRole(item.permissionRole);
}

function historyPermissionRole(
  ownership: HistoryOwnershipScope,
  role: PermissionRole | null,
): PermissionRole | null {
  if (ownership === "mine") return "owner";
  return role;
}

export function collectHistoryRepos(
  items: ReadonlyArray<HistoryItem>,
): ReadonlyArray<string> {
  return Array.from(new Set(items.flatMap((item) => item.linkedRepos))).sort(
    (left, right) => left.localeCompare(right),
  );
}

function matchesRepoFilter(
  item: HistoryItem,
  repoNames: ReadonlyArray<string>,
  repoMatchMode: HistoryMatchMode,
): boolean {
  if (repoNames.length === 0) {
    return true;
  }

  if (repoMatchMode === "all") {
    return repoNames.every((repoName) => item.linkedRepos.includes(repoName));
  }

  return repoNames.some((repoName) => item.linkedRepos.includes(repoName));
}

function matchesWorkspaceFilter(
  item: HistoryItem,
  workspaces: ReadonlyArray<HistoryWorkspaceRef>,
  workspaceMatchMode: HistoryMatchMode,
): boolean {
  if (workspaces.length === 0) {
    return true;
  }

  const itemWorkspaceKeys = new Set(item.linkedWorkspaces.map(workspaceKey));
  if (workspaceMatchMode === "all") {
    return workspaces.every((workspace) =>
      itemWorkspaceKeys.has(workspaceKey(workspace)),
    );
  }

  return workspaces.some((workspace) =>
    itemWorkspaceKeys.has(workspaceKey(workspace)),
  );
}

export function filterHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  filters: HistoryFilters,
): ReadonlyArray<HistoryItem> {
  return items.filter((item) => {
    if (
      filters.ownershipScopes.length > 0 &&
      !filters.ownershipScopes.includes(item.ownership)
    ) {
      return false;
    }
    if (!matchesRepoFilter(item, filters.repoNames, filters.repoMatchMode)) {
      return false;
    }
    return matchesWorkspaceFilter(
      item,
      filters.workspaces,
      filters.workspaceMatchMode,
    );
  });
}

export function sortHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  sort: HistorySortOption,
): ReadonlyArray<HistoryItem> {
  switch (sort) {
    case "recent":
      return items
        .slice()
        .sort(
          (left, right) =>
            comparePinnedHistoryItems(left, right) ||
            right.updatedAtMs - left.updatedAtMs ||
            BUCKET_ORDER[left.updatedBucket] -
              BUCKET_ORDER[right.updatedBucket],
        );
    case "oldest":
      return items
        .slice()
        .sort(
          (left, right) =>
            comparePinnedHistoryItems(left, right) ||
            left.updatedAtMs - right.updatedAtMs ||
            BUCKET_ORDER[right.updatedBucket] -
              BUCKET_ORDER[left.updatedBucket],
        );
    case "title-asc":
      return items
        .slice()
        .sort(
          (left, right) =>
            comparePinnedHistoryItems(left, right) ||
            left.title.localeCompare(right.title),
        );
    case "title-desc":
      return items
        .slice()
        .sort(
          (left, right) =>
            comparePinnedHistoryItems(left, right) ||
            right.title.localeCompare(left.title),
        );
    case "relevance":
      return sortHistoryItems(items, "recent");
  }
}

/** Stable pinned-first partition for relevance-ranked search results. */
export function prioritizePinnedHistoryItems(
  items: ReadonlyArray<HistoryItem>,
): ReadonlyArray<HistoryItem> {
  return items
    .slice()
    .sort((left, right) => comparePinnedHistoryItems(left, right));
}

function comparePinnedHistoryItems(
  left: HistoryItem,
  right: HistoryItem,
): number {
  if (left.isPinned === right.isPinned) return 0;
  return left.isPinned ? -1 : 1;
}

export function groupHistoryItems(
  items: ReadonlyArray<HistoryItem>,
): ReadonlyArray<HistoryGroup> {
  const groups = new Map<HistoryRecencyBucket, HistoryItem[]>();

  for (const item of items) {
    const current = groups.get(item.updatedBucket) ?? [];
    current.push(item);
    groups.set(item.updatedBucket, current);
  }

  return (["today", "yesterday", "earlier"] as const).flatMap((bucket) => {
    const items = groups.get(bucket) ?? [];
    return items.length > 0
      ? [{ bucket, label: HISTORY_GROUP_LABELS[bucket], items }]
      : [];
  });
}

function toHistoryRecencyBucket(
  updatedAtMs: number,
  nowMs: number,
): HistoryRecencyBucket {
  const startOfToday = toStartOfDay(nowMs);
  if (updatedAtMs >= startOfToday) {
    return "today";
  }

  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  if (updatedAtMs >= startOfYesterday) {
    return "yesterday";
  }

  return "earlier";
}

function toStartOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function readTaskRepos(task: ListTaskLight): ReadonlyArray<string> {
  const repos = task.epic?.repos ?? task.phase?.repos ?? [];
  return Array.from(
    new Set(
      repos.flatMap((repo) => {
        const identifier = repo.repoIdentifier;
        if (identifier === null) {
          return [];
        }
        if (identifier.owner.length === 0 || identifier.repo.length === 0) {
          return [];
        }
        return [`${identifier.owner}/${identifier.repo}`];
      }),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function readTaskWorkspaces(
  task: ListTaskLight,
): ReadonlyArray<HistoryWorkspaceRef> {
  const workspaces = task.epic?.workspaces ?? task.phase?.workspaces ?? [];
  const unique = new Map<string, HistoryWorkspaceRef>();
  for (const workspace of workspaces) {
    unique.set(workspaceKey(workspace), {
      hostId: workspace.hostId,
      workspacePath: workspace.workspacePath,
    });
  }
  return Array.from(unique.values()).sort((left, right) =>
    workspaceKey(left).localeCompare(workspaceKey(right)),
  );
}

export function workspaceKey(workspace: HistoryWorkspaceRef): string {
  return `${workspace.hostId}\0${workspace.workspacePath}`;
}

export function dedupSortWorkspaces(
  ...groups: ReadonlyArray<ReadonlyArray<HistoryWorkspaceRef>>
): ReadonlyArray<HistoryWorkspaceRef> {
  const unique = new Map<string, HistoryWorkspaceRef>();
  for (const group of groups) {
    for (const workspace of group) {
      unique.set(workspaceKey(workspace), workspace);
    }
  }
  return Array.from(unique.values()).sort((left, right) =>
    workspaceKey(left).localeCompare(workspaceKey(right)),
  );
}

function itemId(
  taskId: string,
  taskType: HistoryItemTaskType,
  index: number,
): string {
  if (taskType === "epic") {
    return taskId.length > 0 ? taskId : `epic-${index}`;
  }
  return taskId.length > 0 ? `${taskType}-${taskId}` : `${taskType}-${index}`;
}
