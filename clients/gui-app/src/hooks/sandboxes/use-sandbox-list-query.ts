import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";

function sandboxListQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<SandboxListResponse | null>({
      queryKey: sandboxQueryKeys.listMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<SandboxListResponse | null>({
    queryKey: sandboxQueryKeys.list(auth, userId),
    queryFn: async () => {
      const result = await auth.listSandboxes();
      if (result.kind === "ok") {
        return result.response;
      }
      // Thrown, never `{ sandboxes: [] }`: an empty list would read as "every
      // sandbox is gone", and the pickers and host list treat a missing
      // answer as unknown (they fail closed), which is the truth here.
      throw new Error(sandboxFailureMessage(result));
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /api/sandboxes`: the signed-in user's sandboxes, which carry what the
 * host list does not - `burst`, shape, region and rate. Refreshed by the
 * directory's liveness tick (see `sandboxQueryKeys.list`).
 *
 * `data` is `undefined` until the first answer and stays at the last good
 * answer through a failed refetch; a surface that needs to know a sandbox is
 * NOT burst (every picker) must treat `undefined` as "not known", never as
 * "none are burst".
 */
export function useSandboxList(): UseQueryResult<SandboxListResponse | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(sandboxListQueryOptions(auth, userId, signedIn));
}
