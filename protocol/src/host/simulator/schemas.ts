import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * Wire shapes for the host's simulator domain: iOS Simulators and Android
 * Emulators running on the host's own machine, supervised by the host through
 * the `simulator-tools` pack and never exposed directly.
 *
 * The per-simulator identifier is `simulatorId` - the iOS udid or the Android
 * serial - and never `deviceId`: this repo reserves "device" as UI copy for
 * `hostId`.
 *
 * Every schema is a `lazySchema` stand-in so importing this module builds
 * nothing (the eager-schema census pins that).
 */

export const SIMULATOR_PLATFORMS = ["ios", "android"] as const;
export const simulatorPlatformSchema = lazySchema(() =>
  z.enum(SIMULATOR_PLATFORMS),
);
export type SimulatorPlatform = z.infer<typeof simulatorPlatformSchema>;

/** Whether this host's machine can run one simulator platform, and why not. */
export const simulatorPlatformAvailabilitySchema = lazySchema(() =>
  z.object({
    platform: simulatorPlatformSchema,
    available: z.boolean(),
    /** User-facing reason when `available` is false; null when available. */
    reason: z.string().nullable(),
  }),
);
export type SimulatorPlatformAvailability = z.infer<
  typeof simulatorPlatformAvailabilitySchema
>;

/**
 * The `simulator-tools` pack on this host. `off` is the enablement switch
 * being off; `installing` is the pack in the registry's download queue;
 * `ready` is a verified pack on disk; `failed` carries the install scheduler's
 * reason; `unsupported` is a host that can run neither platform or has no
 * registry to fetch from.
 */
export const SIMULATOR_PACK_STATE_KINDS = [
  "off",
  "installing",
  "ready",
  "failed",
  "unsupported",
] as const;
export const simulatorPackStateSchema = lazySchema(() =>
  z.object({
    kind: z.enum(SIMULATOR_PACK_STATE_KINDS),
    reason: z.string().nullable(),
    /** Download progress in [0, 1] while `installing`; null otherwise. */
    progress: z.number().min(0).max(1).nullable(),
  }),
);
export type SimulatorPackState = z.infer<typeof simulatorPackStateSchema>;

/** The supervised hub child's lifecycle, as the service last observed it. */
export const SIMULATOR_HUB_STATES = [
  "stopped",
  "starting",
  "running",
  "restarting",
  "failed",
] as const;
export const simulatorHubStateSchema = lazySchema(() =>
  z.object({
    kind: z.enum(SIMULATOR_HUB_STATES),
    /** The last hub error line, for the tile's crash-loop copy; null otherwise. */
    lastError: z.string().nullable(),
  }),
);
export type SimulatorHubState = z.infer<typeof simulatorHubStateSchema>;

export const simulatorSummarySchema = lazySchema(() =>
  z.object({
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    name: z.string(),
    version: z.string(),
    booted: z.boolean(),
    physical: z.boolean(),
  }),
);
export type SimulatorSummary = z.infer<typeof simulatorSummarySchema>;

/**
 * A session is one epic's attachment to one simulator on one host. Two epics
 * may hold sessions on the same simulator; the service does not arbitrate.
 * Only the owner may open, close or shut down through the verbs; viewing is
 * epic-scoped.
 */
export const simulatorSessionSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    ownerUserId: z.string().min(1),
    hostId: z.string().min(1),
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    /** ISO-8601 instant. */
    openedAt: z.string().min(1),
  }),
);
export type SimulatorSession = z.infer<typeof simulatorSessionSchema>;

/**
 * The service's published state for one epic: everything the tile and the
 * agent tools render. `sessions` and `booting` are scoped to the requesting
 * epic; `simulators` is the whole machine's inventory.
 */
export const simulatorStateSchema = lazySchema(() =>
  z.object({
    revision: z.number().int().nonnegative(),
    hostId: z.string().min(1),
    platforms: z.array(simulatorPlatformAvailabilitySchema),
    packState: simulatorPackStateSchema,
    hubState: simulatorHubStateSchema,
    simulators: z.array(simulatorSummarySchema),
    sessions: z.array(simulatorSessionSchema),
    /** Simulator ids with a boot in flight for this epic. */
    booting: z.array(z.string().min(1)),
  }),
);
export type SimulatorState = z.infer<typeof simulatorStateSchema>;

export const simulatorListRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
  }),
);
export type SimulatorListRequest = z.infer<typeof simulatorListRequestSchema>;
export const simulatorListResponseSchema = simulatorStateSchema;
export type SimulatorListResponse = z.infer<typeof simulatorListResponseSchema>;

export const simulatorOpenRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    /** Boot a cold simulator; false attaches only if it is already booted. */
    boot: z.boolean(),
  }),
);
export type SimulatorOpenRequest = z.infer<typeof simulatorOpenRequestSchema>;
export const simulatorOpenResponseSchema = lazySchema(() =>
  z.object({
    session: simulatorSessionSchema,
    /**
     * The simulator as the hub reports it after the open. Its `simulatorId`
     * is authoritative: an Android AVD name becomes a serial on boot.
     */
    simulator: simulatorSummarySchema,
  }),
);
export type SimulatorOpenResponse = z.infer<typeof simulatorOpenResponseSchema>;

export const simulatorCloseRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
    /** Also power the simulator off after the session is removed. */
    shutdown: z.boolean(),
  }),
);
export type SimulatorCloseRequest = z.infer<typeof simulatorCloseRequestSchema>;
export const simulatorCloseResponseSchema = lazySchema(() =>
  z.object({
    /** Sessions removed; zero when the caller held none on that simulator. */
    closed: z.number().int().nonnegative(),
  }),
);
export type SimulatorCloseResponse = z.infer<
  typeof simulatorCloseResponseSchema
>;

export const simulatorShutdownRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
  }),
);
export type SimulatorShutdownRequest = z.infer<
  typeof simulatorShutdownRequestSchema
>;
export const simulatorShutdownResponseSchema = lazySchema(() =>
  z.object({
    simulatorId: z.string().min(1),
    booted: z.literal(false),
  }),
);
export type SimulatorShutdownResponse = z.infer<
  typeof simulatorShutdownResponseSchema
>;

export const simulatorScreenshotRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
  }),
);
export type SimulatorScreenshotRequest = z.infer<
  typeof simulatorScreenshotRequestSchema
>;
export const simulatorScreenshotResponseSchema = lazySchema(() =>
  z.object({
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    /** PNG bytes, base64. */
    pngBase64: z.string(),
    /** Parsed from the PNG header; null when the header could not be read. */
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }),
);
export type SimulatorScreenshotResponse = z.infer<
  typeof simulatorScreenshotResponseSchema
>;

/**
 * `simulator.status`: the machine-wide half of {@link simulatorStateSchema},
 * with no epic. It is what Settings reads, where there is no task to scope
 * sessions to: whether each platform can run here, and the pack's install.
 */
export const simulatorStatusRequestSchema = lazySchema(() => z.object({}));
export type SimulatorStatusRequest = z.infer<
  typeof simulatorStatusRequestSchema
>;
export const simulatorStatusResponseSchema = lazySchema(() =>
  z.object({
    platforms: z.array(simulatorPlatformAvailabilitySchema),
    packState: simulatorPackStateSchema,
    /** The installed pack's version while `ready`; null otherwise. */
    packVersion: z.string().min(1).nullable(),
  }),
);
export type SimulatorStatusResponse = z.infer<
  typeof simulatorStatusResponseSchema
>;

/**
 * `config.simulator.*`: the two machine-user-global switches. Both are stated
 * on every write - no implicit default on the wire, so a missing key is a
 * malformed peer rather than "leave that one alone".
 */
export const configSimulatorGetRequestSchema = lazySchema(() => z.object({}));
export type ConfigSimulatorGetRequest = z.infer<
  typeof configSimulatorGetRequestSchema
>;
export const configSimulatorResponseSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    agentAccess: z.boolean(),
  }),
);
export type ConfigSimulatorResponse = z.infer<
  typeof configSimulatorResponseSchema
>;
export const configSimulatorSetRequestSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
    agentAccess: z.boolean(),
  }),
);
export type ConfigSimulatorSetRequest = z.infer<
  typeof configSimulatorSetRequestSchema
>;
export const configSimulatorSetResponseSchema = configSimulatorResponseSchema;
export type ConfigSimulatorSetResponse = z.infer<
  typeof configSimulatorSetResponseSchema
>;
