import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";

/**
 * Whether this question's answer channel can carry free text ("Other").
 *
 * `null` is UNSTATED and offers free text, exactly as every renderer did
 * before the field existed; only an explicit `false` withdraws it. Withdrawal
 * has to hold across the whole card and not just the rendered row: the digit
 * shortcut maps `options.length + 1` to Other, and a stored draft outlives the
 * event that raised the question. So this predicate gates the two entry
 * points and the submission boundary, not the markup alone.
 *
 * It lives in its own module rather than in `pending-interview/interview-draft`
 * because the RESOLVED transcript reads it too (`interview-visuals`): a
 * question the user could never answer with free text must not show an Other
 * row after the fact either, and the historical card is not a pending draft.
 * Importing a pending-interview module from the shared visuals to reach one
 * predicate would invert that direction.
 */
export function questionAllowsCustomAnswer(
  question: InterviewQuestion,
): boolean {
  return question.allowsCustomAnswer !== false;
}
