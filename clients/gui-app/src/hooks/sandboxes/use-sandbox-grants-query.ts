import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { SandboxGrantsSummary } from "@traycer/protocol/host/sandbox-secrets";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/** One sandbox host, in the environment its row names. */
interface SandboxGrantsTarget {
  readonly environmentId: string | null;
  readonly hostId: string;
}

function sandboxGrantsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  target: SandboxGrantsTarget | null,
  enabled: boolean,
) {
  if (auth === null || target === null) {
    return queryOptions<SandboxGrantsSummary | null>({
      queryKey: sandboxQueryKeys.grantsMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<SandboxGrantsSummary | null>({
    queryKey: sandboxQueryKeys.grants(
      auth,
      userId,
      target.environmentId,
      target.hostId,
    ),
    queryFn: async () => {
      const result = await auth.getSandboxGrants(
        target.environmentId,
        target.hostId,
      );
      if (result.kind === "ok") return result.summary;
      // The broker holds no grant set under this id for this user (a sandbox
      // from before the broker, or one already gone): nothing to list, which
      // is an answer and not a failure.
      if (result.kind === "not-found") return null;
      // Thrown, never an empty summary: "no secrets" is a claim about what
      // the sandbox can reach, and an unread answer is not that.
      throw new Error(
        result.kind === "unauthorized"
          ? "Sign in again to see this sandbox's secrets."
          : "Couldn't load this sandbox's secrets.",
      );
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /api/v3/environments/:environmentId/secrets/hosts/:hostId/grants`: the
 * secrets one sandbox host may use, each with the destinations it is brokered
 * to. Read from the broker (authn) with the user's bearer, never through the
 * sandbox. `environmentId` is the sandbox row's; `null` (a server that
 * predates environments) reads the person's Personal environment.
 *
 * `data` is `undefined` until the first answer, `null` when the broker has no
 * grant set for the host, and stays at the last good answer through a failed
 * refetch. It refetches on focus - the dashboard, where grants change, is
 * another window - and after a grant decision made in the app.
 */
export function useSandboxGrants(
  environmentId: string | null,
  hostId: string | null,
): UseQueryResult<SandboxGrantsSummary | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const target = hostId === null ? null : { environmentId, hostId };
  return useQuery(sandboxGrantsQueryOptions(auth, userId, target, signedIn));
}
