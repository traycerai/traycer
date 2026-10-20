import {
  listTasksResponseSchema,
  type ListTaskLight,
  type ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  clientUnaryCanonicalVersion,
  viewReplicaRequestScope,
  type ViewReplicaAddress,
} from "@traycer-clients/shared/view-replica/identity";
import {
  ACCOUNT_ROW_SCOPE,
  organizationRowScope,
  type ViewReplicaRowScope,
} from "@traycer-clients/shared/view-replica/row-scope";
import { ViewReplicaService } from "@traycer-clients/shared/view-replica/service";
import type { ListCloudTasksRequest } from "@/lib/cloud-epic-tasks-query/query";
import {
  useViewReplicaPaint,
  viewReplicaStore,
} from "@/lib/view-replica/view-replica-store";
import { admitsLocalPlane, type AuthStatus } from "@/stores/auth/auth-store";

const SERVICE = "epic.listTasks";

/**
 * History's first page in the replica tier.
 *
 * A row's scope is read from its own grant: a task the viewer sees through a
 * team (an `organization` grant) is that team's row, and every other row
 * (their own, shared by name, by link) is the account's. A cached page paints
 * as `cloudPage: "unavailable"`: rows the person had, not the serving tier's
 * current answer. Its cursor is dropped, since a cursor names a position in a
 * listing that has moved on.
 *
 * History's local contribution (local-homed rows, tombstones, completeness)
 * is registered on {@link historyReplicaService} by
 * `HistoryLocalContributionMount`, so no cached History page paints without
 * it.
 */
export const historyReplicaService = new ViewReplicaService<ListTasksResponse>({
  service: SERVICE,
  canonicalVersion: clientUnaryCanonicalVersion(SERVICE),
  split: (page) => {
    const { tasks, ...shell } = page;
    return {
      shell,
      rows: tasks.map((task) => ({ scope: taskRowScope(task), value: task })),
    };
  },
  join: (shell, rows) => {
    if (typeof shell !== "object" || shell === null) return null;
    const parsed = listTasksResponseSchema.safeParse({
      ...shell,
      tasks: rows,
    });
    return parsed.success ? parsed.data : null;
  },
  asCached: (page, withdrawnScopes) => {
    const completeness = page.completeness;
    return {
      ...page,
      nextCursor: undefined,
      completeness:
        completeness === undefined
          ? undefined
          : {
              ...completeness,
              cloudPage: "unavailable",
              // The counts include rows a withdrawal removed.
              facets:
                withdrawnScopes.length > 0 ? "partial" : completeness.facets,
            },
    };
  },
});

export function taskRowScope(task: ListTaskLight): ViewReplicaRowScope {
  const permission = task.epic?.permission ?? task.phase?.permission ?? null;
  if (
    permission?.accessType === "organization" &&
    permission.organizationId !== undefined &&
    permission.organizationId.length > 0
  ) {
    return organizationRowScope(permission.organizationId);
  }
  return ACCOUNT_ROW_SCOPE;
}

/**
 * The replica address of History's first page, or `null` for a page the
 * replica does not keep. Only the unfiltered listing is kept: it is the page
 * History paints when it opens, one per sort, while a search or filter is a
 * page the person asked for and waits on anyway.
 */
export function historyReplicaAddress(
  accountId: string,
  hostId: string,
  request: ListCloudTasksRequest,
): ViewReplicaAddress | null {
  if (request.filters !== null) return null;
  const servingTier = hostRpcServingTierHostId(
    SERVICE,
    hostId,
    readProcessHostRpcTierPlan(),
    null,
  );
  if (servingTier === null) return null;
  return {
    accountId,
    service: SERVICE,
    servingTier,
    requestScope: viewReplicaRequestScope(request),
  };
}

/**
 * The replica's History page for this request, for the signed-in account, or
 * `undefined` for a miss. A read of the account's own cached rows: it keys by
 * the signed-in identity, not the host's request context, and dispatches
 * nothing.
 */
export function useHistoryReplicaPage(
  identity: { readonly status: AuthStatus; readonly userId: string | null },
  hostId: string | null,
  request: ListCloudTasksRequest,
): ListTasksResponse | undefined {
  const accountId = admitsLocalPlane(identity.status) ? identity.userId : null;
  const page = useViewReplicaPaint(
    historyReplicaService,
    accountId === null || hostId === null
      ? null
      : historyReplicaAddress(accountId, hostId, request),
  );
  return page ?? undefined;
}

/**
 * Records a first page the serving tier settled. A page whose cloud half is
 * still owed (`pending`) or missing (`unavailable`) is not the account's
 * listing and is not kept over the last one that was.
 */
export function rememberHistoryFirstPage(input: {
  readonly accountId: string;
  readonly hostId: string;
  readonly request: ListCloudTasksRequest;
  readonly page: ListTasksResponse;
  readonly observedAt: number;
}): void {
  const cloudPage = input.page.completeness?.cloudPage;
  if (cloudPage !== undefined && cloudPage !== "settled") return;
  const address = historyReplicaAddress(
    input.accountId,
    input.hostId,
    input.request,
  );
  if (address === null) return;
  viewReplicaStore.write(historyReplicaService, address, input.page, {
    observedAt: input.observedAt,
    sourceGeneration: null,
  });
}

/** A History write (a pin) was confirmed: older pages must not paint. */
export function noteHistoryConfirmedWrite(accountId: string): void {
  viewReplicaStore.noteConfirmedWrite(accountId, SERVICE, {
    at: Date.now(),
    generation: null,
  });
}
