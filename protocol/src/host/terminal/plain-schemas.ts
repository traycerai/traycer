/**
 * Durable plain-terminal wire projections and unary request/response schemas.
 *
 * This is deliberately a separate `terminal.plain.*` family. The released
 * generic `terminal.*` family also carries terminal-agent sessions and cannot
 * be canonicalized into a durable plain-terminal record without inventing
 * host identity and revision data that its old wire shapes never carried.
 *
 * Request objects are strict at every level that accepts client-authored data.
 * In particular, clients cannot supply ownership, an environment, or a
 * resolved shell executable. The host derives those values from the
 * authenticated request and its own configuration.
 */
import { z } from "zod";
import { isoMillisecondTimestampSchema } from "@traycer/protocol/common/schemas";

export const plainTerminalScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("epic"),
    epicId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("independent") }),
]);
export type PlainTerminalScope = z.infer<typeof plainTerminalScopeSchema>;

/** Host-resolved launch definition. It is output-only on the public surface. */
export const plainTerminalLaunchSchema = z.strictObject({
  cwd: z.string().min(1),
  shellCommand: z.string().min(1),
  shellArgs: z.array(z.string()),
});
export type PlainTerminalLaunch = z.infer<typeof plainTerminalLaunchSchema>;

/**
 * Durable logical record. `ownerUserId` and internal persistence keys are
 * intentionally absent; authorization comes from the request context.
 */
export const plainTerminalRecordSchema = z.strictObject({
  terminalId: z.string().min(1),
  hostId: z.string().min(1),
  scope: plainTerminalScopeSchema,
  launch: plainTerminalLaunchSchema,
  manualTitle: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: isoMillisecondTimestampSchema,
  updatedAt: isoMillisecondTimestampSchema,
});
export type PlainTerminalRecord = z.infer<typeof plainTerminalRecordSchema>;

export const dormantPlainTerminalRuntimeSchema = z.strictObject({
  status: z.literal("dormant"),
});
export type DormantPlainTerminalRuntime = z.infer<
  typeof dormantPlainTerminalRuntimeSchema
>;

/**
 * Live-only metadata. The logical launch cwd remains on the record while
 * `currentCwd` follows the running shell; a manual title never replaces the
 * independently reported foreground process.
 */
export const runningPlainTerminalRuntimeSchema = z.strictObject({
  status: z.literal("running"),
  // The first implementation intentionally keeps this equal to terminalId.
  sessionId: z.string().min(1),
  currentCwd: z.string().min(1),
  activeProcessName: z.string().nullable(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type RunningPlainTerminalRuntime = z.infer<
  typeof runningPlainTerminalRuntimeSchema
>;

export const plainTerminalRuntimeSchema = z.discriminatedUnion("status", [
  dormantPlainTerminalRuntimeSchema,
  runningPlainTerminalRuntimeSchema,
]);
export type PlainTerminalRuntime = z.infer<typeof plainTerminalRuntimeSchema>;

export const plainTerminalProjectionSchema = z
  .strictObject({
    record: plainTerminalRecordSchema,
    runtime: plainTerminalRuntimeSchema,
  })
  .superRefine((projection, ctx) => {
    if (
      projection.runtime.status === "running" &&
      projection.runtime.sessionId !== projection.record.terminalId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "sessionId"],
        message: "sessionId must equal the logical terminalId",
      });
    }
  });
export type PlainTerminalProjection = z.infer<
  typeof plainTerminalProjectionSchema
>;

export const runningPlainTerminalProjectionSchema = z
  .strictObject({
    record: plainTerminalRecordSchema,
    runtime: runningPlainTerminalRuntimeSchema,
  })
  .superRefine((projection, ctx) => {
    if (projection.runtime.sessionId !== projection.record.terminalId) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "sessionId"],
        message: "sessionId must equal the logical terminalId",
      });
    }
  });
export type RunningPlainTerminalProjection = z.infer<
  typeof runningPlainTerminalProjectionSchema
>;

const plainTerminalGridHintFields = {
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
} as const;

export const createPlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  scope: plainTerminalScopeSchema,
  cwd: z.string().min(1),
  ...plainTerminalGridHintFields,
});
export type CreatePlainTerminalRequest = z.infer<
  typeof createPlainTerminalRequestSchema
>;

export const createPlainTerminalResponseSchema = z.strictObject({
  terminal: runningPlainTerminalProjectionSchema,
});
export type CreatePlainTerminalResponse = z.infer<
  typeof createPlainTerminalResponseSchema
>;

export const listPlainTerminalsRequestSchema = z.strictObject({
  scope: plainTerminalScopeSchema,
});
export type ListPlainTerminalsRequest = z.infer<
  typeof listPlainTerminalsRequestSchema
>;

export const listPlainTerminalsResponseSchema = z.strictObject({
  terminals: z.array(plainTerminalProjectionSchema),
});
export type ListPlainTerminalsResponse = z.infer<
  typeof listPlainTerminalsResponseSchema
>;

export const renamePlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  manualTitle: z.string().nullable(),
});
export type RenamePlainTerminalRequest = z.infer<
  typeof renamePlainTerminalRequestSchema
>;

export const renamePlainTerminalResponseSchema = z.strictObject({
  terminal: plainTerminalProjectionSchema,
});
export type RenamePlainTerminalResponse = z.infer<
  typeof renamePlainTerminalResponseSchema
>;

export const ensurePlainTerminalRunningRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  ...plainTerminalGridHintFields,
});
export type EnsurePlainTerminalRunningRequest = z.infer<
  typeof ensurePlainTerminalRunningRequestSchema
>;

export const ensurePlainTerminalRunningResponseSchema = z.strictObject({
  terminal: runningPlainTerminalProjectionSchema,
});
export type EnsurePlainTerminalRunningResponse = z.infer<
  typeof ensurePlainTerminalRunningResponseSchema
>;

export const closePlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
});
export type ClosePlainTerminalRequest = z.infer<
  typeof closePlainTerminalRequestSchema
>;

/** The deletion revision orders a close against stale cached upserts. */
export const closePlainTerminalResponseSchema = z.strictObject({
  terminalId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type ClosePlainTerminalResponse = z.infer<
  typeof closePlainTerminalResponseSchema
>;

export const legacyPlainTerminalTitleSourceSchema = z.enum([
  "default",
  "manual",
]);
export type LegacyPlainTerminalTitleSource = z.infer<
  typeof legacyPlainTerminalTitleSourceSchema
>;

export const importLegacyPlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  // Legacy evidence includes the persisted binding. The resolver must compare
  // it with the current host rather than treating it as client-selected scope.
  hostId: z.string().min(1),
  scope: plainTerminalScopeSchema,
  cwd: z.string().min(1),
  name: z.string(),
  titleSource: legacyPlainTerminalTitleSourceSchema,
  sourceStoreVersion: z.number().int().nonnegative(),
});
export type ImportLegacyPlainTerminalRequest = z.infer<
  typeof importLegacyPlainTerminalRequestSchema
>;

export const importLegacyPlainTerminalResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("imported"),
      terminal: plainTerminalProjectionSchema,
    }),
    z.strictObject({
      status: z.literal("existing"),
      terminal: plainTerminalProjectionSchema,
    }),
    z.strictObject({
      status: z.literal("deleted"),
      terminalId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    }),
  ],
);
export type ImportLegacyPlainTerminalResponse = z.infer<
  typeof importLegacyPlainTerminalResponseSchema
>;
