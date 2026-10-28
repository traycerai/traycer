import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import { useHostBinding } from "@/lib/host";
import { sandboxListQueryOptions } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Notice evidence shares the directory-refreshed list; it adds no timer. */
export function useSandboxNoticeListQuery(
  enabled: boolean,
): UseQueryResult<SandboxListResponse | null> {
  const binding = useHostBinding();
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const available = useSandboxControlUnavailableReason() === null;
  return useQuery(
    sandboxListQueryOptions(
      binding?.auth ?? null,
      userId,
      enabled && signedIn && available,
    ),
  );
}
