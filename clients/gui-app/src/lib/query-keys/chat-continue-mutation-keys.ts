/**
 * Mutation key for continuing a removed sandbox's chat on another sandbox.
 * Keyed per chat: two dead tiles of different chats continue independently.
 */
export const chatContinueMutationKeys = {
  continueHere: (chatId: string) => ["chat.continueHere", chatId] as const,
};
