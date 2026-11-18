/**
 * Constraints for one explicit dictation capture.
 *
 * Echo cancellation stays on, including on Windows. Chromium's WASAPI input
 * sets `AudioCategory_Communications` whenever the microphone supports raw
 * processing. `echoCancellation` only selects processed capture
 * (`AUDCLNT_STREAMOPTIONS_NONE`) versus raw capture, so turning it off drops
 * echo suppression and does not leave communications policy.
 */
export function dictationCaptureConstraints(): {
  readonly channelCount: 1;
  readonly echoCancellation: true;
  readonly noiseSuppression: true;
  readonly autoGainControl: true;
} {
  return {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}
