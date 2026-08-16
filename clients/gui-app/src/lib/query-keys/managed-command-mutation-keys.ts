export const managedCommandMutationKeys = {
  start: () => ["managedCommand.start"] as const,
  stop: () => ["managedCommand.stop"] as const,
  // Scoped to the chat whose batch it is: the shared pending read exists for
  // the same chat open in two tiles, and an app-wide key would let one chat's
  // batch disable every other chat's button.
  stopAll: (chatId: string) => ["managedCommand.stopAll", chatId] as const,
  delete: () => ["managedCommand.delete"] as const,
  // Chat-scoped for the same reason `stopAll` is, and for a sharper one: a
  // Deliver with no ids named releases EVERY hold the chat owns, so two
  // in-flight Delivers for one chat are the same action twice. The shared
  // pending read is what stops a second tile re-sending it.
  deliverHeld: (chatId: string) =>
    ["managedCommand.deliverHeld", chatId] as const,
};
