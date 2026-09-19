import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const migratePhaseToEpicRequestSchema = lazySchema(() =>
  z.object({
    phaseId: z.string(),
  }),
);

export const migratePhaseToEpicResponseSchema = lazySchema(() =>
  z.object({
    epicId: z.string(),
  }),
);

export type MigratePhaseToEpicRequest = z.infer<
  typeof migratePhaseToEpicRequestSchema
>;

export type MigratePhaseToEpicResponse = z.infer<
  typeof migratePhaseToEpicResponseSchema
>;
