import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { TeamHostInstallTokenResult } from "@traycer-clients/shared/host-client/team-host";
import { useHostBinding } from "@/lib/host";
import { teamHostMutationKeys } from "@/lib/query-keys";

/** A team machine's one-time install token, as the card shows it once. */
export interface TeamHostInstallToken {
  readonly installToken: string;
  /** When the token lapses, epoch ms. */
  readonly expiresAt: number;
}

type TeamHostInstallTokenFailure = Exclude<
  TeamHostInstallTokenResult,
  { readonly kind: "ok" }
>;

const MINT_FAILED_LINE = "Couldn't create the install token. Try again.";

/** A refused mint, as the line the card shows under its button. */
function failureLine(failure: TeamHostInstallTokenFailure): string {
  switch (failure.kind) {
    case "team-host-exists":
      return "The team already has a host.";
    case "not-found":
      return "You can't add a host to this team.";
    case "unauthorized":
      return "Sign in to add a host to this team.";
    case "unavailable":
      return failure.reason;
    case "refused":
    case "network-error":
      return MINT_FAILED_LINE;
  }
}

/**
 * `POST /api/environments/{id}/team-host/install-token`: mints the one-time
 * token a team's own computer joins with (`traycer host join <token>`). The
 * token is a credential shown once: the answer lives only on this mutation,
 * which is dropped from the cache as soon as nothing observes it
 * (`gcTime: 0`), and nothing here logs it. A refusal is drawn in place.
 */
export function useTeamHostInstallTokenMutation(
  environmentId: string,
): UseMutationResult<TeamHostInstallToken, Error, void> {
  const binding = useHostBinding();
  return useMutation({
    mutationKey: teamHostMutationKeys.installToken(environmentId),
    mutationFn: async () => {
      if (binding === null) {
        throw new Error(failureLine({ kind: "unauthorized" }));
      }
      const result = await binding.auth.mintTeamHostInstallToken(environmentId);
      if (result.kind !== "ok") throw new Error(failureLine(result));
      return { installToken: result.installToken, expiresAt: result.expiresAt };
    },
    gcTime: 0,
  });
}
