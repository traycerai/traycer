export const managedCommandMutationKeys = {
  start: () => ["managedCommand.start"] as const,
  stop: () => ["managedCommand.stop"] as const,
  delete: () => ["managedCommand.delete"] as const,
};
