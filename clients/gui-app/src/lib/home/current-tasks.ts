import type { HistoryItem } from "@/components/home/data/home-page.data";
import type {
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";

export const PIN_TAIL_PAGE_CAP = 10;

export interface CurrentTaskGroups {
  readonly inProgress: HistoryItem[];
  readonly pinned: HistoryItem[];
  readonly open: HistoryItem[];
}

export interface PinScanDecision {
  readonly shouldContinue: boolean;
  readonly pinsComplete: boolean;
}

export interface CurrentTaskPinsStatusInput {
  readonly initialLegRefused: boolean;
  readonly cloudPagePending: boolean;
  readonly firstPagePending: boolean;
  readonly firstPageUnavailable: boolean;
  readonly firstPageDecision: PinScanDecision | null;
  readonly tailEnabled: boolean;
  readonly tailPending: boolean;
  readonly tailPinsComplete: boolean;
}

export interface CurrentTaskPinsStatus {
  readonly pinsComplete: boolean;
  readonly isPending: boolean;
}

export interface CurrentTaskPinScanInput {
  readonly firstPage: ListTasksResponse | undefined;
  readonly cloudPagePending: boolean;
  readonly hostId: string | null;
  readonly userId: string | null;
}

export interface CurrentTaskPinScan {
  readonly firstPageDecision: PinScanDecision | null;
  readonly firstPageUnavailable: boolean;
  readonly tailEnabled: boolean;
  readonly tailScope: {
    readonly hostId: string;
    readonly userId: string;
    readonly firstPageCursor: string;
  };
}

export function currentTaskPinScan(
  input: CurrentTaskPinScanInput,
): CurrentTaskPinScan {
  const firstPageDecision =
    input.firstPage === undefined
      ? null
      : pinScanDecision(input.firstPage, "first", 0);
  const firstPageCursor =
    firstPageDecision?.shouldContinue === true
      ? (input.firstPage?.nextCursor ?? null)
      : null;
  const firstPageUnavailable =
    input.firstPage?.completeness?.cloudPage === "unavailable";
  const tailEnabled =
    !input.cloudPagePending &&
    !firstPageUnavailable &&
    input.hostId !== null &&
    input.userId !== null &&
    firstPageCursor !== null;
  return {
    firstPageDecision,
    firstPageUnavailable,
    tailEnabled,
    tailScope: {
      hostId: input.hostId ?? "",
      userId: input.userId ?? "",
      firstPageCursor: firstPageCursor ?? "",
    },
  };
}

export function currentTaskPinsStatus(
  input: CurrentTaskPinsStatusInput,
): CurrentTaskPinsStatus {
  const pinsComplete =
    !input.initialLegRefused &&
    !input.cloudPagePending &&
    !input.firstPageUnavailable &&
    input.firstPageDecision !== null &&
    (input.firstPageDecision.pinsComplete ||
      (input.tailEnabled && input.tailPinsComplete));
  const isPending =
    input.cloudPagePending ||
    (!input.initialLegRefused && input.firstPagePending) ||
    (input.tailEnabled && input.tailPending);
  return { pinsComplete, isPending };
}

export function pinScanDecision(
  page: ListTasksResponse,
  pageKind: "first" | "cursor",
  cursorPagesFetched: number,
): PinScanDecision {
  const reachedUnpinned = page.tasks.some((task) =>
    pageKind === "first"
      ? task.home === undefined && !task.pinned
      : !task.pinned,
  );
  if (reachedUnpinned || !page.hasMore) {
    return { shouldContinue: false, pinsComplete: true };
  }
  if (
    cursorPagesFetched >= PIN_TAIL_PAGE_CAP ||
    page.nextCursor === undefined
  ) {
    return { shouldContinue: false, pinsComplete: false };
  }
  return { shouldContinue: true, pinsComplete: false };
}

export function pinnedTasks(tasks: readonly ListTaskLight[]): ListTaskLight[] {
  return tasks.filter((task) => task.pinned === true);
}

export function groupCurrentTasks(
  items: readonly HistoryItem[],
  workingEpicIds: ReadonlySet<string>,
  openEpicIds: readonly string[],
): CurrentTaskGroups {
  const inProgress = items
    .filter((item) => workingEpicIds.has(item.epicId))
    .sort(byUpdatedAtDescending);
  const claimed = new Set(inProgress.map((item) => item.id));
  const pinned = items
    .filter((item) => item.isPinned && !claimed.has(item.id))
    .sort(byUpdatedAtDescending);
  for (const item of pinned) claimed.add(item.id);
  const byEpicId = new Map(
    items
      .filter((item) => !claimed.has(item.id))
      .map((item) => [item.epicId, item] as const),
  );
  const open = openEpicIds.flatMap((epicId) => {
    const item = byEpicId.get(epicId);
    if (item === undefined) return [];
    byEpicId.delete(epicId);
    return [item];
  });
  return { inProgress, pinned, open };
}

function byUpdatedAtDescending(left: HistoryItem, right: HistoryItem): number {
  return right.updatedAtMs - left.updatedAtMs;
}
