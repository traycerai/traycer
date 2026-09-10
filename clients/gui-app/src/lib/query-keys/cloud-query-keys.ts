import type { ListTasksRequest } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
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
  /**
   * The per-host local-homed PIN READING - one cursorless `epic.listTasks` whose
   * only consumer is `TaskPinnedState`. A sibling of `epicTasks` rather than a
   * variant of it, deliberately: History's key is manual-refresh-only and is
   * reset/replaced as a paged list, and sharing its key would tie a tab-strip
   * glyph to that lifecycle. The trailing marker is what keeps the two apart
   * under `hostMethod`, which both would otherwise share.
   */
  epicPinReading: (
    hostId: string,
    userId: string,
    request: Omit<ListTasksRequest, "cursor">,
  ): readonly unknown[] => [
    ...hostQueryKeys.method<HostRpcRegistry, "epic.listTasks">(
      hostId,
      "epic.listTasks",
      request,
    ),
    userId,
    EPIC_PIN_READING_DISCRIMINATOR,
  ],
};

/**
 * Marks the pin-reading key, at its last position. A predicate must test THIS
 * and not merely `epic.listTasks`, which every ordinary host-method key for the
 * method also carries.
 */
const EPIC_PIN_READING_DISCRIMINATOR = "pin-reading";

/**
 * True for a per-host pin-reading key (see `cloudQueryKeys.epicPinReading`).
 *
 * Exists because the pin WRITE must reach this cache: the rendered pin state for
 * a local-homed row is read from here, so a patch or invalidation that matches
 * only `cloud.listTasks` leaves the glyph showing the pre-write bit after a
 * successful write, indefinitely - `staleTime: Infinity` means nothing ever
 * refetches it on its own.
 */
export function isEpicPinReadingQueryKey(
  queryKey: readonly unknown[],
): boolean {
  return (
    queryKey[0] === "host" &&
    queryKey[2] === "epic.listTasks" &&
    queryKey[queryKey.length - 1] === EPIC_PIN_READING_DISCRIMINATOR
  );
}

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
