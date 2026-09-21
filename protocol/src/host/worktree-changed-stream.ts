import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const worktreeChangedOpenRequestSchema = lazySchema(() => z.object({}));
export type WorktreeChangedOpenRequest = z.infer<
  typeof worktreeChangedOpenRequestSchema
>;

export const worktreeChangedScopeSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("worktreePath"),
      worktreePath: z.string(),
    }),
    z.object({
      kind: z.literal("root"),
      root: z.string(),
    }),
  ]),
);
export type WorktreeChangedScope = z.infer<typeof worktreeChangedScopeSchema>;

export const worktreeChangedServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      scope: worktreeChangedScopeSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type WorktreeChangedServerFrame = z.infer<
  typeof worktreeChangedServerFrameSchema
>;

export const worktreeChangedClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type WorktreeChangedClientFrame = z.infer<
  typeof worktreeChangedClientFrameSchema
>;

export const worktreeChangedV10 = defineStreamRpcContract({
  method: "worktree.changed",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: worktreeChangedOpenRequestSchema,
  serverFrameSchema: worktreeChangedServerFrameSchema,
  clientFrameSchema: worktreeChangedClientFrameSchema,
});
