/**
 * The two managed-command streams - the transport half of the "Monitors &
 * Shells" surface described in the host's `domain/managed-command/UI.md`.
 *
 * ## `managedCommand.subscribeList@1.0` - the directory
 *
 * One stream per EPIC, carrying every managed command in it regardless of which
 * chat created it. That scope is the point: finding a watcher must not require
 * remembering which chat made it. The stream is the list - nothing is persisted
 * client-side, so a `snapshot` followed by `changed`/`removed` is the whole
 * contract.
 *
 * ## `managedCommand.subscribeOutput@1.0` - the viewer
 *
 * One stream per COMMAND, serving its log as an interleaved timeline of output
 * and lifecycle records. This is not a terminal: managed commands are spawned
 * over pipes with no PTY, so there are no escape sequences to emulate and the
 * lines arrive already framed. They are carried as STRUCTURED records rather
 * than as the log's rendered text so the viewer can tint stderr and set
 * lifecycle rows apart without re-parsing a presentation format.
 *
 * ### Gaplessness
 *
 * Every line on this stream is read out of the log file, and every read is
 * bounded by a `LogPosition` - the log store's rotation-stable cursor. The
 * opening `snapshot` names the position its lines end at; `output` frames
 * continue from exactly there. The host's live signal (the supervisor's own
 * events) is only a wake-up telling it to read again, never itself a source of
 * lines. So the tail-to-live handoff cannot duplicate a line or skip one, and a
 * rotation in the middle of it changes nothing.
 *
 * Scrolling up runs the same cursor backwards: `loadOlder` names the position a
 * window starts at and gets the window before it, walking across rotated
 * segments until `reachedStart`. The retained log runs to tens of megabytes and
 * is never loaded eagerly.
 *
 * ## Degrade story
 *
 * Both are brand-new methods, deliberately off the released floor. A host that
 * does not serve them rejects the open as an unknown method; the client shows
 * the surface as unavailable rather than empty. There is no older transport to
 * fall back to - this is the first one.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";

/**
 * Ceiling on one `loadOlder` window. The viewer pages in screenfuls, so this is
 * far above any single scroll-up; it exists to keep a malformed request from
 * asking the host to render the whole retained log into one frame.
 */
export const MANAGED_COMMAND_MAX_WINDOW_LINES = 2_000;

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

// ─── `managedCommand.subscribeList@1.0` ─────────────────────────────────────

export const managedCommandSubscribeListOpenRequestSchema = z.object({
  epicId: z.string(),
});
export type ManagedCommandSubscribeListOpenRequest = z.infer<
  typeof managedCommandSubscribeListOpenRequestSchema
>;

export const managedCommandSubscribeListServerFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      commands: z.array(managedCommandSchema),
    }),
    // Upsert, not a patch: a command that was created, restarted, stopped,
    // relabelled or reached a terminal state arrives whole. One frame kind for
    // every change keeps the client's reducer a map write.
    z.object({
      kind: z.literal("changed"),
      ...textFrameFields,
      command: managedCommandSchema,
    }),
    z.object({
      kind: z.literal("removed"),
      ...textFrameFields,
      commandId: z.string(),
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type ManagedCommandSubscribeListServerFrame = z.infer<
  typeof managedCommandSubscribeListServerFrameSchema
>;

export const managedCommandSubscribeListClientFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type ManagedCommandSubscribeListClientFrame = z.infer<
  typeof managedCommandSubscribeListClientFrameSchema
>;

export const managedCommandSubscribeListV10 = defineStreamRpcContract({
  method: "managedCommand.subscribeList",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: managedCommandSubscribeListOpenRequestSchema,
  serverFrameSchema: managedCommandSubscribeListServerFrameSchema,
  clientFrameSchema: managedCommandSubscribeListClientFrameSchema,
});

// ─── `managedCommand.subscribeOutput@1.0` ───────────────────────────────────

/**
 * A cursor into the rolling log: a segment named by a rotation-stable identity
 * plus a byte offset into it. Opaque to the client, which only ever hands one
 * back where it got it. It survives the rename that rotation performs on the
 * active segment, which is what makes it safe to hold across a long-open
 * window.
 */
export const managedCommandLogPositionSchema = z.object({
  segmentId: z.string(),
  byteOffset: z.number().int().nonnegative(),
});
export type ManagedCommandLogPosition = z.infer<
  typeof managedCommandLogPositionSchema
>;

/**
 * One row of the timeline. `lifecycle` records (`started (pid 4410, manual,
 * shell: /bin/sh)`, `exited (code 1)`) ride the same stream as output, in the
 * same order, because that interleaving is exactly what a human debugging a 3am
 * restart is reading for.
 *
 * `atMs` is null only for a line the host could not read a timestamp from - a
 * partial record left behind by a crash. Everything else is stamped.
 */
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

export const managedCommandSubscribeOutputServerFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      command: managedCommandSchema,
      /** The opening tail, oldest line first. */
      lines: z.array(managedCommandLogLineSchema),
      /** Where `lines` begin - hand it back on `loadOlder` to page up. */
      start: managedCommandLogPositionSchema,
      /** Nothing older than `start` is retained; the viewer stops asking. */
      reachedStart: z.boolean(),
    }),
    // Lines appended since the last frame, oldest first. The client appends;
    // there is no position to reconcile because the host never re-sends one.
    z.object({
      kind: z.literal("output"),
      ...textFrameFields,
      lines: z.array(managedCommandLogLineSchema),
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
    // The command's own state moved (started, stopped, exited). The matching
    // lifecycle record also arrives as a timeline row; this is what the window
    // header's status reads.
    z.object({
      kind: z.literal("status"),
      ...textFrameFields,
      command: managedCommandSchema,
    }),
    // The command was deleted: its row, process and entire output history are
    // gone. The stream stays open so the window can show its dead-state banner
    // over the scrollback the viewer already has, and closes when the human
    // closes it.
    z.object({
      kind: z.literal("deleted"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type ManagedCommandSubscribeOutputServerFrame = z.infer<
  typeof managedCommandSubscribeOutputServerFrameSchema
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
  serverFrameSchema: managedCommandSubscribeOutputServerFrameSchema,
  clientFrameSchema: managedCommandSubscribeOutputClientFrameSchema,
});
