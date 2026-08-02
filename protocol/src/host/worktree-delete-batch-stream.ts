/**
 * `worktree.deleteBatchByPath@1.0` - one host-owned deletion COMMAND over N
 * approved targets.
 *
 * Added rather than growing `worktree.deleteByPath@1.0`, whose request and
 * frames are released and frozen. The two differ in ownership, not in
 * mechanism: the released stream is one target whose lifetime is the socket's,
 * while a command here is minted by the client, owned by the host, and
 * survives its observer. That is what lets the host aggregate N targets into
 * ONE durable completion notification - a renderer-side queue of N streams
 * cannot, because it has no identity the host can attribute the summary to.
 *
 * ## Start versus observe
 *
 * The open request is a discriminated union, and that discriminant is the
 * whole replay-safety story for a destructive operation.
 *
 * `WsStreamClient` re-sends a session's ORIGINAL open request on every
 * reconnect, automatically and indefinitely. Single-flight alone cannot make
 * that safe: the map is process-local and evicted a minute after completion,
 * so an outage longer than the grace window - or a host restart - would turn
 * an automatic re-subscribe into a second execution of the same `commandId`,
 * and its result would overwrite the durable summary the first run wrote.
 *
 * So the authority to START work lives in the request itself: only a `start`
 * may create a command, and a client only ever issues one from an explicit
 * user action. Once a `start` has actually reached the host, the client
 * re-subscribes as `observe`, which can attach to a live command but can never
 * create one. A command the host no longer knows about (evicted, or lost to a
 * restart) answers `command.failed` - honest uncertainty, no deletion.
 *
 * This is deliberately NOT keyed off the completion notification row: policy
 * can suppress that row and the sink write can fail, so it is not an execution
 * ledger.
 *
 * ## Command semantics (enforced by `WorktreeDeletionCommandService`)
 *
 * - `commandId` is a client-minted UUID. Commands are single-flight by
 *   `(userId, commandId)` for the host process lifetime, so a duplicate
 *   subscribe during the bounded grace window ATTACHES to the running command
 *   instead of executing it a second time. There is no cross-restart
 *   exactly-once claim: an unconfirmed destructive result stays uncertain and
 *   needs explicit user action.
 * - Closing the socket detaches that observer. It does NOT cancel accepted
 *   work: remaining targets run and the completion notification is still
 *   written. This is the whole point of host ownership - a Settings tab closed
 *   mid-bulk-delete must not strand half the selection.
 * - An empty `targets` list is not a command: the resolver answers
 *   `command.complete` with zero counts, creates no command, and writes no
 *   notification row.
 * - Per-target frames are NOT replayed to an observer that attached late, so a
 *   client that missed some must treat `command.complete` as terminal for
 *   every target it never saw settle.
 *
 * Server frames are tagged by `worktreePath`, the target's own stable key.
 * Requests carry unique paths (the schema rejects duplicates), so a path
 * identifies exactly one target for the command's lifetime and a client can
 * route a frame to its per-target record without minting a parallel id space.
 *
 * - `target.started`  - target validated and not busy; `hasTeardown` says
 *                       whether a teardown step will run.
 * - `target.phase`    - `teardown` | `remove`.
 * - `target.output`   - a chunk of teardown stdout/stderr.
 * - `target.complete` - terminal for that target; `deleted` is its outcome
 *                       (a declined/no-op delete is `false`, not a failure).
 * - `target.failed`   - terminal for that target; displayable reason.
 * - `command.complete`- terminal for the COMMAND, after every target settled.
 * - `command.failed`  - terminal: no work ran or will run UNDER THIS
 *                       SUBSCRIPTION, with a displayable reason. Either the
 *                       host cannot serve the command at all (worktree service
 *                       unavailable), or an `observe` named a command this host
 *                       no longer holds. No target frames precede it.
 * - `pong`            - heartbeat response.
 *
 * Client frames: `ping` only, like the released stream.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { worktreeEntryScriptsSchema } from "@traycer/protocol/host/worktree-schemas";

/**
 * Where the command came from. Durable: it rides into the notification
 * payload, so the row can say "a bulk delete you started in Settings" without
 * persisting a route. Closed on purpose - an unrecognized source is a client
 * bug, not a compatibility event, and every producer is in this repo.
 */
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
  /**
   * Per-target script override from the Settings review modal. `null` means
   * "read the worktree's own `.traycer/environment.json`", matching the
   * released single-target request.
   */
  scripts: worktreeEntryScriptsSchema.nullable(),
});
export type WorktreeDeleteBatchTarget = z.infer<
  typeof worktreeDeleteBatchTargetSchema
>;

/**
 * Client-minted UUID naming a command. Validated as a UUID rather than an open
 * string so a client cannot collapse distinct commands onto a shared constant
 * and have the single-flight map silently attach the second one to the first's
 * already-finished result.
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
      /**
       * Every approved target, in one request. Paths must be unique: the frame
       * tagging keys off `worktreePath`, and a repeated path would make two
       * target records indistinguishable on the wire (and schedule the same
       * directory twice).
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
     * Re-attaches to a command already accepted by this host process. Carries
     * NO targets on purpose: an observe request that cannot describe work is
     * structurally incapable of starting any, however it is routed or replayed.
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
