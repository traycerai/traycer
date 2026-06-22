/** 0-based index -> displayed shortcut number. */
export function leaderDigitFor(index: number): string {
  return String(index + 1);
}

/**
 * Screen-reader label for a leader-digit shortcut hint. Example:
 * `leaderHint(0, "switch to", "Runtime Core")` -> `"Press 1 to switch to Runtime Core"`.
 */
export function leaderHint(
  index: number,
  action: string,
  target: string,
): string {
  return `Press ${leaderDigitFor(index)} ${action} ${target}`;
}
