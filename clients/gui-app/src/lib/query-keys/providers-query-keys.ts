import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

export function providersListQueryKey(hostId: string) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.list">(
    hostId,
    "providers.list",
    { native: null },
  );
}
