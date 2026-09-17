/**
 * The line an unattended auto-mode refusal paints.
 *
 * Lives apart from the component so chat find can index the text the row
 * RENDERS rather than a second string that happens to agree today - the same
 * arrangement, and the same reason, as `importedChatMarkerLabel`.
 */

/**
 * Names the thing the user would otherwise have to infer.
 *
 * A denial with no card is indistinguishable from a judge that simply refused,
 * so the first two sentences say both halves: nobody was asked, and WHY nobody
 * was asked. The verdict's own rule and reason follow when the journal
 * recorded them; a row with neither still says the part only this row can say.
 */
export function autoJudgeUnattendedDenialText(input: {
  readonly rule: string | null;
  readonly reason: string | null;
}): string {
  const head =
    "Refused without asking. This chat was running for another agent, so there was nobody to ask.";
  if (input.rule === null && input.reason === null) return head;
  if (input.reason === null) return `${head} ${input.rule}`;
  if (input.rule === null) return `${head} ${input.reason}`;
  return `${head} ${input.rule} — ${input.reason}`;
}
