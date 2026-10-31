import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type {
  VoiceSessionEndFetchResult,
  VoiceSessionMintFetchResult,
  VoiceSessionMintRequest,
} from "@traycer-clients/shared/host-client/voice-sessions";
import type { VoiceRouteFetchResult } from "@traycer-clients/shared/host-client/voice-router";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import { useAuthService } from "@/lib/host";
import { voiceMutationKeys } from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";

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

/**
 * The voice router's one model call for an utterance (the passthrough). A
 * refusal comes back as the result's `kind`: the say loop refuses the route
 * and the voice asks the person to repeat, so nothing is toasted here.
 */
export function useVoiceRouteMutation(): UseMutationResult<
  VoiceRouteFetchResult,
  Error,
  string
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: voiceMutationKeys.route(),
    mutationFn: (requestBody) => auth.routeVoiceUtterance(requestBody),
  });
}

/**
 * The shell's flag that this window's voice is live, so its close hides the
 * window instead of destroying it. Best effort: a shell without the flag
 * (the browser, mobile) answers at once, and a failure is logged by the
 * controller, which keeps the session either way.
 */
export function useVoiceShellLiveMutation(): UseMutationResult<
  void,
  Error,
  boolean
> {
  const runnerHost = useRunnerHost();
  return useMutation({
    mutationKey: voiceMutationKeys.shellLive(),
    mutationFn: (live) => runnerHost.setVoiceSessionLive(live),
  });
}

/**
 * The microphone permission prompt, through the shell: the person decides,
 * so there is nothing to retry or toast; the controller ends the start with
 * "microphone" on a refusal or a failure.
 */
export function useVoiceMicrophoneAccessMutation(): UseMutationResult<
  MicrophoneAccessStatus,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  return useMutation({
    mutationKey: voiceMutationKeys.microphoneAccess(),
    mutationFn: () => runnerHost.requestMicrophoneAccess(),
  });
}
