/**
 * Mutation keys for the `bot.*` and `environment.*` host methods (Tracy Bots).
 * One builder per write so a surface's pending state can be read back by key
 * (`useIsMutating`) rather than by a flag of its own.
 */
export const botMutationKeys = {
  create: () => ["bot.create"] as const,
  updateTitle: () => ["bot.updateTitle"] as const,
  updateRunSettings: () => ["bot.updateRunSettings"] as const,
  delete: () => ["bot.delete"] as const,
  open: () => ["bot.open"] as const,
  conversationSend: () => ["bot.conversation.send"] as const,
};

export const environmentMutationKeys = {
  hostBind: () => ["environment.host.bind"] as const,
};
