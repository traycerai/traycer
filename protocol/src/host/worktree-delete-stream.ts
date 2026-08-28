/**
 * `worktree.deleteByPath@1.0` - versioned streaming-RPC contract for the
 * host-wide worktree delete used by Settings ▸ Worktrees.
 *
 * Subscribing kicks off the path-keyed delete pipeline on the host
 * (busy-check → teardown → `git worktree remove --force` + prune). The
 * teardown script's stdout/stderr stream live as `output` frames so the
 * Settings modal can show the actual output, and `phase` frames drive a
 * migration-style progress indicator (teardown → remove). A terminal
 * `complete` frame carries the final `deleted` flag; `failed` carries a
 * reason when the host declines before/while removing (e.g. the worktree
 * is in use by an active chat/agent).
 *
 * The target `worktreePath` is the only open-request parameter; the host
 * resolves the main repo from it (or from a recorded binding when the
 * worktree's `.git` gitlink was manually broken).
 *
 * Server frames:
 *
 * - `started`  - emitted once the target is validated and not busy; carries
 *                `hasTeardown` so the renderer knows whether to show a
 *                teardown step.
 * - `phase`    - emitted when the pipeline advances (`teardown` | `remove`).
 * - `output`   - a chunk of teardown stdout/stderr.
 * - `complete` - terminal frame; carries the final `deleted` flag.
 * - `failed`   - terminal frame; carries a human-readable reason (busy,
 *                unexpected error). The socket stays open so the client
 *                renders it before tearing down. `@1.1` may also carry
 *                `holders` when the refusal is a busy inventory (the stream
 *                twin of unary `WORKTREE_BUSY`).
 *
 * `worktree.deleteByPath@1.1` adds open-request `stopOwners` (absent/false
 * ⇒ today's refuse-on-busy) and optional `holders` on `failed`. Degrade: a
 * 1.0 host's open schema strips `stopOwners` and its `failed` frame has
 * only `reason`; an old client that negotiated 1.0 never sees `holders`.
 * Malformed `holders` on a 1.1 `failed` frame are sanitized to absent so
 * the terminal `reason` still arrives.
 * - `pong`     - heartbeat response.
 *
 * Client frames:
 *
 * - `ping` - heartbeat. No application client frames.
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
 * `worktree.deleteByPath@1.2` open request. `expectedHoldersRevision`
 * matches unary `worktree.delete@1.2`: present with `stopOwners: true`
 * is a digest-equality compare against the fresh inventory before
 * teardown. Absent reproduces @1.1. Present-empty, non-digest, and
 * revision-with-stopOwners-false fail parse.
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

/**
 * @1.2 failed frames may carry the unary refusal `code` so a current
 * GUI can distinguish `WORKTREE_HOLDERS_CHANGED` from `WORKTREE_BUSY`
 * without parsing `reason`. Absent on a 1.1 host; a 1.1 client schema
 * strips it.
 */
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
      code: z.enum(["WORKTREE_BUSY", "WORKTREE_HOLDERS_CHANGED"]).optional(),
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
