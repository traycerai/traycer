/**
 * `worktree.deleteBatchByPath@1.0` - one host-owned deletion COMMAND over N approved targets.
 * Added rather than growing `worktree.deleteByPath@1.0`, whose request and frames are released and frozen.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { worktreeBusyHoldersWireFieldSchema } from "@traycer/protocol/framework/worktree-busy-holders";
import { worktreeEntryScriptsSchema } from "@traycer/protocol/host/worktree-schemas";

/** Where the command came from. */
export const worktreeDeletionSourceSchema = z.enum([
  "settings",
  "task_cleanup",
  "task_sweep",
  "cli",
  "legacy_client",
]);
export type WorktreeDeletionSource = z.infer<
  typeof worktreeDeletionSourceSchema
>;

export const worktreeDeleteBatchTargetSchema = z.object({
  worktreePath: z.string().min(1),
  /** Per-target script override from the Settings review modal. */
  scripts: worktreeEntryScriptsSchema.nullable(),
});
export type WorktreeDeleteBatchTarget = z.infer<
  typeof worktreeDeleteBatchTargetSchema
>;

/** `worktree.deleteBatchByPath@1.1` target. */
export const worktreeDeleteBatchTargetSchemaV11 =
  worktreeDeleteBatchTargetSchema.extend({
    stopOwners: z.boolean().default(false),
  });
export type WorktreeDeleteBatchTargetV11 = z.infer<
  typeof worktreeDeleteBatchTargetSchemaV11
>;

/**
 * Client-minted UUID naming a command.
 * Validated as a UUID rather than an open string so a client cannot collapse distinct commands onto a shared constant and have the single-flight map silently attach the second one to the first's already-finished result.
 */
const commandIdSchema = z.uuid();

export const worktreeDeleteBatchByPathOpenRequestSchema = z.discriminatedUnion(
  "mode",
  [
    /**
     * Authorizes execution. Only ever sent for an explicit user action, and
     * never re-sent automatically after it has reached the host.
     */
    z.object({
      mode: z.literal("start"),
      commandId: commandIdSchema,
      source: worktreeDeletionSourceSchema,
      /** Task that initiated a single-Task sweep. Absent when there is no
       * single durable Task destination for the completion notification. */
      epicId: z.string().min(1).optional(),
      /**
       * Every approved target, in one request.
       * Paths must be unique: the frame tagging keys off `worktreePath`, and a repeated path would make two target records indistinguishable on the wire (and schedule the same directory twice).
       */
      targets: z
        .array(worktreeDeleteBatchTargetSchema)
        .refine(
          (targets) =>
            new Set(targets.map((target) => target.worktreePath)).size ===
            targets.length,
          { message: "targets must have unique worktreePath values" },
        ),
    }),
    /**
     * Re-attaches to a command already accepted by this host process.
     * Carries NO targets on purpose: an observe request that cannot describe work is structurally incapable of starting any, however it is routed or replayed.
     */
    z.object({
      mode: z.literal("observe"),
      commandId: commandIdSchema,
    }),
  ],
);
export type WorktreeDeleteBatchByPathOpenRequest = z.infer<
  typeof worktreeDeleteBatchByPathOpenRequestSchema
>;

/** Frozen @1.1 open-request schema. */
export const worktreeDeleteBatchByPathOpenRequestSchemaV11 =
  z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("start"),
      commandId: commandIdSchema,
      source: worktreeDeletionSourceSchema,
      epicId: z.string().min(1).optional(),
      targets: z
        .array(worktreeDeleteBatchTargetSchemaV11)
        .refine(
          (targets) =>
            new Set(targets.map((target) => target.worktreePath)).size ===
            targets.length,
          { message: "targets must have unique worktreePath values" },
        ),
    }),
    z.object({
      mode: z.literal("observe"),
      commandId: commandIdSchema,
    }),
  ]);
export type WorktreeDeleteBatchByPathOpenRequestV11 = z.infer<
  typeof worktreeDeleteBatchByPathOpenRequestSchemaV11
>;

const worktreeDeleteBatchPhaseSchema = z.enum(["teardown", "remove"]);
export type WorktreeDeleteBatchPhase = z.infer<
  typeof worktreeDeleteBatchPhaseSchema
>;

const worktreeDeleteBatchOutputChannelSchema = z.enum(["stdout", "stderr"]);
export type WorktreeDeleteBatchOutputChannel = z.infer<
  typeof worktreeDeleteBatchOutputChannelSchema
>;

export const worktreeDeleteBatchByPathServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("target.started"),
      worktreePath: z.string().min(1),
      hasTeardown: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.phase"),
      worktreePath: z.string().min(1),
      phase: worktreeDeleteBatchPhaseSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.output"),
      worktreePath: z.string().min(1),
      channel: worktreeDeleteBatchOutputChannelSchema,
      chunk: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.complete"),
      worktreePath: z.string().min(1),
      deleted: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.failed"),
      worktreePath: z.string().min(1),
      reason: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("command.complete"),
      requestedCount: z.number().int().nonnegative(),
      deletedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("command.failed"),
      reason: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorktreeDeleteBatchByPathServerFrame = z.infer<
  typeof worktreeDeleteBatchByPathServerFrameSchema
>;

/** Frozen @1.1 server frames. */
export const worktreeDeleteBatchByPathServerFrameSchemaV11 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("target.started"),
      worktreePath: z.string().min(1),
      hasTeardown: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.phase"),
      worktreePath: z.string().min(1),
      phase: worktreeDeleteBatchPhaseSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.output"),
      worktreePath: z.string().min(1),
      channel: worktreeDeleteBatchOutputChannelSchema,
      chunk: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.complete"),
      worktreePath: z.string().min(1),
      deleted: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("target.failed"),
      worktreePath: z.string().min(1),
      reason: z.string(),
      holders: worktreeBusyHoldersWireFieldSchema,
      code: z.literal("WORKTREE_BUSY").optional().catch(undefined),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("command.complete"),
      requestedCount: z.number().int().nonnegative(),
      deletedCount: z.number().int().nonnegative(),
      failedCount: z.number().int().nonnegative(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("command.failed"),
      reason: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]);
export type WorktreeDeleteBatchByPathServerFrameV11 = z.infer<
  typeof worktreeDeleteBatchByPathServerFrameSchemaV11
>;

export const worktreeDeleteBatchByPathClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorktreeDeleteBatchByPathClientFrame = z.infer<
  typeof worktreeDeleteBatchByPathClientFrameSchema
>;

export const worktreeDeleteBatchByPathStreamV10 = defineStreamRpcContract({
  method: "worktree.deleteBatchByPath",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: worktreeDeleteBatchByPathOpenRequestSchema,
  serverFrameSchema: worktreeDeleteBatchByPathServerFrameSchema,
  clientFrameSchema: worktreeDeleteBatchByPathClientFrameSchema,
});

export const worktreeDeleteBatchByPathStreamV11 = defineStreamRpcContract({
  method: "worktree.deleteBatchByPath",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: worktreeDeleteBatchByPathOpenRequestSchemaV11,
  serverFrameSchema: worktreeDeleteBatchByPathServerFrameSchemaV11,
  clientFrameSchema: worktreeDeleteBatchByPathClientFrameSchema,
});
