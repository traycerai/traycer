import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { simulatorOrientationSchema } from "./actions";
import {
  simulatorHubStateSchema,
  simulatorPackStateSchema,
  simulatorPlatformAvailabilitySchema,
  simulatorPlatformSchema,
  simulatorSessionSchema,
  simulatorStateSchema,
  simulatorSummarySchema,
} from "./schemas";

/**
 * `simulator.sessions@1.0` and `simulator.stream@1.0`: the two `/stream`
 * methods of the simulator domain. Both are new names (never `browser.*`,
 * whose namespace is frozen), registered at major 1 minor 0 and accepted by
 * the released-stream-surface tests under the subset rule.
 *
 * `simulator.sessions` publishes the service's inventory for one epic: a
 * `snapshot` on subscribe, then a `stateChanged` carrying only the fields
 * that changed. `simulator.stream` relays one simulator's video bytes to one
 * viewer as binary `video` frames and carries the viewer's input back to the
 * hub; the host remaps, translates and gates it on session ownership.
 *
 * Every schema is a `lazySchema` stand-in so importing this module builds
 * nothing (the eager-schema census pins that).
 */

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

const binaryFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(true)),
} as const;

// ---------------------------------------------------------------------------
// simulator.sessions
// ---------------------------------------------------------------------------

export const simulatorSessionsOpenRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
  }),
);
export type SimulatorSessionsOpenRequest = z.infer<
  typeof simulatorSessionsOpenRequestSchema
>;

/**
 * The fields of `SimulatorState` a `stateChanged` may carry. Each is present
 * only when it differs from the previous frame the subscriber was sent;
 * `revision` and `hostId` never ride a patch (the former is on the frame,
 * the latter never changes for one host).
 */
export const simulatorStatePatchSchema = lazySchema(() =>
  z.object({
    platforms: z.array(simulatorPlatformAvailabilitySchema).optional(),
    packState: simulatorPackStateSchema.optional(),
    hubState: simulatorHubStateSchema.optional(),
    simulators: z.array(simulatorSummarySchema).optional(),
    sessions: z.array(simulatorSessionSchema).optional(),
    booting: z.array(z.string().min(1)).optional(),
  }),
);
export type SimulatorStatePatch = z.infer<typeof simulatorStatePatchSchema>;

export const simulatorSessionsServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("snapshot"),
        ...textFrameFields,
        state: simulatorStateSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("stateChanged"),
        ...textFrameFields,
        revision: z.number().int().nonnegative(),
        patch: simulatorStatePatchSchema,
      })
      .strict(),
  ]),
);
/** The live line's server frames; the same object as the `@1.0` schema. */
export const simulatorSessionsServerFrameSchema =
  simulatorSessionsServerFrameSchemaV10;
export type SimulatorSessionsServerFrame = z.infer<
  typeof simulatorSessionsServerFrameSchema
>;

export const simulatorSessionsClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /** Re-run discovery: the capability probe, the pack state, the hub's inventory. */
    z
      .object({
        kind: z.literal("refresh"),
        ...textFrameFields,
      })
      .strict(),
  ]),
);
export type SimulatorSessionsClientFrame = z.infer<
  typeof simulatorSessionsClientFrameSchema
>;

export const simulatorSessionsV10 = defineStreamRpcContract({
  method: "simulator.sessions",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: simulatorSessionsOpenRequestSchema,
  serverFrameSchema: simulatorSessionsServerFrameSchemaV10,
  clientFrameSchema: simulatorSessionsClientFrameSchema,
});

// ---------------------------------------------------------------------------
// simulator.stream
// ---------------------------------------------------------------------------

/**
 * Opened per viewer for one simulator on the connection's own host. The
 * caller must hold a role on `epicId`, and the epic must hold a session on
 * the simulator; input is forwarded only for the session's owner.
 */
export const simulatorStreamOpenRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
  }),
);
export type SimulatorStreamOpenRequest = z.infer<
  typeof simulatorStreamOpenRequestSchema
>;

/**
 * `avcc`: iOS, one AVCC envelope per `video` frame. `semu`: Android, one
 * SEMU packet (its 16- or 24-byte header included) per frame. `mjpeg`: iOS
 * after `preferMjpeg`, one JPEG per frame.
 */
export const SIMULATOR_STREAM_CODECS = ["avcc", "semu", "mjpeg"] as const;
export const simulatorStreamCodecSchema = lazySchema(() =>
  z.enum(SIMULATOR_STREAM_CODECS),
);
export type SimulatorStreamCodec = z.infer<typeof simulatorStreamCodecSchema>;

/**
 * What one `video` frame's bytes are. The AVCC units are serve-sim's four
 * tags with the length prefix and tag byte stripped: `description` is the
 * `avcC` record the decoder is configured from, `seed` a JPEG of the last
 * frame shown before the first keyframe. `packet` is one whole SEMU packet.
 * `jpeg` is one MJPEG frame.
 */
export const SIMULATOR_VIDEO_UNITS = [
  "description",
  "keyframe",
  "delta",
  "seed",
  "packet",
  "jpeg",
] as const;
export const simulatorVideoUnitSchema = lazySchema(() =>
  z.enum(SIMULATOR_VIDEO_UNITS),
);
export type SimulatorVideoUnit = z.infer<typeof simulatorVideoUnitSchema>;

export const simulatorStreamConfigSchema = lazySchema(() =>
  z.object({
    platform: simulatorPlatformSchema,
    codec: simulatorStreamCodecSchema,
    /**
     * The raw framebuffer's size in pixels. Null while unknown: an Android
     * stream reports its size only once the encoder starts a session, and
     * the first decoded frame carries it anyway.
     */
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    /**
     * iOS reports the device orientation while its frames stay in the raw
     * framebuffer's portrait space, so a landscape orientation is a CSS
     * rotation on the viewer. Android frames are already upright.
     */
    orientation: simulatorOrientationSchema,
    /** False when the hub reports the simulator's input unavailable. */
    inputAvailable: z.boolean(),
    /**
     * The longest normal gap between video frames, in milliseconds, as the
     * hub reports it (its idle frame floor: a healthy capture re-sends the
     * last frame at that rate while the screen is still). Null when unknown,
     * and then no stall detection: neither the host's re-attach nor the
     * viewer's overlay has a number to measure a gap against.
     */
    frameIntervalMs: z.number().int().positive().nullable(),
  }),
);
export type SimulatorStreamConfig = z.infer<typeof simulatorStreamConfigSchema>;

export const simulatorStreamServerFrameSchemaV10 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /** Sent before the first `video` frame and again whenever the hub's screen config changes. */
    z
      .object({
        kind: z.literal("streamConfig"),
        ...textFrameFields,
        config: simulatorStreamConfigSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("video"),
        ...binaryFrameFields,
        unit: simulatorVideoUnitSchema,
      })
      .strict(),
    /**
     * Whether this viewer's input reaches the simulator. False with a
     * `detail` for a viewer who is not the session's owner, while the hub's
     * input socket is down, or when the hub reports input unavailable.
     */
    z
      .object({
        kind: z.literal("inputState"),
        ...textFrameFields,
        connected: z.boolean(),
        detail: z.string().max(256).nullable(),
      })
      .strict(),
    /** The stream cannot continue; the host closes the connection after it. */
    z
      .object({
        kind: z.literal("error"),
        ...textFrameFields,
        reason: z.string().max(512),
      })
      .strict(),
  ]),
);
/** The live line's server frames; the same object as the `@1.0` schema. */
export const simulatorStreamServerFrameSchema =
  simulatorStreamServerFrameSchemaV10;
export type SimulatorStreamServerFrame = z.infer<
  typeof simulatorStreamServerFrameSchema
>;

export const SIMULATOR_HARDWARE_BUTTONS = [
  "home",
  "back",
  "recents",
  "power",
  "appSwitcher",
] as const;
export const simulatorHardwareButtonSchema = lazySchema(() =>
  z.enum(SIMULATOR_HARDWARE_BUTTONS),
);
export type SimulatorHardwareButton = z.infer<
  typeof simulatorHardwareButtonSchema
>;

const unitCoordinateSchema = lazySchema(() => z.number().min(0).max(1));

export const simulatorStreamClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    /**
     * One pointer, normalised to 0..1 of the DISPLAYED frame. The host remaps
     * for an iOS device shown rotated, so the viewer never has to.
     */
    z
      .object({
        kind: z.literal("touch"),
        ...textFrameFields,
        phase: z.enum(["begin", "move", "end"]),
        x: unitCoordinateSchema,
        y: unitCoordinateSchema,
      })
      .strict(),
    /**
     * A keyboard event as the DOM reports it. iOS gets the HID usage of
     * `code`; Android gets a keycode for the navigation keys, `text` for a
     * printable `key`, and `back` for Escape.
     */
    z
      .object({
        kind: z.literal("key"),
        ...textFrameFields,
        phase: z.enum(["down", "up"]),
        code: z.string().max(64),
        key: z.string().max(64),
        modifiers: z.object({
          alt: z.boolean(),
          ctrl: z.boolean(),
          meta: z.boolean(),
          shift: z.boolean(),
        }),
      })
      .strict(),
    /** A hardware button; the host ignores one the platform does not have. */
    z
      .object({
        kind: z.literal("button"),
        ...textFrameFields,
        button: simulatorHardwareButtonSchema,
      })
      .strict(),
    /** iOS only; Android rotates through `simulator.action`. */
    z
      .object({
        kind: z.literal("orientation"),
        ...textFrameFields,
        orientation: simulatorOrientationSchema,
      })
      .strict(),
    /** The decoder's queue grew past its soft limit; the host asks the hub for a fresh keyframe. */
    z
      .object({
        kind: z.literal("requestKeyframe"),
        ...textFrameFields,
      })
      .strict(),
    /** The viewer cannot decode H.264 (iOS only): the host switches its upstream to MJPEG. */
    z
      .object({
        kind: z.literal("preferMjpeg"),
        ...textFrameFields,
      })
      .strict(),
  ]),
);
export type SimulatorStreamClientFrame = z.infer<
  typeof simulatorStreamClientFrameSchema
>;

export const simulatorStreamV10 = defineStreamRpcContract({
  method: "simulator.stream",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: simulatorStreamOpenRequestSchema,
  serverFrameSchema: simulatorStreamServerFrameSchemaV10,
  clientFrameSchema: simulatorStreamClientFrameSchema,
});
