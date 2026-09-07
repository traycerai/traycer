/**
 * `worktree.deleteByPath@1.0` - versioned streaming-RPC contract for the host-wide worktree delete used by Settings ▸ Worktrees.
 * Degrade: a 1.0 host's open schema strips `stopOwners` and its `failed` frame has only `reason`; an old client that negotiated 1.0 never sees `holders`.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  holdersRevisionWireFieldSchema,
  worktreeBusyHoldersWireFieldSchema,
} from "@traycer/protocol/framework/worktree-busy-holders";
import {
  expectedHoldersRevisionFieldSchema,
  refineConsentRevisionRequiresStopOwners,
  worktreeEntryScriptsSchema,
} from "@traycer/protocol/host/worktree-schemas";

export const worktreeDeleteByPathOpenRequestSchema = z.object({
  worktreePath: z.string(),
  scripts: worktreeEntryScriptsSchema.nullable().default(null),
});
export type WorktreeDeleteByPathOpenRequest = z.infer<
  typeof worktreeDeleteByPathOpenRequestSchema
>;

export const worktreeDeleteByPathOpenRequestSchemaV11 =
  worktreeDeleteByPathOpenRequestSchema.extend({
    stopOwners: z.boolean().default(false),
  });
export type WorktreeDeleteByPathOpenRequestV11 = z.infer<
  typeof worktreeDeleteByPathOpenRequestSchemaV11
>;

/**
 * `worktree.deleteByPath@1.2` open request.
 * The existing digest and `stopOwners: true` parse constraints remain frozen.
 */
export const worktreeDeleteByPathOpenRequestSchemaV12 =
  worktreeDeleteByPathOpenRequestSchemaV11
    .extend({
      expectedHoldersRevision: expectedHoldersRevisionFieldSchema,
    })
    .superRefine(refineConsentRevisionRequiresStopOwners);
export type WorktreeDeleteByPathOpenRequestV12 = z.infer<
  typeof worktreeDeleteByPathOpenRequestSchemaV12
>;

const worktreeDeletePhaseSchema = z.enum(["teardown", "remove"]);
export type WorktreeDeletePhase = z.infer<typeof worktreeDeletePhaseSchema>;

const worktreeDeleteOutputChannelSchema = z.enum(["stdout", "stderr"]);
export type WorktreeDeleteOutputChannel = z.infer<
  typeof worktreeDeleteOutputChannelSchema
>;

export const worktreeDeleteByPathServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("started"),
      hasTeardown: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("phase"),
      phase: worktreeDeletePhaseSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("output"),
      channel: worktreeDeleteOutputChannelSchema,
      chunk: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("complete"),
      deleted: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("failed"),
      reason: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorktreeDeleteByPathServerFrame = z.infer<
  typeof worktreeDeleteByPathServerFrameSchema
>;

export const worktreeDeleteByPathClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorktreeDeleteByPathClientFrame = z.infer<
  typeof worktreeDeleteByPathClientFrameSchema
>;

export const worktreeDeleteByPathStreamV10 = defineStreamRpcContract({
  method: "worktree.deleteByPath",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: worktreeDeleteByPathOpenRequestSchema,
  serverFrameSchema: worktreeDeleteByPathServerFrameSchema,
  clientFrameSchema: worktreeDeleteByPathClientFrameSchema,
});

export const worktreeDeleteByPathServerFrameSchemaV11 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("started"),
      hasTeardown: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("phase"),
      phase: worktreeDeletePhaseSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("output"),
      channel: worktreeDeleteOutputChannelSchema,
      chunk: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("complete"),
      deleted: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("failed"),
      reason: z.string(),
      holders: worktreeBusyHoldersWireFieldSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorktreeDeleteByPathServerFrameV11 = z.infer<
  typeof worktreeDeleteByPathServerFrameSchemaV11
>;

export const worktreeDeleteByPathStreamV11 = defineStreamRpcContract({
  method: "worktree.deleteByPath",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: worktreeDeleteByPathOpenRequestSchemaV11,
  serverFrameSchema: worktreeDeleteByPathServerFrameSchemaV11,
  clientFrameSchema: worktreeDeleteByPathClientFrameSchema,
});

export const worktreeDeleteByPathServerFrameSchemaV12 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("started"),
      hasTeardown: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("phase"),
      phase: worktreeDeletePhaseSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("output"),
      channel: worktreeDeleteOutputChannelSchema,
      chunk: z.string(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("complete"),
      deleted: z.boolean(),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("failed"),
      reason: z.string(),
      holders: worktreeBusyHoldersWireFieldSchema,
      holdersRevision: holdersRevisionWireFieldSchema,
      code: z
        .enum(["WORKTREE_BUSY", "WORKTREE_HOLDERS_CHANGED"])
        .optional()
        .catch(undefined),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type WorktreeDeleteByPathServerFrameV12 = z.infer<
  typeof worktreeDeleteByPathServerFrameSchemaV12
>;

export const worktreeDeleteByPathStreamV12 = defineStreamRpcContract({
  method: "worktree.deleteByPath",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: worktreeDeleteByPathOpenRequestSchemaV12,
  serverFrameSchema: worktreeDeleteByPathServerFrameSchemaV12,
  clientFrameSchema: worktreeDeleteByPathClientFrameSchema,
});
