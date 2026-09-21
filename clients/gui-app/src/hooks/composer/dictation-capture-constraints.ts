/**
 * Constraints for one explicit dictation capture.
 *
 * `echoCancellation: true` is what Chromium maps to the Windows communications
 * capture category. Windows then treats the process as a call: other audio is
 * muted, and the system plays its listening earcon when the person speaks and
 * again after a few seconds of silence. Dictation is one-way, so Windows must
 * not be asked for that stream. Noise suppression and auto-gain stay; they
 * are applied in the capture graph and are what keeps the waveform flat at
 * rest. Other platforms keep echo cancellation; it does not select that
 * category there.
 */
export function dictationCaptureConstraints(windows: boolean): {
  readonly channelCount: 1;
  readonly echoCancellation: boolean;
  readonly noiseSuppression: true;
  readonly autoGainControl: true;
} {
  return {
    channelCount: 1,
    echoCancellation: !windows,
    noiseSuppression: true,
    autoGainControl: true,
  };
}
