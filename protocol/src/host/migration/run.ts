/**
 * `migration.run@1.0` - versioned streaming-RPC contract for the
 * pre-cloud → cloud migration run.
 *
 * Subscribing kicks off `PreCloudMigrationService.migrateLocalToCloud()`
 * on the host. The host emits per-entity progress frames and a terminal
 * `complete` frame when the run finishes (successfully or not).
 * Cancellation is implicit: closing the WS aborts the connection-
 * scoped `RequestContext`, which the migration loop's
 * `assertRequestContextUsable(ctx)` guard observes on the next iteration.
 * Pending state is left in `PendingUpdateStore` for the next retry.
 *
 * `userId` is inferred from the host authentication context, so the
 * open request carries no parameters.
 *
 * Server frames:
 *
 * - `started`           - emitted once at the start; carries totals.
 * - `taskChainProgress` - emitted once per task chain after the per-
 *                         chain migration completes.
 * - `epicProgress`      - emitted once per local epic after the per-
 *                         epic migration completes.
 * - `replayProgress`    - emitted once per pending-replay attempt
 *                         (chain or epic).
 * - `complete`          - terminal frame; carries the aggregate
 *                         success flag and per-bucket counts.
 * - `pong`              - heartbeat response.
 *
 * Client frames:
 *
 * - `ping` - heartbeat. No application client frames.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

export const migrationRunOpenRequestSchema = z.object({});
export type MigrationRunOpenRequest = z.infer<
  typeof migrationRunOpenRequestSchema
>;

const taskChainOutcomeSchema = z.enum(["complete", "skipped", "failed"]);
const epicOutcomeSchema = z.enum(["complete", "failed"]);
const replayEntityKindSchema = z.enum(["chain", "epic"]);

const migrationCompleteCountsSchema = z.object({
  taskChainsComplete: z.number().int().nonnegative(),
  taskChainsSkipped: z.number().int().nonnegative(),
  taskChainsFailed: z.number().int().nonnegative(),
  epicsComplete: z.number().int().nonnegative(),
  epicsFailed: z.number().int().nonnegative(),
  replaysIncomplete: z.number().int().nonnegative(),
});
export type MigrationCompleteCounts = z.infer<
  typeof migrationCompleteCountsSchema
>;

export const migrationRunServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    totalTaskChains: z.number().int().nonnegative(),
    totalLocalEpics: z.number().int().nonnegative(),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("taskChainProgress"),
    chainId: z.string(),
    index: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    outcome: taskChainOutcomeSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("epicProgress"),
    epicId: z.string(),
    index: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    outcome: epicOutcomeSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("replayProgress"),
    entityId: z.string(),
    entityKind: replayEntityKindSchema,
    required: z.boolean(),
    completed: z.boolean(),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("complete"),
    success: z.boolean(),
    counts: migrationCompleteCountsSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type MigrationRunServerFrame = z.infer<
  typeof migrationRunServerFrameSchema
>;

export const migrationRunClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ping"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type MigrationRunClientFrame = z.infer<
  typeof migrationRunClientFrameSchema
>;

export const migrationRunV10 = defineStreamRpcContract({
  method: "migration.run",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: migrationRunOpenRequestSchema,
  serverFrameSchema: migrationRunServerFrameSchema,
  clientFrameSchema: migrationRunClientFrameSchema,
});
