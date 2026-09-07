export function leaderDigitFor(index: number): string {
  return String(index + 1);
}

/** Takes the already -computed digit (via `leaderDigitFor` or the wraparound `singleDigitLeaderDigitFor`)
 * rather than an index, so it stays correct for whichever convention the caller's scope dispatches under. */
export function leaderHint(
  digit: string,
  action: string,
  target: string,
): string {
  return `Press ${digit} ${action} ${target}`;
}
