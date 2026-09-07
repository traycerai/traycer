import { useCallback } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { MintLinkLoginCodeResponse } from "@traycer/protocol/auth/link-login";
import type { AuthService } from "@/lib/auth/auth-service";
import { LinkLoginMintError } from "@/lib/auth/link-login-mint-error";
import { useHostBinding } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

// Exported so the panel's countdown can derive the rotation moment from the same cadence rather than a copy.
/** Treated as expired this far ahead of the server's instant, so a focus refetch does not hand back a code with a second of life left. */
const LINK_LOGIN_EXPIRY_SKEW_MS = 5_000;

export const LINK_LOGIN_REMINT_MS = 50_000;

function linkLoginCodeQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  active: boolean,
) {
  if (auth === null || userId === null) {
    return queryOptions<MintLinkLoginCodeResponse | null>({
      queryKey: authQueryKeys.linkLoginCodeMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  // `active` gates via `enabled`, NEVER by switching to the missing key: a deactivated observer must stay on the REAL mint entry, so an explicit cache eviction + re-enable (the watch hook's `restart`) operates on the query the surface actually renders.
  return queryOptions<MintLinkLoginCodeResponse | null>({
    queryKey: authQueryKeys.linkLoginCode(auth, userId),
    enabled: active,
    queryFn: async ({ signal }) => {
      const result = await auth.mintLinkLoginCode(signal);
      if (result.kind !== "ok") {
        // The typed error keeps the wire meaning, so the panel renders `claim-pending` as the awaiting state instead of an error card over retained stale data.
        throw new LinkLoginMintError(result.kind);
      }
      return result.response;
    },
    // Rotation is interval-driven; a focus refetch must not burn extra codes, but every fresh OPEN of the panel mints anew (`refetchOnMount: "always"`) so a reopened panel never shows a code another consumer may have spent.
    refetchInterval: LINK_LOGIN_REMINT_MS,
    refetchOnMount: "always",
    // Refetching on EVERY focus would burn a fresh code each time the user tabbed away and back, which the one-live-code rule makes expensive; keying on the displayed code's own `expires_at` mints only when what is on screen is actually dead.
    refetchOnWindowFocus: (query) => {
      const shown = query.state.data;
      if (shown === undefined || shown === null) {
        return true;
      }
      return shown.expires_at * 1_000 <= Date.now() + LINK_LOGIN_EXPIRY_SKEW_MS;
    },
    // A few seconds, not Infinity: when the panel re-enables this query after a decision (rotation was frozen while a claim awaited approval), the cached code is stale by then and must be replaced immediately rather than on the next 50s interval tick.
    staleTime: 5_000,
    gcTime: 15_000,
    retry: false,
  });
}

/** The panel deactivates the rotation the moment a phone claims the displayed code - a fresh QR must not replace the one whose claimant the user is being asked to approve. */
export function useAuthLinkLoginCode(
  active: boolean,
): UseQueryResult<MintLinkLoginCodeResponse | null> {
  const binding = useHostBinding();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  const auth = binding === null ? null : binding.auth;
  return useQuery(linkLoginCodeQueryOptions(auth, userId, active));
}

/** The user-driven restart after a dead code MUST evict, not refetch: a manual refetch from a disabled observer fires the request but the surface re-adopts the still-fresh cache entry on re-enable - the dead code renders again and the minted one is wasted (measured on the portal surface, same TanStack behavior here). */
export function useEvictLinkLoginCode(): () => void {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  const auth = binding === null ? null : binding.auth;
  return useCallback(() => {
    if (auth === null || userId === null) {
      return;
    }
    queryClient.removeQueries({
      queryKey: authQueryKeys.linkLoginCode(auth, userId),
    });
  }, [auth, queryClient, userId]);
}
