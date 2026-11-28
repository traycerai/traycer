import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  hasOrganizationFilters,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query/query";
import {
  composeHistoryPage,
  type HistoryHostContribution,
} from "@/lib/history-composition/compose-history-page";
import type { HistoryHostContributionState } from "@/lib/history-composition/history-local-contribution";
import {
  historyPageFromAddress,
  type HistoryListedPage,
} from "@/lib/history-composition/history-row-peer";

const ABSENT_HISTORY_CONTRIBUTION: HistoryHostContribution = { kind: "absent" };

export function projectHistoryPage(
  page: ListTasksResponse,
  input: {
    readonly hostId: string;
    readonly request: ListCloudTasksRequest;
    readonly contribution: HistoryHostContributionState | undefined;
    readonly contributingPeerId: string | null;
    readonly cursorPage: boolean;
  },
): HistoryListedPage {
  const listed = historyPageFromAddress(page, input.hostId);
  if (input.hostId !== POOL_HOST_ID) return listed;
  const { contribution, cursorPage, request } = input;
  const firstPagePlacement = hasOrganizationFilters(request.filters)
    ? "unprovable-filter"
    : "admit";
  return composeHistoryPage({
    page: listed,
    contributingPeerId: input.contributingPeerId,
    contribution:
      contribution === undefined || contribution.kind === "pending"
        ? ABSENT_HISTORY_CONTRIBUTION
        : contribution,
    sort: request.sort,
    query: request.filters?.query,
    placement: cursorPage ? "cursor-page" : firstPagePlacement,
  });
}
