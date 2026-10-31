import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type {
  VoiceSessionEndFetchResult,
  VoiceSessionMintFetchResult,
  VoiceSessionMintRequest,
} from "@traycer-clients/shared/host-client/voice-sessions";
import { useAuthService } from "@/lib/host";
import { voiceMutationKeys } from "@/lib/query-keys";

/**
 * `POST /api/voice/sessions`: mints a voice session for the offer. The
 * route's refusals (dormant, credits, unavailable) come back as the result's
 * `kind`, not as errors: the controller ends the attempt with the matching
 * reason and the strip says it, so nothing is toasted here.
 */
export function useVoiceSessionMintMutation(): UseMutationResult<
  VoiceSessionMintFetchResult,
  Error,
  VoiceSessionMintRequest
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: voiceMutationKeys.mint(),
    mutationFn: (request) => auth.mintVoiceSession(request),
  });
}

/**
 * `POST /api/voice/sessions/:id/end`: closes the server's row for a session
 * this window minted. Best effort from the controller's terminal latch; a
 * refusal is logged there, since the session is already over for the person.
 */
export function useVoiceSessionEndMutation(): UseMutationResult<
  VoiceSessionEndFetchResult,
  Error,
  string
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: voiceMutationKeys.end(),
    mutationFn: (voiceSessionId) => auth.endVoiceSession(voiceSessionId),
  });
}
