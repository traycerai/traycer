/** 0-based index -> displayed shortcut number. */
export function leaderDigitFor(index: number): string {
  return String(index + 1);
}

/**
 * Screen-reader label for a leader-digit shortcut hint. Takes the already
 * -computed digit (via `leaderDigitFor` or the wraparound
 * `singleDigitLeaderDigitFor`) rather than an index, so it stays correct for
 * whichever convention the caller's scope dispatches under. Example:
 * `leaderHint("1", "switch to", "Runtime Core")` -> `"Press 1 to switch to Runtime Core"`.
 */
export function leaderHint(
  digit: string,
  action: string,
  target: string,
): string {
  return `Press ${digit} ${action} ${target}`;
}
