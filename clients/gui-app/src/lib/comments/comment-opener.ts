/**
 * Marks a control whose press starts a comment draft through
 * `yieldOpenDraft`, which asks the task's open draft its own question before
 * replacing it. The open draft's box leaves a press on such a control alone,
 * so the opener asks, once. Each press gets its own question: a pick in a
 * frame that already has focus reaches the parent as no press at all.
 */
export const COMMENT_OPENER_ATTRIBUTE = "data-comment-opener";

export const COMMENT_OPENER = { [COMMENT_OPENER_ATTRIBUTE]: "" } as const;
