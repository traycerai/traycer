import type { QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  listTasksRequestSchema,
  type ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";
import { servingPeerHostIdOf } from "@/lib/host/serving-decision";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import {
  historyPageFromAddress,
  historyRowEvidence,
  historyRowPeerId,
  type HistoryListedPage,
  type HistoryRowEvidence,
} from "@/lib/history-composition/history-row-peer";
import {
  LIST_CLOUD_TASKS_REQUEST,
  readHistoryPagePeerId,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query/query";
import { cloudEpicTasksQueryKeyMatchesScope } from "@/lib/cloud-epic-tasks-query/cache";
import {
  cloudEpicTasksPageIdentity,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import { historyContribution } from "@/lib/history-composition/history-local-contribution";
import { projectHistoryPage } from "@/lib/history-composition/history-page-projection";
import {
  historyReplicaAddress,
  historyReplicaService,
} from "@/lib/view-replica/history-replica";
import { viewReplicaStore } from "@/lib/view-replica/view-replica-store";

type TitleBinding = Pick<HostRuntimeBinding<HostRpcRegistry>, "hostClient">;

export function resolveHistoryTitleRequester(
  binding: TitleBinding | null,
  scope: { readonly listPeerId: string | null; readonly peerId: string | null },
  row: HistoryRowEvidence,
) {
  const peerId = historyRowPeerId(scope.listPeerId, scope.peerId, row, false);
  return resolveTitleRequester(binding, peerId);
}

function resolveTitleRequester(
  binding: TitleBinding | null,
  peerId: string | null,
) {
  if (peerId === null) return null;
  const requester = resolveNamedHostClient(binding, peerId);
  return requester?.getActiveHostId() === peerId ? requester : null;
}

/** A tab without a session can use its published host or a row the account
 * already holds. The serving decision filters the evidence but never names
 * a write destination on its own. */
export function resolveTaskTabTitleRequester(input: {
  readonly binding: TitleBinding | null;
  readonly queryClient: QueryClient;
  readonly epicId: string;
  readonly tabHostId: string | null;
  readonly localHome: boolean;
}) {
  const { binding, queryClient, epicId, tabHostId } = input;
  if (binding === null) return null;
  if (tabHostId !== null) return resolveTitleRequester(binding, tabHostId);
  const auth = useAuthStore.getState();
  const userId = binding.hostClient.getRequestContextUserId();
  if (
    userId === null ||
    !admitsLocalPlane(auth.status) ||
    auth.contextMetadata?.userId !== userId
  ) {
    return null;
  }
  const servingPeerId = servingPeerHostIdOf(
    useSelectionAuthorityStore.getState().servingPeer,
  );
  const cached = readCachedTitleRow({
    binding,
    queryClient,
    epicId,
    servingPeerId,
    userId,
    localHome: input.localHome,
  });
  if (cached !== undefined) return cached;
  const listPeerId = readHistoryPagePeerId(
    binding.hostClient,
    servingPeerId,
    LIST_CLOUD_TASKS_REQUEST,
  );
  if (listPeerId === null) return null;
  const row = readReplicaTitleRow(
    { listPeerId, servingPeerId, userId },
    epicId,
  );
  return row === null
    ? null
    : resolveHistoryTitleRequester(
        binding,
        { listPeerId, peerId: servingPeerId },
        input.localHome ? { ...row, home: "local" } : row,
      );
}

interface CachedTitleScope {
  readonly listPeerId: string;
  readonly servingPeerId: string | null;
  readonly userId: string;
}

function readCachedTitleRow(input: {
  readonly binding: TitleBinding;
  readonly queryClient: QueryClient;
  readonly epicId: string;
  readonly servingPeerId: string | null;
  readonly userId: string;
  readonly localHome: boolean;
}) {
  const { binding, queryClient, epicId, servingPeerId, userId, localHome } =
    input;
  const tails = useCloudEpicTasksPagesStore.getState().pagesByIdentity;
  const pages = queryClient.getQueriesData<ListTasksResponse>({
    predicate: (query) =>
      cloudEpicTasksQueryKeyMatchesScope(query.queryKey, {
        hostId: null,
        userId,
      }),
  });

  let matched: HostClient<HostRpcRegistry> | null | undefined;
  for (const [key, page] of pages) {
    if (page === undefined || typeof key[1] !== "string") continue;
    const listPeerId = key[1];
    const parsed = listTasksRequestSchema.safeParse(key[3]);
    if (!parsed.success || parsed.data.cursor !== undefined) continue;
    const request = parsed.data;
    if (
      readHistoryPagePeerId(binding.hostClient, servingPeerId, request) !==
      listPeerId
    )
      continue;

    const identity = cloudEpicTasksPageIdentity(listPeerId, userId, request);
    for (const storedPage of [page, ...(tails[identity] ?? [])]) {
      const row = titleRowFromPage(
        storedPage,
        { listPeerId, servingPeerId, userId },
        {
          epicId,
          request,
          cursorPage: storedPage !== page,
        },
      );
      if (row === null) continue;
      const requester = resolveHistoryTitleRequester(
        binding,
        { listPeerId, peerId: servingPeerId },
        localHome ? { ...row, home: "local" } : row,
      );
      // Conflicting row addresses cannot settle a write destination.
      if (
        matched !== undefined &&
        matched?.getActiveHostId() !== requester?.getActiveHostId()
      ) {
        return null;
      }
      matched = requester;
    }
  }
  return matched;
}

function titleRowFromPage(
  response: ListTasksResponse,
  scope: CachedTitleScope,
  input: {
    readonly epicId: string;
    readonly request: ListCloudTasksRequest;
    readonly cursorPage: boolean;
  },
): HistoryRowEvidence | null {
  const { listPeerId, servingPeerId, userId } = scope;
  const { epicId, request, cursorPage } = input;
  const contribution =
    listPeerId === POOL_HOST_ID &&
    servingPeerId !== null &&
    servingPeerId !== POOL_HOST_ID
      ? historyContribution(userId, servingPeerId, request.filters)
      : undefined;
  const page = projectHistoryPage(response, {
    hostId: listPeerId,
    request,
    cursorPage,
    contribution,
    contributingPeerId: servingPeerId,
  });
  return titleRowEvidence(page, epicId);
}

function titleRowEvidence(
  page: HistoryListedPage,
  epicId: string,
): HistoryRowEvidence | null {
  const row = page.tasks.find((task) => task.epic?.light?.id === epicId);
  return row === undefined
    ? null
    : historyRowEvidence({
        home: row.home,
        listedByPeerId: row.listedByPeerId,
      });
}

function readReplicaTitleRow(
  scope: CachedTitleScope,
  epicId: string,
): HistoryRowEvidence | null {
  const address = historyReplicaAddress(
    scope.userId,
    scope.listPeerId,
    LIST_CLOUD_TASKS_REQUEST,
  );
  if (address === null) return null;
  const hit = viewReplicaStore.read(historyReplicaService, address);
  if (hit === null) return null;
  const page = historyReplicaService.paintableFrom(
    historyReplicaService.admitFirstPaint(hit.page, address),
  );
  return page === null
    ? null
    : titleRowEvidence(historyPageFromAddress(page, scope.listPeerId), epicId);
}
