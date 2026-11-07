import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { teamHostMutationKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Drops every team-host install-token mint when the person signs out or
 * another account takes over. A mint is a one-time credential held in the
 * shared query client for its window, and the mutation cache outlives the
 * shell; removed here, a mint still in flight settles into nothing, so no
 * later account reads a token, or a mint in progress, it did not make.
 */
export function TeamHostInstallTokenLifecycleBridge(): null {
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (transition.kind === "signedIn") return;
      const cache = queryClient.getMutationCache();
      for (const mutation of cache.findAll({
        mutationKey: teamHostMutationKeys.installTokenAll(),
      })) {
        cache.remove(mutation);
      }
    },
    [queryClient],
  );
  useAuthIdentityTransition(status, userId, onTransition);
  return null;
}
