import type { LocalHistoryReadResponse } from "@traycer/protocol/host/epic/local-history";
import type {
  ListTaskLight,
  ListTasksCompleteness,
  ListTasksResponse,
  ListTasksSort,
  PermissionDto,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  defineComposedView,
  intersectRole,
} from "@/lib/view-composition/composed-view";

/**
 * History as the app composes it: the server pool's page, with what only the
 * person's host knows. Both contributors are registered bridges, so their
 * rows arrive as this client's canonical DTOs whatever minor each peer runs.
 */
export const HISTORY_COMPOSED_VIEW = defineComposedView("history", [
  { id: "pool-page", kind: "unary", method: "epic.listTasks" },
  { id: "host-local", kind: "unary", method: "epic.localHistory.read" },
]);

/**
 * What the host contributes to one page.
 *
 * - `contributed` - a complete contribution: its rows and tombstones are the
 *   host's truth for this request.
 * - `absent` - no host can contribute: there is none, it refused the method,
 *   it could not be reached, or its local store cannot be read. The page is
 *   then the pool's alone and SAYS so (`localRows: "truncated"`), since rows
 *   and deletions only that host holds may be missing from it.
 *
 * A contribution that may still complete is neither: no page is composed
 * from it, and a cached page waits (see `history-local-contribution`).
 */
export type HistoryHostContribution =
  | {
      readonly kind: "contributed";
      readonly read: LocalHistoryReadResponse;
    }
  | { readonly kind: "absent" };

/**
 * Whether the host's positive rows belong on this page. Tombstones apply
 * whatever this says.
 *
 * - `admit` - the first page of a listing the host answered its filters for.
 * - `cursor-page` - a later page: local rows sit outside cursor paging.
 * - `unprovable-filter` - a first page filtered by something only the server
 *   can judge (labels, groups), so no local row can be shown as matching it.
 */
export type HistoryLocalRowsPlacement =
  | "admit"
  | "cursor-page"
  | "unprovable-filter";

export interface ComposeHistoryPageInput {
  readonly page: ListTasksResponse;
  readonly contribution: HistoryHostContribution;
  readonly sort: ListTasksSort | undefined;
  readonly query: string | undefined;
  readonly placement: HistoryLocalRowsPlacement;
}

/**
 * The composition rules, as the host's own History arm applied them when it
 * merged its local rows into the cloud page (`epic-list-tasks-resolver.ts`):
 *
 * - a tombstone removes its id from every page, cursor pages included;
 * - a LOCAL HOME wins its id over the pool's row (its home is the routing
 *   truth while the cloud copy may still be uploading), shown with the
 *   intersection of the two rows' roles;
 * - a PRESERVED ORPHAN only fills a gap: a pool row for the same id stands;
 * - local rows join only a first page whose filters the host could judge,
 *   and sit outside cursor paging and totals: `hasMore` and
 *   `nextCursor` stay the pool's;
 * - the completeness statement describes the composed page, and a page the
 *   host could not contribute to states reduced coverage rather than
 *   silently shrinking.
 */
export function composeHistoryPage(
  input: ComposeHistoryPageInput,
): ListTasksResponse {
  const { page, contribution } = input;
  const completeness = page.completeness ?? SETTLED_SERVER_PAGE;
  if (contribution.kind === "absent") {
    return {
      ...page,
      completeness: {
        ...completeness,
        facets: "partial",
        localRows: "truncated",
      },
    };
  }
  const read = contribution.read;
  const tombstones = new Set(read.tombstonedEpicIds);
  const poolRows = page.tasks.filter((task) => {
    const epicId = epicIdOf(task);
    return epicId === null || !tombstones.has(epicId);
  });
  const removedPoolRows = poolRows.length !== page.tasks.length;
  const admitted = input.placement === "admit";
  const localHomeRows = admitted ? read.localHomeRows : [];
  const preservedRows = admitted ? read.preservedRows : [];
  const poolRowsById = new Map<string, ListTaskLight>();
  for (const task of poolRows) {
    const epicId = epicIdOf(task);
    if (epicId !== null) poolRowsById.set(epicId, task);
  }
  const localHomeIds = new Set<string>();
  const composedLocalHomes = localHomeRows.map((row) => {
    const epicId = epicIdOf(row);
    if (epicId === null) return row;
    localHomeIds.add(epicId);
    const poolRow = poolRowsById.get(epicId);
    return poolRow === undefined ? row : withIntersectedRole(row, poolRow);
  });
  const poolWithoutLocalHomes = poolRows.filter((task) => {
    const epicId = epicIdOf(task);
    return epicId === null || !localHomeIds.has(epicId);
  });
  const gapFillers = preservedRows.filter((row) => {
    const epicId = epicIdOf(row);
    return epicId !== null && !poolRowsById.has(epicId);
  });
  const injected = composedLocalHomes.length + gapFillers.length > 0;
  const tasks = injected
    ? orderComposedRows(
        [...composedLocalHomes, ...poolWithoutLocalHomes, ...gapFillers],
        input.sort,
        input.query,
      )
    : poolWithoutLocalHomes;
  return {
    ...page,
    tasks,
    completeness: {
      cloudPage: completeness.cloudPage,
      facets:
        completeness.facets === "server" && !injected && !removedPoolRows
          ? "server"
          : "partial",
      localRows: localRowsStatement(input.placement, read),
      sort: injected ? "loaded-union" : completeness.sort,
    },
  };
}

/**
 * The page when the pool did not answer: what the host contributed, stated as
 * a page whose cloud half is missing. `null` when the host gave no complete
 * answer. An empty page is the caller's to judge: a local arm is an alternate
 * answer, never a conversion of a pool failure into an empty success.
 */
export function composeHistoryPageWithoutPool(
  input: Omit<ComposeHistoryPageInput, "page">,
): ListTasksResponse | null {
  if (input.contribution.kind === "absent" || input.placement !== "admit") {
    return null;
  }
  const read = input.contribution.read;
  const rows = [...read.localHomeRows, ...read.preservedRows];
  return {
    tasks: orderComposedRows(rows, input.sort, input.query),
    hasMore: false,
    completeness: {
      cloudPage: "unavailable",
      facets: "partial",
      localRows: read.localRows,
      sort: "loaded-union",
    },
  };
}

function localRowsStatement(
  placement: HistoryLocalRowsPlacement,
  read: LocalHistoryReadResponse,
): ListTasksCompleteness["localRows"] {
  switch (placement) {
    case "admit":
      return read.localRows;
    case "cursor-page":
      return "none";
    case "unprovable-filter":
      return "suppressed-unprovable-filter";
  }
}

/**
 * One host's complete answer on its own, as a page: the rows only that host
 * holds, for readers that ask a SPECIFIC host what it holds locally (the tab
 * reconciler's exemption, the local pin reading). Its `localRows` says what
 * the host claims about them.
 */
export function hostLocalHistoryPage(
  read: LocalHistoryReadResponse,
): ListTasksResponse {
  return {
    tasks: [...read.localHomeRows, ...read.preservedRows],
    hasMore: false,
    completeness: {
      cloudPage: "unavailable",
      facets: "partial",
      localRows: read.localRows,
      sort: "loaded-union",
    },
  };
}

/**
 * Whether the listing states reduced coverage: rows that may belong on it are
 * missing for a reason the person cannot see - the host could not add the
 * tasks only it holds, a filter is one those tasks cannot be judged against,
 * or the serving tier did not answer (the host's rows alone, or a cached page
 * standing in for a failed request). The list says so instead of silently
 * shrinking.
 */
export function historyCoverageIsReduced(
  completeness: ListTasksCompleteness | null,
): boolean {
  return (
    completeness?.cloudPage === "unavailable" ||
    completeness?.localRows === "truncated" ||
    completeness?.localRows === "suppressed-unprovable-filter"
  );
}

const SETTLED_SERVER_PAGE: ListTasksCompleteness = {
  cloudPage: "settled",
  facets: "server",
  localRows: "none",
  sort: "server",
};

function withIntersectedRole(
  local: ListTaskLight,
  pool: ListTaskLight,
): ListTaskLight {
  const localPermission = local.epic?.permission ?? null;
  const poolPermission = pool.epic?.permission ?? null;
  if (
    local.epic === null ||
    local.epic === undefined ||
    localPermission === null ||
    poolPermission === null
  ) {
    return local;
  }
  const role = intersectRole(localPermission.role, poolPermission.role);
  if (role === localPermission.role) return local;
  const permission: PermissionDto = { ...localPermission, role };
  return { ...local, epic: { ...local.epic, permission } };
}

/**
 * Recent order over the composed rows, exactly as the host ordered its merged
 * page: pinned first, then the per-viewer activity key, then id. Any other
 * sort keeps the rows where the composition put them - the order is then
 * honest about the rows present and is not a global ranking, which the
 * completeness statement's `sort: "loaded-union"` says.
 */
function orderComposedRows(
  rows: readonly ListTaskLight[],
  sort: ListTasksSort | undefined,
  query: string | undefined,
): ListTaskLight[] {
  const recent =
    sort === "recent" ||
    ((sort === undefined || sort === "relevance") &&
      (query === undefined || query.trim().length === 0));
  if (!recent) return [...rows];
  return rows.toSorted(compareRecent);
}

function compareRecent(left: ListTaskLight, right: ListTaskLight): number {
  const leftPinned = left.pinned === true;
  const rightPinned = right.pinned === true;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const leftAt = activityAt(left);
  const rightAt = activityAt(right);
  if (leftAt !== rightAt) return rightAt - leftAt;
  // Code-unit order, descending, as the host's merged page broke ties.
  const leftId = rowId(left);
  const rightId = rowId(right);
  if (leftId === rightId) return 0;
  return leftId < rightId ? 1 : -1;
}

function rowId(row: ListTaskLight): string {
  return row.epic?.light?.id ?? row.phase?.light?.id ?? "";
}

function activityAt(row: ListTaskLight): number {
  return (
    row.recentAt ??
    row.epic?.light?.updatedAt ??
    row.phase?.light?.updatedAt ??
    0
  );
}

function epicIdOf(task: ListTaskLight): string | null {
  const epicId = task.epic?.light?.id;
  return typeof epicId === "string" && epicId.length > 0 ? epicId : null;
}
