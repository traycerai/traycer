import type { QueryKey } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/** Keys for session import's one unary read. */
export const sessionImportQueryKeys = {
  status: (hostId: string | null): QueryKey =>
    hostQueryKeys.method<HostRpcRegistry, "sessionImport.status">(
      hostId,
      "sessionImport.status",
      {},
    ),
} as const;
