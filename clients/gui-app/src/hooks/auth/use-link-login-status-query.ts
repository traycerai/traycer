import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { LinkLoginStatusResponse } from "@traycer/protocol/auth/link-login";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

const LINK_LOGIN_STATUS_POLL_MS = 2_000;

/**
 * `gone` is a first-class datum, not an error: an expired/consumed/foreign
 * code answers this way and the panel resolves it against its own state
 * (fresh QR supersedes it, or the approved claim was just consumed).
 */
export type LinkLoginStatusDatum = LinkLoginStatusResponse | "gone";

function linkLoginStatusQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  code: string | null,
) {
  if (auth === null || userId === null || code === null) {
    return queryOptions<LinkLoginStatusDatum | null>({
      queryKey: authQueryKeys.linkLoginStatusMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<LinkLoginStatusDatum | null>({
    queryKey: authQueryKeys.linkLoginStatus(auth, userId, code),
    queryFn: async ({ signal }) => {
      const result = await auth.fetchLinkLoginStatus(code, signal);
      if (result.kind === "ok") {
        return result.response;
      }
      if (result.kind === "gone") {
        return "gone";
      }
      // Thrown, not returned: the panel is an inline-error surface and the
      // next interval tick retries anyway.
      throw new Error("Could not reach the sign-in service.");
    },
    refetchInterval: LINK_LOGIN_STATUS_POLL_MS,
    // Keep polling while the window is unfocused: the claimed record can
    // expire server-side while the user is busy on the phone, and a frozen
    // watch would leave a confirm card whose buttons act on a dead code.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    gcTime: 0,
    retry: false,
  });
}

/**
 * The minting surface's watch on one displayed code: whether a phone claimed
 * it, and the claimant metadata for the confirmation prompt. Pass `null` to
 * hold the watch (no code on screen).
 */
export function useAuthLinkLoginStatus(
  code: string | null,
): UseQueryResult<LinkLoginStatusDatum | null> {
  const binding = useHostBinding();
  const userId = useAuthStore((s) =>
    s.status === "signed-in" ? (s.contextMetadata?.userId ?? null) : null,
  );
  const auth = binding === null ? null : binding.auth;
  return useQuery(linkLoginStatusQueryOptions(auth, userId, code));
}
