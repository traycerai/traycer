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
  updateReplyMode: () => ["bot.updateReplyMode"] as const,
  setNotificationLevel: () => ["bot.notificationLevel.set"] as const,
  delete: () => ["bot.delete"] as const,
  open: () => ["bot.open"] as const,
  conversationSend: () => ["bot.conversation.send"] as const,
  onboardingChoose: () => ["bot.onboarding.choose"] as const,
  onboardingComplete: () => ["bot.onboarding.complete"] as const,
  taskRunNow: () => ["bot.task.runNow"] as const,
  taskSetPaused: () => ["bot.task.setPaused"] as const,
  taskStop: () => ["bot.task.stop"] as const,
  notificationsStop: () => ["bot.notifications.stop"] as const,
};
