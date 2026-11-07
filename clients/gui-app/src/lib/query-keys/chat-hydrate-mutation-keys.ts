/**
 * Mutation key for asking a chat's host to bring back the records it dropped.
 * Keyed per host and chat: two tiles of different chats ask independently.
 */
export const chatHydrateMutationKeys = {
  hydrate: (hostId: string, chatId: string) =>
    ["epic.hydrateChat", hostId, chatId] as const,
};
