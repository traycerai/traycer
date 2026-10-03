import type { QueryClient } from "@tanstack/react-query";
import { hostQueryKeys } from "@/lib/query-keys";

/** A read sent before an accepted write must not supersede its response. */
export function cancelProfileSyncList(
  queryClient: QueryClient,
  sourceHostId: string,
): Promise<void> {
  return queryClient.cancelQueries({
    queryKey: hostQueryKeys.methodScope(
      sourceHostId,
      "providers.profileCopy.sync.list",
    ),
  });
}

export async function refreshProfileSyncAfterWrite(
  queryClient: QueryClient,
  sourceHostId: string,
): Promise<void> {
  await cancelProfileSyncList(queryClient, sourceHostId);
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      sourceHostId,
      "providers.profileCopy.sync.list",
    ),
  });
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      sourceHostId,
      "providers.profileCopy.sync.preview",
    ),
  });
}
