import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";

/** The catalogue moves on a provider contract, not on a user's action. */
const SANDBOX_CATALOGUE_STALE_MS = 10 * 60_000;

function sandboxCatalogueQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<SandboxCatalogue>({
      queryKey: sandboxQueryKeys.catalogueMissing(),
      queryFn: () => Promise.reject(new Error("Sign in to create a sandbox.")),
      enabled: false,
    });
  }
  return queryOptions<SandboxCatalogue>({
    queryKey: sandboxQueryKeys.catalogue(auth, userId),
    queryFn: async () => {
      const result = await auth.getSandboxCatalogue();
      if (result.kind === "ok") {
        return result.catalogue;
      }
      throw new Error(sandboxFailureMessage(result));
    },
    enabled,
    staleTime: SANDBOX_CATALOGUE_STALE_MS,
  });
}

/**
 * `GET /api/sandboxes/catalogue`: shapes, regions, prices and the nearest
 * region, for the create form. Only the open form reads it (`enabled`).
 */
export function useSandboxCatalogue(
  enabled: boolean,
): UseQueryResult<SandboxCatalogue> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(
    sandboxCatalogueQueryOptions(auth, userId, signedIn && enabled),
  );
}
