import { z } from "zod";

export const migratePhaseToEpicRequestSchema = z.object({
  phaseId: z.string(),
});

export const migratePhaseToEpicResponseSchema = z.object({
  epicId: z.string(),
});

export type MigratePhaseToEpicRequest = z.infer<
  typeof migratePhaseToEpicRequestSchema
>;

export type MigratePhaseToEpicResponse = z.infer<
  typeof migratePhaseToEpicResponseSchema
>;
