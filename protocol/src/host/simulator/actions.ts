import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { simulatorPlatformSchema } from "./schemas";

/**
 * Typed settings and app actions on one simulator: `simulator.detail` reads
 * the settings back, `simulator.action` changes one and answers with the
 * fresh read. The host runs each as a fixed `simctl` or `adb` command line of
 * its own; nothing here is a shell string or reaches the hub's exec channel.
 *
 * An action a platform cannot do is refused by the host with a typed
 * "unavailable" error (`operation=`, `platform=`, `reason=unsupported |
 * helper_missing` in the message) before anything runs.
 */

export const SIMULATOR_APPEARANCES = ["light", "dark"] as const;
export const simulatorAppearanceSchema = lazySchema(() =>
  z.enum(SIMULATOR_APPEARANCES),
);
export type SimulatorAppearance = z.infer<typeof simulatorAppearanceSchema>;

/** Four steps shared by both platforms; the host maps each to its own scale. */
export const SIMULATOR_TEXT_SIZES = [
  "small",
  "default",
  "large",
  "extra-large",
] as const;
export const simulatorTextSizeSchema = lazySchema(() =>
  z.enum(SIMULATOR_TEXT_SIZES),
);
export type SimulatorTextSize = z.infer<typeof simulatorTextSizeSchema>;

export const SIMULATOR_COLOR_FILTERS = [
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
] as const;
export const simulatorColorFilterSchema = lazySchema(() =>
  z.enum(SIMULATOR_COLOR_FILTERS),
);
export type SimulatorColorFilter = z.infer<typeof simulatorColorFilterSchema>;

export const SIMULATOR_LIQUID_GLASS_STYLES = ["clear", "tinted"] as const;
export const simulatorLiquidGlassSchema = lazySchema(() =>
  z.enum(SIMULATOR_LIQUID_GLASS_STYLES),
);
export type SimulatorLiquidGlass = z.infer<typeof simulatorLiquidGlassSchema>;

export const SIMULATOR_ORIENTATIONS = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
] as const;
export const simulatorOrientationSchema = lazySchema(() =>
  z.enum(SIMULATOR_ORIENTATIONS),
);
export type SimulatorOrientation = z.infer<typeof simulatorOrientationSchema>;

export const SIMULATOR_PERMISSIONS = [
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "location",
  "notifications",
  "motion",
  "media-library",
  "faceid",
] as const;
export const simulatorPermissionSchema = lazySchema(() =>
  z.enum(SIMULATOR_PERMISSIONS),
);
export type SimulatorPermission = z.infer<typeof simulatorPermissionSchema>;

export const SIMULATOR_PERMISSION_DECISIONS = [
  "grant",
  "revoke",
  "reset",
] as const;

export const SIMULATOR_TOGGLE_SETTINGS = [
  "reduceMotion",
  "increaseContrast",
  "reduceTransparency",
  "showBorders",
  "voiceOver",
  "networkEnabled",
] as const;
export type SimulatorToggleSetting = (typeof SIMULATOR_TOGGLE_SETTINGS)[number];

/**
 * The settings as last read from the simulator. `null` is "could not be read
 * on this platform or right now", never a default. `location` is the last
 * location set through this host (neither `simctl` nor `adb` can read one
 * back); `null` when none was set or it was cleared.
 */
export const simulatorSettingsSchema = lazySchema(() =>
  z.object({
    appearance: simulatorAppearanceSchema.nullable(),
    textSize: simulatorTextSizeSchema.nullable(),
    reduceMotion: z.boolean().nullable(),
    increaseContrast: z.boolean().nullable(),
    reduceTransparency: z.boolean().nullable(),
    showBorders: z.boolean().nullable(),
    voiceOver: z.boolean().nullable(),
    liquidGlass: simulatorLiquidGlassSchema.nullable(),
    colorFilter: simulatorColorFilterSchema.nullable(),
    networkEnabled: z.boolean().nullable(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .nullable(),
  }),
);
export type SimulatorSettings = z.infer<typeof simulatorSettingsSchema>;

export const simulatorDetailSchema = lazySchema(() =>
  z.object({
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    settings: simulatorSettingsSchema,
    /** The focused app's bundle id or package; null when unknown (always on iOS). */
    foregroundApp: z.object({ id: z.string().min(1) }).nullable(),
    /** ISO-8601 instant of the read. */
    readAt: z.string().min(1),
  }),
);
export type SimulatorDetail = z.infer<typeof simulatorDetailSchema>;

/**
 * A bundle id or Android package. Restricted to the characters those can
 * hold, so a value can never read as a command-line flag or reach a device
 * shell as anything but one word.
 */
const appIdSchema = () =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const simulatorActionSchema = lazySchema(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("setAppearance"),
      value: simulatorAppearanceSchema,
    }),
    z.object({
      type: z.literal("setTextSize"),
      value: simulatorTextSizeSchema,
    }),
    z.object({
      type: z.literal("setToggle"),
      setting: z.enum(SIMULATOR_TOGGLE_SETTINGS),
      value: z.boolean(),
    }),
    z.object({
      type: z.literal("setLiquidGlass"),
      value: simulatorLiquidGlassSchema,
    }),
    z.object({
      type: z.literal("setColorFilter"),
      value: simulatorColorFilterSchema,
    }),
    z.object({
      type: z.literal("setOrientation"),
      value: simulatorOrientationSchema,
    }),
    z.object({
      type: z.literal("setLocation"),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
    z.object({ type: z.literal("clearLocation") }),
    z.object({
      type: z.literal("setPermission"),
      appId: appIdSchema(),
      permission: simulatorPermissionSchema,
      decision: z.enum(SIMULATOR_PERMISSION_DECISIONS),
    }),
    z.object({
      type: z.literal("openUrl"),
      // One token with no leading `-`, so it is never read as a flag.
      url: z
        .string()
        .trim()
        .regex(/^[^\s-]\S*$/),
    }),
    z.object({ type: z.literal("launchApp"), appId: appIdSchema() }),
    z.object({ type: z.literal("terminateApp"), appId: appIdSchema() }),
    z.object({ type: z.literal("shake") }),
    z.object({
      type: z.literal("sendPush"),
      appId: appIdSchema(),
      /** A bare string becomes `{ aps: { alert } }`; an object is sent as-is. */
      payload: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
    }),
  ]),
);
export type SimulatorAction = z.infer<typeof simulatorActionSchema>;
export type SimulatorActionType = SimulatorAction["type"];

export const simulatorDetailRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
  }),
);
export type SimulatorDetailRequest = z.infer<
  typeof simulatorDetailRequestSchema
>;
export const simulatorDetailResponseSchema = simulatorDetailSchema;
export type SimulatorDetailResponse = z.infer<
  typeof simulatorDetailResponseSchema
>;

export const simulatorActionRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
    action: simulatorActionSchema,
  }),
);
export type SimulatorActionRequest = z.infer<
  typeof simulatorActionRequestSchema
>;
/** The settings read back after the action ran. */
export const simulatorActionResponseSchema = simulatorDetailSchema;
export type SimulatorActionResponse = z.infer<
  typeof simulatorActionResponseSchema
>;

/** Reads one simulator's settings and foreground app. Owner only. */
export const simulatorDetailV10 = defineRpcContract({
  method: "simulator.detail",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorDetailRequestSchema,
  responseSchema: simulatorDetailResponseSchema,
});

/** Runs one typed action and answers with the settings read after it. Owner only. */
export const simulatorActionV10 = defineRpcContract({
  method: "simulator.action",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: simulatorActionRequestSchema,
  responseSchema: simulatorActionResponseSchema,
});
