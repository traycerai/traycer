/**
 * `managedCommand.subscribeList@1.0` - The managed-command output stream - the transport half of the "Monitors & Shells" surface described in the host's `domain/managed-command/UI.md`.
 * A brand-new method, deliberately off the released floor.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  managedCommandSchema,
  managedCommandSchemaPreRelaunch,
} from "@traycer/protocol/host/managed-command/unary-schemas";

/** Ceiling on one `loadOlder` window. */
export const MANAGED_COMMAND_MAX_WINDOW_LINES = 2_000;

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

// ─── `managedCommand.subscribeOutput@1.0` ───────────────────────────────────

/**
 * A cursor into the rolling log: a segment named by a rotation-stable identity plus a byte offset into it.
 */
export const managedCommandLogPositionSchema = z.object({
  segmentId: z.string(),
  byteOffset: z.number().int().nonnegative(),
});
export type ManagedCommandLogPosition = z.infer<
  typeof managedCommandLogPositionSchema
>;

/** One row of the timeline. */
export const managedCommandLogLineSchema = z.object({
  channel: z.enum(["stdout", "stderr", "lifecycle"]),
  text: z.string(),
  atMs: z.number().nullable(),
});
export type ManagedCommandLogLine = z.infer<typeof managedCommandLogLineSchema>;

export const managedCommandSubscribeOutputOpenRequestSchema = z.object({
  // Named so the host can scope exactly as the id-addressed controls do: a
  // command in another epic is refused as one that never existed.
  epicId: z.string(),
  commandId: z.string(),
});
export type ManagedCommandSubscribeOutputOpenRequest = z.infer<
  typeof managedCommandSubscribeOutputOpenRequestSchema
>;

/** The server frames, parameterized on the command shape the `snapshot` and `status` headers carry. */
function managedCommandSubscribeOutputServerFrames<
  TCommand extends z.ZodTypeAny,
>(commandSchema: TCommand) {
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      command: commandSchema,
      /** The opening tail, oldest line first. */
      lines: z.array(managedCommandLogLineSchema),
      /** Where `lines` begin - hand it back on `loadOlder` to page up. */
      start: managedCommandLogPositionSchema,
      /** Nothing older than `start` is retained; the viewer stops asking. */
      reachedStart: z.boolean(),
    }),
    // Lines appended since the last frame, oldest first.
    z.object({
      kind: z.literal("output"),
      ...textFrameFields,
      lines: z.array(managedCommandLogLineSchema),
      start: managedCommandLogPositionSchema,
    }),
    z.object({
      kind: z.literal("older"),
      ...textFrameFields,
      /** Echoes the `loadOlder` that asked, so an outrun request can be dropped. */
      requestId: z.string(),
      lines: z.array(managedCommandLogLineSchema),
      start: managedCommandLogPositionSchema,
      reachedStart: z.boolean(),
    }),
    // The command's own state moved (started, stopped, exited).
    z.object({
      kind: z.literal("status"),
      ...textFrameFields,
      command: commandSchema,
    }),
    // The command was deleted: its row, process and entire output history are gone.
    z.object({
      kind: z.literal("deleted"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
}

/** The live (`@1.1`) frames: headers carry `relaunchOnHostRestart`. */
export const managedCommandSubscribeOutputServerFrameSchema =
  managedCommandSubscribeOutputServerFrames(managedCommandSchema);
export type ManagedCommandSubscribeOutputServerFrame = z.infer<
  typeof managedCommandSubscribeOutputServerFrameSchema
>;

/** The shipped (`@1.0`) frames: headers carry the pre-relaunch command. */
export const managedCommandSubscribeOutputServerFrameSchemaV10 =
  managedCommandSubscribeOutputServerFrames(managedCommandSchemaPreRelaunch);
export type ManagedCommandSubscribeOutputServerFrameV10 = z.infer<
  typeof managedCommandSubscribeOutputServerFrameSchemaV10
>;

export const managedCommandSubscribeOutputClientFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("loadOlder"),
      ...textFrameFields,
      requestId: z.string(),
      /** The oldest position the viewer holds; it gets the window before it. */
      before: managedCommandLogPositionSchema,
      maxLines: z
        .number()
        .int()
        .positive()
        .max(MANAGED_COMMAND_MAX_WINDOW_LINES),
    }),
    // Re-base a viewer that deliberately detached from live output while reading history.
    z.object({
      kind: z.literal("resnapshot"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type ManagedCommandSubscribeOutputClientFrame = z.infer<
  typeof managedCommandSubscribeOutputClientFrameSchema
>;

export const managedCommandSubscribeOutputV10 = defineStreamRpcContract({
  method: "managedCommand.subscribeOutput",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: managedCommandSubscribeOutputOpenRequestSchema,
  serverFrameSchema: managedCommandSubscribeOutputServerFrameSchemaV10,
  clientFrameSchema: managedCommandSubscribeOutputClientFrameSchema,
});

// ─── `managedCommand.subscribeOutput@1.1` ───────────────────────────────────

export const managedCommandSubscribeOutputV11 = defineStreamRpcContract({
  method: "managedCommand.subscribeOutput",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: managedCommandSubscribeOutputOpenRequestSchema,
  serverFrameSchema: managedCommandSubscribeOutputServerFrameSchema,
  clientFrameSchema: managedCommandSubscribeOutputClientFrameSchema,
});
