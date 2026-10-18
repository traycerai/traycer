/**
 * Mutation keys for the `bot.*` host methods (Tracy Bots); `environment.host.bind`
 * lives with the other `environment.*` writes in `environment-mutation-keys`.
 * One builder per write so a surface's pending state can be read back by key
 * (`useIsMutating`) rather than by a flag of its own.
 */
export const botMutationKeys = {
  create: () => ["bot.create"] as const,
  updateTitle: () => ["bot.updateTitle"] as const,
  updateRunSettings: () => ["bot.updateRunSettings"] as const,
  delete: () => ["bot.delete"] as const,
  claimAuthority: () => ["bot.claimAuthority"] as const,
  conversationSend: () => ["bot.conversation.send"] as const,
};
