/**
 * Mutation keys for the provider-fallback card actions.
 *
 * Keyed per CHAT, unlike most keys in this directory. These four verbs act on
 * one chat's traversal, and several chats can be holding a grace window at the
 * same moment (that is exactly what the card's "N other chats are also
 * switching" line is telling the user) - so a chat-blind key would let one
 * card's pending state disable the buttons on every other card at once.
 */
export const chatFallbackMutationKeys = {
  cancel: (chatId: string) => ["chat.fallback.cancel", chatId] as const,
  chooseTarget: (chatId: string) =>
    ["chat.fallback.chooseTarget", chatId] as const,
  runManualRung: (chatId: string) =>
    ["chat.fallback.runManualRung", chatId] as const,
  returnToPreferred: (chatId: string) =>
    ["chat.fallback.returnToPreferred", chatId] as const,
};
