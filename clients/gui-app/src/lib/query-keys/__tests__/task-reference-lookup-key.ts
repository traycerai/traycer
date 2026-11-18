import {
  hostQueryKeys,
  TASK_REFERENCE_LOOKUP_TAG,
} from "@/lib/query-keys/host-query-keys";

/**
 * The key `TaskReferenceChip`'s own lookup of one task is cached under: the
 * `epic.getTaskContexts` family for that task, then the tag that keeps it for
 * the session. Matches `useHostQuery` with
 * `cacheKeyIdentity: [userId, TASK_REFERENCE_LOOKUP_TAG]`.
 */
export function taskReferenceLookupKey(
  hostId: string | null,
  userId: string,
  taskId: string,
) {
  return [
    ...hostQueryKeys.epicTaskContexts(hostId, userId, [taskId]),
    TASK_REFERENCE_LOOKUP_TAG,
  ] as const;
}
