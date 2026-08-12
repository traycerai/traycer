import type { ListTasksRequest } from "@traycer/protocol/host/epic/unary-schemas";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

const CLOUD_EPIC_TASKS_DISCRIMINATOR = "cloud.listTasks";
const CLOUD_EPIC_TASKS_LAST_KNOWN_DISCRIMINATOR = "cloud.listTasks.lastKnown";

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
