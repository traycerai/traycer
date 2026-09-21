/**
 * Finger-sequence transitions read off macOS `NSEvent` scroll phases in main.
 *
 * Chromium strips the phase before a wheel event reaches JavaScript in either
 * process, so a renderer cannot tell resting fingers from lifted ones, and
 * momentum ticks after a lift look like live input. These transitions are the
 * missing half: deltas and targeting stay with the DOM `wheel` stream, and
 * this only says when a finger sequence starts and stops. macOS only.
 */
export const TRACKPAD_SCROLL_PHASE_KINDS = [
  "began",
  "ended",
  "cancelled",
  "momentum-began",
  "momentum-ended",
  "momentum-cancelled",
] as const;

export type TrackpadScrollPhaseKind = (typeof TRACKPAD_SCROLL_PHASE_KINDS)[number];

export interface TrackpadScrollPhaseTransition {
  readonly kind: TrackpadScrollPhaseKind;
}

export function isTrackpadScrollPhaseKind(
  value: unknown,
): value is TrackpadScrollPhaseKind {
  return (
    typeof value === "string" &&
    (TRACKPAD_SCROLL_PHASE_KINDS as readonly string[]).includes(value)
  );
}
