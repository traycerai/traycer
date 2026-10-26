/**
 * The macOS trackpad scroll stream, read off `NSEvent` in main.
 *
 * Chromium strips the scroll phase before a wheel event reaches JavaScript in
 * either process, so a renderer cannot tell resting fingers from lifted ones,
 * and momentum ticks after a lift look like live input. This stream carries
 * phase AND deltas in one ordered sequence, so a recognizer never has to
 * reconcile it against the DOM `wheel` stream. macOS only.
 */
export const TRACKPAD_SCROLL_KINDS = [
  "began",
  "changed",
  "ended",
  "cancelled",
  "momentum-began",
  "momentum-changed",
  "momentum-ended",
  "momentum-cancelled",
] as const;

export type TrackpadScrollKind = (typeof TRACKPAD_SCROLL_KINDS)[number];

export interface TrackpadScrollEvent {
  readonly kind: TrackpadScrollKind;
  /** AppKit sign: positive means the fingers moved right. Pixels. */
  readonly fingerDeltaX: number;
  /** AppKit sign: positive means the fingers moved down. Pixels. */
  readonly fingerDeltaY: number;
  /** `NSEvent.timestamp`: seconds since boot, exact to the input event. */
  readonly timestamp: number;
  /** Command, Option, Control or Shift was held. */
  readonly modified: boolean;
}

export function isTrackpadScrollKind(
  value: unknown,
): value is TrackpadScrollKind {
  return (
    typeof value === "string" &&
    (TRACKPAD_SCROLL_KINDS as readonly string[]).includes(value)
  );
}
