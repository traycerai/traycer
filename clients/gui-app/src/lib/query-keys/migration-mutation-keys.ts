/** Mutation keys for host migration RPCs. */
export const migrationMutationKeys = {
  migratePhaseToEpic: (phaseId: string) =>
    ["phase.migrateToEpic", phaseId] as const,
} as const;
