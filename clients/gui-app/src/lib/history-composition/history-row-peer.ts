import type {
  EpicListHome,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

type HistoryListedTask = ListTaskLight & {
  readonly listedByPeerId?: string;
};

export interface HistoryRowEvidence {
  readonly home: EpicListHome | undefined;
  readonly listedByPeerId: string | undefined;
}

export function withHistoryRowPeer(
  row: ListTaskLight,
  peerId: string | null | undefined,
): HistoryListedTask {
  if (peerId === null || peerId === undefined) return row;
  return { ...row, listedByPeerId: peerId };
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
  if (listedByPeerId === undefined) return null;
  return listedByPeerId === pagePeerId || listedByPeerId === servingPeerId
    ? listedByPeerId
    : null;
}
