import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { voiceQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Forgets whether the deployment offers voice when the person signs out. The
 * answer is read once per sign-in and held as fresh for good, and the query
 * cache outlives a sign-out, so the same person signing back in would otherwise
 * never read it again. Lives above the shell, which is gone by then.
 */
export function VoiceAvailabilityLifecycleBridge(): null {
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (transition.kind !== "signedOut") return;
      queryClient.removeQueries({ queryKey: voiceQueryKeys.availabilityAll() });
    },
    [queryClient],
  );
  useAuthIdentityTransition(status, userId, onTransition);
  return null;
}
