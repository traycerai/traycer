import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type {
  VoiceSessionEndFetchResult,
  VoiceSessionIndicator,
  VoiceSessionMintFetchResult,
  VoiceSessionMintRequest,
} from "@traycer-clients/shared/host-client/voice-sessions";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import type {
  VoiceCallAuthority,
  VoiceCallPrincipalChanged,
} from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { voiceMutationKeys } from "@/lib/query-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * `POST /api/voice/sessions`: mints a voice session for the offer, under the
 * account the call was started under. The route's refusals (dormant,
 * credits, unavailable, voice-unavailable) and a changed account come back
 * as the result's `kind`, not as errors: the controller ends the attempt
 * with the matching reason and the call says it, so nothing is toasted here.
 */
export function useVoiceSessionMintMutation(): UseMutationResult<
  VoiceSessionMintFetchResult | VoiceCallPrincipalChanged,
  Error,
  {
    readonly request: VoiceSessionMintRequest;
    readonly authority: VoiceCallAuthority;
  }
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: voiceMutationKeys.mint(),
    mutationFn: ({ request, authority }) =>
      auth.mintVoiceSession(request, authority),
  });
}

/**
 * `POST /api/voice/sessions/:id/end`: closes the server's row for a session
 * this window minted, under the account that minted it or not at all. Best
 * effort from the controller's terminal latch; a refusal is logged there,
 * since the session is already over for the person.
 */
export function useVoiceSessionEndMutation(): UseMutationResult<
  VoiceSessionEndFetchResult | VoiceCallPrincipalChanged,
  Error,
  { readonly voiceSessionId: string; readonly authority: VoiceCallAuthority }
> {
  const auth = useAuthService();
  return useMutation({
    mutationKey: voiceMutationKeys.end(),
    mutationFn: ({ voiceSessionId, authority }) =>
      auth.endVoiceSession(voiceSessionId, authority),
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
 * What this window's live session reports to the shell's voice item (the
 * desktop's menu-bar or notification-area item): muted, paused for
 * dictation. Best effort, like the live flag: a failure is logged by the
 * controller.
 */
export function useVoiceShellIndicatorMutation(): UseMutationResult<
  void,
  Error,
  VoiceSessionIndicator
> {
  const runnerHost = useRunnerHost();
  return useMutation({
    mutationKey: voiceMutationKeys.shellIndicator(),
    mutationFn: (indicator) => runnerHost.setVoiceSessionIndicator(indicator),
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

/**
 * Opens the OS settings page for a refused microphone, from the ended line's
 * Open Settings. A launch the OS refuses is the person's to hear about: the
 * button did nothing they can see.
 */
export function useVoiceMicrophoneSettingsMutation(): UseMutationResult<
  void,
  Error,
  void
> {
  const runnerHost = useRunnerHost();
  return useMutation({
    mutationKey: voiceMutationKeys.microphoneSettings(),
    mutationFn: () => runnerHost.openMicrophoneSettings(),
    onError: (error) =>
      toastFromRunnerError(error, "Couldn't open the microphone settings"),
  });
}
