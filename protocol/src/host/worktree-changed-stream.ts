import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Where a subscriber stands in the host's stream of worktree changes.
 *
 * `epoch` names one run of the host's broadcaster and changes on every host
 * restart; `generation` counts every change that broadcaster was asked to
 * publish in that run - including one its same-scope window swallowed, so a
 * cursor that still equals the host's current one proves nothing changed.
 * Opaque to the client: it only ever hands back the last cursor it received.
 */
export const worktreeChangedCursorSchema = lazySchema(() =>
  z.object({
    epoch: z.string(),
    generation: z.number().int().nonnegative(),
  }),
);
export type WorktreeChangedCursor = z.infer<typeof worktreeChangedCursorSchema>;

// ─── Frozen `worktree.changed@1.0` ──────────────────────────────────────────
//
// Their own literal objects, which the live line below extends, so growing the
// live line cannot reach the released one by accident.

export const worktreeChangedOpenRequestSchemaV10 = lazySchema(() =>
  z.object({}),
);
export type WorktreeChangedOpenRequestV10 = z.infer<
  typeof worktreeChangedOpenRequestSchemaV10
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

const worktreeChangedPongFrameSchema = lazySchema(() =>
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
);

export const worktreeChangedServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      scope: worktreeChangedScopeSchema,
      hasBinaryPayload: z.literal(false),
    }),
    worktreeChangedPongFrameSchema,
  ]),
);
export type WorktreeChangedServerFrameV10 = z.infer<
  typeof worktreeChangedServerFrameSchemaV10
>;

// ─── Live `worktree.changed@1.1` ────────────────────────────────────────────
//
// A (re)subscribe used to be answered with an unconditional root catch-up
// frame, which makes the client refetch every worktree key - on every
// reconnect of every client, whether or not anything had changed. `@1.1` lets
// the client hand back the cursor of the last frame it received, and the host
// skips the catch-up when that cursor is still current.
//
// Both directions stay compatible: a `@1.0` peer on either side negotiates
// `@1.0`, where there is no cursor and the catch-up is always sent.

export const worktreeChangedOpenRequestSchema = lazySchema(() =>
  worktreeChangedOpenRequestSchemaV10.extend({
    /**
     * The cursor of the last `changed` frame this client received from this
     * host, if any. Absent on a first subscribe; absence (not `null`) is the
     * wire encoding of "no cursor", as with `epic.subscribe`'s `seedOffer`.
     */
    resume: worktreeChangedCursorSchema.optional(),
  }),
);
export type WorktreeChangedOpenRequest = z.infer<
  typeof worktreeChangedOpenRequestSchema
>;

export const worktreeChangedServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      scope: worktreeChangedScopeSchema,
      /** The host's cursor as of this frame; the client's next `resume`. */
      cursor: worktreeChangedCursorSchema,
      hasBinaryPayload: z.literal(false),
    }),
    worktreeChangedPongFrameSchema,
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
  openRequestSchema: worktreeChangedOpenRequestSchemaV10,
  serverFrameSchema: worktreeChangedServerFrameSchemaV10,
  clientFrameSchema: worktreeChangedClientFrameSchema,
});

export const worktreeChangedV11 = defineStreamRpcContract({
  method: "worktree.changed",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: worktreeChangedOpenRequestSchema,
  serverFrameSchema: worktreeChangedServerFrameSchema,
  clientFrameSchema: worktreeChangedClientFrameSchema,
});
