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
  /**
   * `NSEvent.scrollingDeltaX` in pixels. Its sign follows the user's
   * scroll-direction setting: positive reveals content to the left, which is
   * the "back" motion. Back follows that setting, as it does in Safari.
   */
  readonly scrollingDeltaX: number;
  /** `NSEvent.scrollingDeltaY` in pixels; positive reveals content above. */
  readonly scrollingDeltaY: number;
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
