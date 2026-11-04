import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { TeamHostInstallTokenResult } from "@traycer-clients/shared/host-client/team-host";
import { useMutationStateOf } from "@/hooks/use-mutation-state-of";
import { useHostBinding } from "@/lib/host";
import { teamHostMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

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
 * How long a minted token stays in memory once nothing shows it: past the
 * token's own 10-minute window, so a card that comes back after the token
 * lapsed says so and offers a new one.
 */
const MINTED_TOKEN_KEPT_MS = 30 * 60_000;

/**
 * `POST /api/environments/{id}/team-host/install-token`: mints the one-time
 * token a team's own computer joins with (`traycer host join <token>`). The
 * token is a credential: the answer lives only on this mutation, in memory,
 * never persisted and never logged; it outlives the card that sent it for
 * its window (`MINTED_TOKEN_KEPT_MS`), so the card shows the mint in flight
 * or its token again after it remounts ({@link useTeamHostInstallTokenLatest}).
 * Keyed by the signed-in account, and dropped when it signs out or another
 * takes over (`TeamHostInstallTokenLifecycleBridge`), so no other account on
 * this app reads it. A refusal is drawn in place.
 */
export function useTeamHostInstallTokenMutation(
  environmentId: string,
): UseMutationResult<TeamHostInstallToken, Error, void> {
  const binding = useHostBinding();
  const userId = useSignedInUserId();
  return useMutation({
    mutationKey: teamHostMutationKeys.installToken(userId, environmentId),
    mutationFn: async () => {
      if (binding === null) {
        throw new Error(failureLine({ kind: "unauthorized" }));
      }
      const result = await binding.auth.mintTeamHostInstallToken(environmentId);
      if (result.kind !== "ok") throw new Error(failureLine(result));
      return { installToken: result.installToken, expiresAt: result.expiresAt };
    },
    gcTime: MINTED_TOKEN_KEPT_MS,
  });
}

/** The newest mint for an environment, whichever mount of the card sent it. */
export interface TeamHostInstallTokenLatest {
  /** A mint is in flight. */
  readonly pending: boolean;
  /** The newest minted token, or `null` before one (or after it is dropped). */
  readonly token: TeamHostInstallToken | null;
}

function isInstallToken(value: unknown): value is TeamHostInstallToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "installToken" in value &&
    typeof value.installToken === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number"
  );
}

/** The signed-in account's canonical id, `null` while signed out. */
function useSignedInUserId(): string | null {
  return useAuthStore((state) => state.contextMetadata?.userId ?? null);
}

/**
 * The environment's newest install-token mint by the signed-in account, as
 * the mutation cache holds it: the card reads it so a mint sent before it
 * unmounted is still in flight, or shown, when it comes back.
 */
export function useTeamHostInstallTokenLatest(
  environmentId: string,
): TeamHostInstallTokenLatest {
  const userId = useSignedInUserId();
  const states = useMutationStateOf(
    { mutationKey: teamHostMutationKeys.installToken(userId, environmentId) },
    (mutation) => ({
      status: mutation.state.status,
      data: mutation.state.data,
    }),
  );
  const latest = states.at(-1);
  return {
    pending: latest?.status === "pending",
    token:
      latest?.status === "success" && isInstallToken(latest.data)
        ? {
            installToken: latest.data.installToken,
            expiresAt: latest.data.expiresAt,
          }
        : null,
  };
}
