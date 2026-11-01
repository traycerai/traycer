import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { voiceQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

function voiceAvailabilityQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<boolean>({
      queryKey: voiceQueryKeys.availabilityMissing(),
      queryFn: () => Promise.reject(new Error("Sign in to use voice.")),
      enabled: false,
    });
  }
  return queryOptions<boolean>({
    queryKey: voiceQueryKeys.availability(auth, userId),
    queryFn: async () => {
      const result = await auth.getVoiceAvailability();
      if (result.kind === "ok") return result.available;
      throw new Error(
        result.kind === "unauthorized"
          ? "Sign in to use voice."
          : "Voice could not be checked.",
      );
    },
    enabled,
    // Whether a deployment offers voice changes with a deploy, not with a
    // person's actions: read once per window, and again only when a mint
    // says otherwise (the controller invalidates it then).
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/**
 * `GET /api/voice/availability`: whether this deployment offers voice. Read
 * before Talk is drawn, so a person on a server without a voice key never
 * opens a microphone to learn so. `data` is the answer; a failed read leaves
 * Talk hidden and the dormant mint stays the fallback.
 */
export function useVoiceAvailabilityQuery(
  enabled: boolean,
): UseQueryResult<boolean> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useQuery(
    voiceAvailabilityQueryOptions(auth, userId, signedIn && enabled),
  );
}
