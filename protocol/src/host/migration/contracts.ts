import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  migratePhaseToEpicRequestSchema,
  migratePhaseToEpicResponseSchema,
} from "@traycer/protocol/host/migration/unary-schemas";
import { migrationRunV10 } from "@traycer/protocol/host/migration/run";

export const phaseMigrateToEpicV10 = defineRpcContract({
  method: "phase.migrateToEpic",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: migratePhaseToEpicRequestSchema,
  responseSchema: migratePhaseToEpicResponseSchema,
});

export { migrationRunV10 };
