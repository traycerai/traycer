import type { ListTasksRequest } from "@traycer/protocol/host/epic/unary-schemas";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

const CLOUD_EPIC_TASKS_DISCRIMINATOR = "cloud.listTasks";
const CLOUD_EPIC_TASKS_LAST_KNOWN_DISCRIMINATOR = "cloud.listTasks.lastKnown";
// Deliberately NOT under `hostQueryKeys.scope(hostId)`, unlike its two
// siblings above, and deliberately not a `cloud.listTasks*` string. Both would
// change which queries this key answers to: the host scope would enlist a
// transient `gcTime: 0` lease query in every broad host-scope invalidation,
// and `isCloudEpicTasksQueryKey` below is an exact element match, so a
// `cloud.listTasks`-prefixed name is only safe by accident. The flat shape
// here is the one this key has always had - this constant exists so the
// literal has one home, not to re-shape it.
const CLOUD_EPIC_TASKS_LOCAL_FIRST_REVALIDATION_DISCRIMINATOR =
  "cloud-epic-tasks-local-first-revalidation";

export const cloudQueryKeys = {
  epicTasks: (
    hostId: string,
    fingerprint: string,
    request: Omit<ListTasksRequest, "cursor">,
  ): readonly unknown[] => [
    ...hostQueryKeys.scope(hostId),
    CLOUD_EPIC_TASKS_DISCRIMINATOR,
    request,
    "all-epics-and-phases",
    fingerprint,
  ],
  epicTasksLastKnown: (hostId: string, fingerprint: string) =>
    [
      ...hostQueryKeys.scope(hostId),
      CLOUD_EPIC_TASKS_LAST_KNOWN_DISCRIMINATOR,
      fingerprint,
    ] as const,
  epicTasksLocalFirstRevalidation: (
    hostId: string,
    fingerprint: string,
    request: Omit<ListTasksRequest, "cursor">,
    leaseGeneration: number,
  ) =>
    [
      CLOUD_EPIC_TASKS_LOCAL_FIRST_REVALIDATION_DISCRIMINATOR,
      hostId,
      fingerprint,
      request,
      leaseGeneration,
    ] as const,
};

/**
 * True for the cloud-tasks history query key. The history is manual-refresh-only
 * (`staleTime: Infinity`), so broad host-scope invalidations must skip it -
 * force-refetching it drops optimistically-inserted local-first epics that the
 * cloud `listTasks` response does not contain yet.
 */
export function isCloudEpicTasksQueryKey(
  queryKey: readonly unknown[],
): boolean {
  return queryKey.includes(CLOUD_EPIC_TASKS_DISCRIMINATOR);
}
