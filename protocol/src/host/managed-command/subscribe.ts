/**
 * The managed-command output stream - the transport half of the "Monitors &
 * Shells" surface described in the host's `domain/managed-command/UI.md`.
 *
 * ## Where the LIST lives
 *
 * There is deliberately no list stream here. Every surface that reads the set
 * of commands is chat-scoped (the chat tile's menu, the chat's Background
 * panel), so the set rides the chat's own stream instead: `chat.subscribe`'s
 * `snapshot.managedCommands` and its `managedCommandsChanged` frame, both
 * filtered to the commands that chat created. That also binds the set to the
 * tab's host the way every other chat surface is bound, which an epic-wide
 * stream on the app-wide active-host connection could not be.
 *
 * Re-entry path: a future GLOBAL panel (one that lists an epic's commands
 * across chats) needs what the chat stream cannot give it, and would re-add an
 * epic-level `managedCommand.subscribeList@1.0` here - a `snapshot` of every
 * command in the epic followed by `changed`/`removed` upserts, served off the
 * supervisor's events exactly as the output stream below is. It is a new
 * method at that point, not a revival: nothing on the wire depends on its
 * absence today.
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
 * A brand-new method, deliberately off the released floor. A host that does not
 * serve it rejects the open as an unknown method; the client shows the surface
 * as unavailable rather than empty. There is no older transport to fall back
 * to - this is the first one.
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
    // Lines appended since the last frame, oldest first. `start` is the exact
    // log boundary before the first line. A following viewer may discard whole
    // frames, advance its held start to this cursor, and later page the gap
    // back without guessing byte offsets or losing rotation stability.
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
    // Re-base a viewer that deliberately detached from live output while
    // reading history. The host serializes this through the live pump so the
    // next `output` starts exactly where the replacement snapshot ends.
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
  serverFrameSchema: managedCommandSubscribeOutputServerFrameSchema,
  clientFrameSchema: managedCommandSubscribeOutputClientFrameSchema,
});
