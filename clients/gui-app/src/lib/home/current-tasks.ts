import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";

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
  readonly firstPageLocalRowsIncomplete: boolean;
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
  readonly firstPagePlaceholder: boolean;
  readonly cloudPagePending: boolean;
  readonly hostId: string | null;
  readonly userId: string | null;
}

export interface CurrentTaskPinScan {
  readonly firstPageDecision: PinScanDecision | null;
  readonly firstPageUnavailable: boolean;
  readonly firstPageLocalRowsIncomplete: boolean;
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
  const settledFirstPage = settledPage(
    input.firstPage,
    input.firstPagePlaceholder,
  );
  const firstPageDecision =
    settledFirstPage === undefined
      ? null
      : pinScanDecision(settledFirstPage, "first", 0);
  const firstPageCursor = continuingCursor(settledFirstPage, firstPageDecision);
  const firstPageUnavailable =
    settledFirstPage?.completeness?.cloudPage === "unavailable";
  const firstPageLocalRowsIncomplete = hasIncompleteLocalRows(settledFirstPage);
  const tailEnabled =
    !input.cloudPagePending &&
    !firstPageUnavailable &&
    input.hostId !== null &&
    input.userId !== null &&
    firstPageCursor !== null;
  return {
    firstPageDecision,
    firstPageUnavailable,
    firstPageLocalRowsIncomplete,
    tailEnabled,
    tailScope: {
      hostId: input.hostId ?? "",
      userId: input.userId ?? "",
      firstPageCursor: firstPageCursor ?? "",
    },
  };
}

function settledPage(
  page: ListTasksResponse | undefined,
  placeholder: boolean,
): ListTasksResponse | undefined {
  return placeholder ? undefined : page;
}

function continuingCursor(
  page: ListTasksResponse | undefined,
  decision: PinScanDecision | null,
): string | null {
  return decision?.shouldContinue === true ? (page?.nextCursor ?? null) : null;
}

function hasIncompleteLocalRows(page: ListTasksResponse | undefined): boolean {
  const localRows = page?.completeness?.localRows;
  return (
    localRows === "truncated" || localRows === "suppressed-unprovable-filter"
  );
}

export function currentTaskPinsStatus(
  input: CurrentTaskPinsStatusInput,
): CurrentTaskPinsStatus {
  const pinsComplete =
    !input.initialLegRefused &&
    !input.cloudPagePending &&
    !input.firstPageUnavailable &&
    !input.firstPageLocalRowsIncomplete &&
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

/**
 * The phone's stand-in for Home's "In progress" group: running tasks moved to
 * the front of an ordinary History feed.
 *
 * Desktop lifts a running task out of the feed by rendering it in
 * `CurrentTasksSection`, which the phone never mounts. Without that group the
 * feed's own order is all a phone has, and agent activity does not touch an
 * epic's `updatedAt` - so the one task the user is watching can sit pages
 * deep. Same semantics as {@link groupCurrentTasks}' `inProgress`, applied to
 * the list instead of beside it.
 *
 * Deduped by `epicId` rather than `id`: the lifted row and the feed's row for
 * one task can be built from different responses (a cloud list page vs. an
 * `epic.getTaskContexts` backfill), so only the epic identifies them as the
 * same task.
 *
 * Returns `items` itself when nothing is running, so a feed with no in-progress
 * task keeps its array identity and re-renders nothing.
 */
export function withInProgressFirst(
  inProgress: readonly HistoryItem[],
  items: readonly HistoryItem[],
): readonly HistoryItem[] {
  if (inProgress.length === 0) return items;
  const lifted = new Set(inProgress.map((item) => item.epicId));
  return [...inProgress, ...items.filter((item) => !lifted.has(item.epicId))];
}
