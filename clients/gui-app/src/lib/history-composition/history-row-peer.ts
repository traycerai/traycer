import type {
  EpicListHome,
  ListTaskLight,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

export type HistoryListedTask = ListTaskLight & {
  readonly listedByPeerId: string;
};

export type HistoryListedPage = Omit<ListTasksResponse, "tasks"> & {
  readonly tasks: HistoryListedTask[];
};

export interface HistoryRowEvidence {
  readonly home: EpicListHome | undefined;
  readonly listedByPeerId: string;
}

export interface HistoryActionScope {
  readonly userId: string | null;
  readonly peerId: string | null;
  readonly listPeerId: string | null;
}

export function historyActionScopeMatches(
  captured: HistoryActionScope,
  current: HistoryActionScope,
): boolean {
  return (
    captured.peerId !== null &&
    captured.peerId === current.peerId &&
    captured.listPeerId !== null &&
    captured.listPeerId === current.listPeerId &&
    captured.userId === current.userId
  );
}

export function withHistoryRowPeer(
  row: ListTaskLight,
  peerId: string,
): HistoryListedTask {
  return { ...row, listedByPeerId: peerId };
}

/** Wire and cached pages are read under an address. A composed row may
 * already carry the different peer that contributed it. */
export function historyPageFromAddress(
  page: ListTasksResponse,
  peerId: string,
): HistoryListedPage {
  return {
    ...page,
    tasks: page.tasks.map((row) =>
      withHistoryRowPeer(
        row,
        "listedByPeerId" in row && typeof row.listedByPeerId === "string"
          ? row.listedByPeerId
          : peerId,
      ),
    ),
  };
}

/** The cloud page and its local contribution can be served by different peers. */
export function historyRowPeerId(
  pagePeerId: string | null,
  servingPeerId: string | null,
  row: HistoryRowEvidence | undefined,
  poolTookOver: boolean,
): string | null {
  if (row === undefined) return null;
  const { listedByPeerId } = row;
  // The pool's page is already cloud-only, even if a task-context read
  // described a local copy. Only a computer's rows need home evidence on failover.
  if (pagePeerId === POOL_HOST_ID && listedByPeerId === POOL_HOST_ID)
    return POOL_HOST_ID;
  if (poolTookOver) return row.home === "cloud" ? POOL_HOST_ID : null;
  return listedByPeerId === pagePeerId || listedByPeerId === servingPeerId
    ? listedByPeerId
    : null;
}
