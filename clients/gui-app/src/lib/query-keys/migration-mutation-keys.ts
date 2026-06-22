/**
 * Mutation keys for host migration RPCs.
 *
 * Pre-cloud migration is now driven by the `migration.run@1.0` stream and
 * does not own a TanStack-Query mutation key (streams don't compose with
 * TanStack Query - see `use-migration-run-stream.ts`).
 */
export const migrationMutationKeys = {
  migratePhaseToEpic: (phaseId: string) =>
    ["phase.migrateToEpic", phaseId] as const,
} as const;
