/**
 * Mutation key for deciding a feedback draft. Keyed per draft block: two
 * drafts in one chat are decided independently.
 */
export const feedbackDraftMutationKeys = {
  decide: (blockId: string) => ["chat.feedbackDraft.decide", blockId] as const,
};