export const managedCommandMutationKeys = {
  start: () => ["managedCommand.start"] as const,
  stop: () => ["managedCommand.stop"] as const,
  // Scoped to the chat whose batch it is: the shared pending read exists for
  // the same chat open in two tiles, and an app-wide key would let one chat's
  // batch disable every other chat's button.
  stopAll: (chatId: string) => ["managedCommand.stopAll", chatId] as const,
  delete: () => ["managedCommand.delete"] as const,
};
