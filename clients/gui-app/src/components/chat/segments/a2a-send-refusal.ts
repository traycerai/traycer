/**
 * The fixed opening of a same-principal refusal (core flows, the reach row):
 * the host's `principalMismatchSentence` and its host-verb refusals both start
 * with it, and it is the only part of either that is not composed.
 */
export const A2A_REFUSAL_PREFIX = "not reachable from this host: ";

/** The `<tool> failed: ` the host's tool-error surfacing puts in front. */
const TOOL_FAILURE_PREFIX = /^[a-z0-9_]+ failed: /;

/**
 * The refusal sentence a refused send carries, verbatim, or `null` for any
 * other error. The persisted tool block holds the error as text only, so the
 * refusal is recognised by its fixed opening. The host has already chosen the
 * team or someone-else wording by whether the person may open the target;
 * the GUI shows its choice and does not re-make it.
 */
export function a2aSendRefusalSentence(error: string | null): string | null {
  if (error === null || error.length === 0) return null;
  const sentence = error.replace(TOOL_FAILURE_PREFIX, "");
  return sentence.startsWith(A2A_REFUSAL_PREFIX) ? sentence : null;
}
