/**
 * Mode line under a pending question with listed options. Cardinality lives
 * on the radio/checkbox glyph; this string names what a click does and
 * matches the footer button that is actually on the card (Next vs Submit).
 */
export function interviewChoiceModeHint(
  multiSelect: boolean,
  isLastQuestion: boolean,
): string {
  if (multiSelect) {
    return isLastQuestion ? "Pick any, then Submit" : "Pick any, then Next";
  }
  return isLastQuestion ? "Pick one to send" : "Pick one to continue";
}
