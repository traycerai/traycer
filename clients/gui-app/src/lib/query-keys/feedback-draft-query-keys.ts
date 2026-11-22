/**
 * Query keys for a feedback draft's held decision. Keyed by the account
 * session that decided it and the draft's full address: a block id is opaque
 * and unique only within its chat, and a decision belongs to one session.
 */
export const feedbackDraftQueryKeys = {
  decisions: () => ["chat.feedbackDraft.decision"] as const,
  decision: (draft: {
    readonly sessionId: number;
    readonly hostId: string;
    readonly epicId: string;
    readonly chatId: string;
    readonly blockId: string;
  }) =>
    [
      "chat.feedbackDraft.decision",
      draft.sessionId,
      draft.hostId,
      draft.epicId,
      draft.chatId,
      draft.blockId,
    ] as const,
};
