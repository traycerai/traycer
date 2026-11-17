/**
 * Mutation key for deciding a feedback draft. Keyed by the draft's full
 * address and the account session deciding it: a block id is opaque and unique only
 * within its chat, and every surface reading this key's decisions must see
 * only its own draft's, in its own session.
 */
export const feedbackDraftMutationKeys = {
  decide: (draft: {
    readonly hostId: string;
    readonly sessionId: number | null;
    readonly epicId: string;
    readonly chatId: string;
    readonly blockId: string;
  }) =>
    [
      "chat.feedbackDraft.decide",
      draft.hostId,
      draft.sessionId,
      draft.epicId,
      draft.chatId,
      draft.blockId,
    ] as const,
};
