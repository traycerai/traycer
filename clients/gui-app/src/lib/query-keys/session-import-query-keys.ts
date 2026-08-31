import type { QueryKey } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";

/**
 * Keys for session import's one unary read.
 *
 * The two stream methods have no key at all: streams don't compose with
 * TanStack Query, so their state lives in `session-import-run-store`. This
 * exists so the surfaces that read `lastCompleted` can retire it the moment a
 * run they were watching finishes, without reaching for a raw array literal.
 */
export const sessionImportQueryKeys = {
  status: (hostId: string | null): QueryKey =>
    hostQueryKeys.method<HostRpcRegistry, "sessionImport.status">(
      hostId,
      "sessionImport.status",
      {},
    ),
} as const;
