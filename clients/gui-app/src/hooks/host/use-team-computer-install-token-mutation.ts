import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { TeamComputerInstallTokenResult } from "@traycer-clients/shared/host-client/team-computer-install";
import { useMutationStateOf } from "@/hooks/use-mutation-state-of";
import {
  SupersededAuthEraError,
  type ChosenSignIn,
} from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { teamComputerMutationKeys } from "@/lib/query-keys/team-computer-mutation-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface TeamComputerInstallToken {
  readonly installToken: string;
  readonly expiresAt: number;
}

const ACCOUNT_CHANGED = "The signed-in account changed. Create a new token.";

function mintFailure(
  result: Exclude<TeamComputerInstallTokenResult, { kind: "ok" }>,
): string {
  if (result.kind === "unauthorized")
    return "Sign in to create an install token.";
  if (result.kind === "refused") {
    if (result.code === "environment_not_found")
      return "You can't add computers to this team.";
    if (
      result.code === "environment_action_forbidden" ||
      result.code === "seat_without_write"
    )
      return "Ask a team admin for permission to add computers.";
  }
  return "Couldn't create the install token. Try again.";
}

export function useTeamComputerInstallTokenMutation(
  environmentId: string,
): UseMutationResult<TeamComputerInstallToken, Error, ChosenSignIn | null> {
  const binding = useHostBinding();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const status = useAuthStore((state) => state.status);
  return useMutation({
    mutationKey: teamComputerMutationKeys.installToken(userId, environmentId),
    retry: false,
    gcTime: 60 * 60_000,
    // `chosenBy` is read at the press: Query awaits before this runs, and the
    // mint refuses there if that sign-in has ended.
    mutationFn: async (chosenBy) => {
      if (
        binding === null ||
        chosenBy === null ||
        userId === null ||
        status !== "signed-in"
      ) {
        throw new Error("Sign in to create an install token.");
      }
      let result: TeamComputerInstallTokenResult;
      try {
        result = await binding.auth.mintTeamComputerInstallToken(
          environmentId,
          chosenBy,
        );
      } catch (error) {
        if (error instanceof SupersededAuthEraError)
          throw new Error(ACCOUNT_CHANGED);
        throw new Error("Couldn't create the install token. Try again.");
      }
      const current = useAuthStore.getState();
      if (
        current.status !== "signed-in" ||
        current.contextMetadata?.userId !== userId
      ) {
        throw new Error(ACCOUNT_CHANGED);
      }
      if (result.kind !== "ok") throw new Error(mintFailure(result));
      return { installToken: result.token, expiresAt: result.expiresAt };
    },
  });
}

function heldToken(value: unknown): TeamComputerInstallToken | null {
  if (
    value !== null &&
    typeof value === "object" &&
    "installToken" in value &&
    typeof value.installToken === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number"
  )
    return { installToken: value.installToken, expiresAt: value.expiresAt };
  return null;
}

/** Held only in memory, under the account's key, until expiry or identity change. */
export function useTeamComputerInstallTokenLatest(environmentId: string): {
  readonly pending: boolean;
  readonly token: TeamComputerInstallToken | null;
  readonly failure: string | null;
} {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const states = useMutationStateOf(
    {
      mutationKey: teamComputerMutationKeys.installToken(userId, environmentId),
    },
    (mutation) => ({
      status: mutation.state.status,
      token: heldToken(mutation.state.data),
      failure:
        mutation.state.error instanceof Error
          ? mutation.state.error.message
          : null,
    }),
  );
  const latest = states.at(-1);
  return {
    pending: latest?.status === "pending",
    token: latest?.status === "success" ? latest.token : null,
    failure: latest?.status === "error" ? latest.failure : null,
  };
}
