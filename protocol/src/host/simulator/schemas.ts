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

/**
 * The released `@1.0` lines below are frozen: each `...V10` schema is the
 * shape its contract shipped with, and the unsuffixed schema is the live
 * `@1.1` shape that extends it. Never point a `@1.0` contract at a live
 * schema; a field added there would grow onto the released line.
 */

/**
 * The key of one booted instance or ledger row: the iOS udid, or the Android
 * AVD name. Instance ids are reused by design, so it is never a catalog
 * identity; `sessionId` is.
 */
const instanceKeySchema = lazySchema(() => z.string().min(1).max(191));

/** An open's or a session's ulid, and the client's open `requestId`. */
const sessionIdentifierSchema = lazySchema(() => z.string().min(1).max(191));

export const simulatorSummarySchemaV10 = lazySchema(() =>
  z.object({
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    name: z.string(),
    version: z.string(),
    booted: z.boolean(),
    physical: z.boolean(),
  }),
);

/**
 * One booted copy of a device: the device's own (`cloneOf: null`) or a clone
 * Traycer created from it. `drivenByAgent` says only that some agent's live
 * session holds it, never whose. `idleUntil` is the epoch-millisecond
 * deadline at which an idle instance Traycer booted powers off; null while
 * it is in use, exempted by `keepRunning`, or booted outside Traycer.
 */
export const simulatorInstanceSchema = lazySchema(() =>
  z.object({
    instanceKey: instanceKeySchema,
    name: z.string(),
    booted: z.boolean(),
    /** The source device's key for a clone; null for the device's own. */
    cloneOf: instanceKeySchema.nullable(),
    drivenByAgent: z.boolean(),
    keepRunning: z.boolean(),
    idleUntil: z.number().int().nonnegative().nullable(),
  }),
);
export type SimulatorInstance = z.infer<typeof simulatorInstanceSchema>;

/**
 * A root device. On `@1.1` clones are never devices: they appear only under
 * their source's `instances`, which a `@1.0` host does not send.
 */
export const simulatorSummarySchema = lazySchema(() =>
  simulatorSummarySchemaV10.extend({
    instances: z.array(simulatorInstanceSchema).optional(),
  }),
);
export type SimulatorSummary = z.infer<typeof simulatorSummarySchema>;

/**
 * A session is one epic's attachment to one simulator on one host. Two epics
 * may hold sessions on the same simulator; the service does not arbitrate.
 * Only the owner may open, close or shut down through the verbs; viewing is
 * epic-scoped.
 */
export const simulatorSessionSchemaV10 = lazySchema(() =>
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

/**
 * On `@1.1` a session is one person's or one agent's hold on one instance.
 * Every new field is absent from a `@1.0` host; a `@1.1` host always sends
 * `sessionId` and `instanceKey`, and sends `agentId` and `requestId` as null
 * when there is none (a person's session; an open with no `requestId`).
 */
export const simulatorSessionSchema = lazySchema(() =>
  simulatorSessionSchemaV10.extend({
    /** The catalog identity, minted when no live session held the key. */
    sessionId: sessionIdentifierSchema.optional(),
    /** The `requestId` of the open that last returned this session. */
    requestId: sessionIdentifierSchema.nullable().optional(),
    /** The agent holding the session; null for a person's. */
    agentId: z.string().min(1).nullable().optional(),
    instanceKey: instanceKeySchema.optional(),
  }),
);
export type SimulatorSession = z.infer<typeof simulatorSessionSchema>;

/** A person's open still in flight, keyed by the `requestId` it was sent with. */
export const simulatorOpeningSchema = lazySchema(() =>
  z.object({
    requestId: sessionIdentifierSchema,
  }),
);
export type SimulatorOpening = z.infer<typeof simulatorOpeningSchema>;

/**
 * The service's published state for one epic: everything the tile and the
 * agent tools render. `sessions` and `booting` are scoped to the requesting
 * epic; `simulators` is the whole machine's inventory.
 */
export const simulatorStateSchemaV10 = lazySchema(() =>
  z.object({
    revision: z.number().int().nonnegative(),
    hostId: z.string().min(1),
    platforms: z.array(simulatorPlatformAvailabilitySchema),
    packState: simulatorPackStateSchema,
    hubState: simulatorHubStateSchema,
    simulators: z.array(simulatorSummarySchemaV10),
    sessions: z.array(simulatorSessionSchemaV10),
    /** Simulator ids with a boot in flight for this epic. */
    booting: z.array(z.string().min(1)),
  }),
);
export type SimulatorStateV10 = z.infer<typeof simulatorStateSchemaV10>;

/** `@1.1`: the live summaries and sessions, and the opens in flight. */
export const simulatorStateSchema = lazySchema(() =>
  simulatorStateSchemaV10.extend({
    simulators: z.array(simulatorSummarySchema),
    sessions: z.array(simulatorSessionSchema),
    /** This epic's opens that carried a `requestId` and have not answered. */
    opening: z.array(simulatorOpeningSchema).optional(),
  }),
);
export type SimulatorState = z.infer<typeof simulatorStateSchema>;

export const simulatorListRequestSchema = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
  }),
);
export type SimulatorListRequest = z.infer<typeof simulatorListRequestSchema>;
export const simulatorListResponseSchemaV10 = simulatorStateSchemaV10;
export const simulatorListResponseSchema = simulatorStateSchema;
export type SimulatorListResponse = z.infer<typeof simulatorListResponseSchema>;

export const simulatorOpenRequestSchemaV10 = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    /** Boot a cold simulator; false attaches only if it is already booted. */
    boot: z.boolean(),
  }),
);

/**
 * `instance` on `simulator.open@1.1`: `"auto"` prefers the caller's own live
 * instance on the device, then one no other agent drives, else a clone;
 * `"new"` always creates one; any other value names an instance by its key.
 * Absent means exactly the instance `simulatorId` names, the `@1.0` meaning.
 */
export const SIMULATOR_INSTANCE_POLICIES = ["auto", "new"] as const;
export const simulatorInstanceChoiceSchema = lazySchema(() =>
  z.union([z.enum(SIMULATOR_INSTANCE_POLICIES), instanceKeySchema]),
);
export type SimulatorInstanceChoice = z.infer<
  typeof simulatorInstanceChoiceSchema
>;

export const simulatorOpenRequestSchema = lazySchema(() =>
  simulatorOpenRequestSchemaV10.extend({
    instance: simulatorInstanceChoiceSchema.optional(),
    /**
     * The client's key for the pending row; the host lists it in `opening`
     * while the open runs and writes it onto the session it returns.
     */
    requestId: sessionIdentifierSchema.optional(),
  }),
);
export type SimulatorOpenRequest = z.infer<typeof simulatorOpenRequestSchema>;
export const simulatorOpenResponseSchemaV10 = lazySchema(() =>
  z.object({
    session: simulatorSessionSchemaV10,
    /**
     * The simulator as the hub reports it after the open. Its `simulatorId`
     * is authoritative: an Android AVD name becomes a serial on boot.
     */
    simulator: simulatorSummarySchemaV10,
  }),
);
/**
 * `@1.1`: the session carries its `sessionId`, unchanged when the open found
 * a live session on the same key.
 */
export const simulatorOpenResponseSchema = lazySchema(() =>
  simulatorOpenResponseSchemaV10.extend({
    session: simulatorSessionSchema,
    simulator: simulatorSummarySchema,
  }),
);
export type SimulatorOpenResponse = z.infer<typeof simulatorOpenResponseSchema>;

export const simulatorCloseRequestSchemaV10 = lazySchema(() =>
  z.object({
    epicId: z.string().min(1),
    simulatorId: z.string().min(1),
    /** Also power the simulator off after the session is removed. */
    shutdown: z.boolean(),
  }),
);
/**
 * `@1.1`: with `sessionId`, ends that one session the caller owns (or, for an
 * ended one, retires its notice). Without it, the `@1.0` meaning: every
 * session the caller owns on exactly the instance `simulatorId` names.
 */
export const simulatorCloseRequestSchema = lazySchema(() =>
  simulatorCloseRequestSchemaV10.extend({
    sessionId: sessionIdentifierSchema.optional(),
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
/**
 * What the host's managed store holds for the `simulator-tools` pack,
 * whatever the switch says: the newest installed version and the bytes the
 * pack occupies there (every installed version plus the cached archive).
 * Null when nothing is installed or the store could not be read. A dev
 * host's shared development copy is never reported here.
 */
export const simulatorInstalledToolsSchema = lazySchema(() =>
  z.object({
    version: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }),
);
export type SimulatorInstalledTools = z.infer<
  typeof simulatorInstalledToolsSchema
>;
export const simulatorStatusResponseSchema = lazySchema(() =>
  z.object({
    platforms: z.array(simulatorPlatformAvailabilitySchema),
    packState: simulatorPackStateSchema,
    /** The installed pack's version while `ready`; null otherwise. */
    packVersion: z.string().min(1).nullable(),
    /** The pack's bytes in this host's managed store; see the schema. */
    installed: simulatorInstalledToolsSchema.nullable(),
  }),
);
export type SimulatorStatusResponse = z.infer<
  typeof simulatorStatusResponseSchema
>;

/**
 * `simulator.removeTools`: deletes every installed `simulator-tools` version
 * and its cached archive from this host's managed store. Refused while the
 * switch is on or a helper runs. `removed` names the versions deleted.
 */
export const simulatorRemoveToolsRequestSchema = lazySchema(() => z.object({}));
export type SimulatorRemoveToolsRequest = z.infer<
  typeof simulatorRemoveToolsRequestSchema
>;
export const simulatorRemoveToolsResponseSchema = lazySchema(() =>
  z.object({
    removed: z.array(z.string().min(1)),
  }),
);
export type SimulatorRemoveToolsResponse = z.infer<
  typeof simulatorRemoveToolsResponseSchema
>;

/**
 * `simulator.instances`: every instance booted on this machine, host-wide,
 * with no epic. `tasks` lists the epics holding a live session on it that the
 * caller can view; `otherTaskCount` counts the rest, so a viewer of one task
 * never learns another's.
 */
export const simulatorInstancesRequestSchema = lazySchema(() => z.object({}));
export type SimulatorInstancesRequest = z.infer<
  typeof simulatorInstancesRequestSchema
>;
export const simulatorHostInstanceSchema = lazySchema(() =>
  simulatorInstanceSchema.extend({
    /** The id the instance is reached by now: a udid or a booted serial. */
    simulatorId: z.string().min(1),
    platform: simulatorPlatformSchema,
    version: z.string(),
    /** The source device's name for a clone; null for the device's own. */
    cloneOfName: z.string().nullable(),
    /** Only an instance Traycer booted follows the idle rule. */
    bootedByTraycer: z.boolean(),
    tasks: z.array(z.object({ epicId: z.string().min(1) })),
    otherTaskCount: z.number().int().nonnegative(),
  }),
);
export type SimulatorHostInstance = z.infer<
  typeof simulatorHostInstanceSchema
>;
export const simulatorInstancesResponseSchema = lazySchema(() =>
  z.object({
    instances: z.array(simulatorHostInstanceSchema),
  }),
);
export type SimulatorInstancesResponse = z.infer<
  typeof simulatorInstancesResponseSchema
>;

/**
 * `simulator.powerOff`: powers one instance off host-wide and ends every
 * session on it, removing a clone. While a mid-turn agent's session holds it
 * and `confirm` is false, nothing happens and the answer is
 * `confirm-required`; the caller asks, then sends `confirm: true`.
 */
export const simulatorPowerOffRequestSchema = lazySchema(() =>
  z.object({
    instanceKey: instanceKeySchema,
    confirm: z.boolean(),
  }),
);
export type SimulatorPowerOffRequest = z.infer<
  typeof simulatorPowerOffRequestSchema
>;
export const simulatorPowerOffResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("powered-off"), instanceKey: instanceKeySchema }),
    z.object({
      kind: z.literal("confirm-required"),
      instanceKey: instanceKeySchema,
    }),
  ]),
);
export type SimulatorPowerOffResponse = z.infer<
  typeof simulatorPowerOffResponseSchema
>;

/** `simulator.setKeepRunning`: exempts one instance from the idle rule, or not. */
export const simulatorSetKeepRunningRequestSchema = lazySchema(() =>
  z.object({
    instanceKey: instanceKeySchema,
    keepRunning: z.boolean(),
  }),
);
export type SimulatorSetKeepRunningRequest = z.infer<
  typeof simulatorSetKeepRunningRequestSchema
>;
export const simulatorSetKeepRunningResponseSchema =
  simulatorSetKeepRunningRequestSchema;
export type SimulatorSetKeepRunningResponse = z.infer<
  typeof simulatorSetKeepRunningResponseSchema
>;

/**
 * `config.simulator.*`: the one machine-user-global switch. On, the host
 * installs the tools, runs the simulators in a tile and lets agents drive
 * them; there is no separate agent switch.
 */
export const configSimulatorGetRequestSchema = lazySchema(() => z.object({}));
export type ConfigSimulatorGetRequest = z.infer<
  typeof configSimulatorGetRequestSchema
>;
export const configSimulatorResponseSchemaV10 = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
  }),
);

/**
 * The idle window, in minutes: an instance Traycer booted powers off once no
 * session has used it for this long, unless kept running.
 */
export const SIMULATOR_IDLE_MINUTES_DEFAULT = 15;
export const SIMULATOR_IDLE_MINUTES_MIN = 1;
export const SIMULATOR_IDLE_MINUTES_MAX = 24 * 60;
const idleMinutesSchema = lazySchema(() =>
  z
    .number()
    .int()
    .min(SIMULATOR_IDLE_MINUTES_MIN)
    .max(SIMULATOR_IDLE_MINUTES_MAX),
);

/** `@1.1`: `idleMinutes` is absent from a `@1.0` host, which has no idle rule. */
export const configSimulatorResponseSchema = lazySchema(() =>
  configSimulatorResponseSchemaV10.extend({
    idleMinutes: idleMinutesSchema.optional(),
  }),
);
export type ConfigSimulatorResponse = z.infer<
  typeof configSimulatorResponseSchema
>;
export const configSimulatorSetRequestSchemaV10 = lazySchema(() =>
  z.object({
    enabled: z.boolean(),
  }),
);
/**
 * `@1.1`: a partial write merged with the stored block. `enabled: null` and
 * an absent `idleMinutes` keep the stored value, so `{ enabled: null,
 * idleMinutes }` never turns simulators on or off. `enabled` stays a
 * required key because a minor cannot make a request field optional: a
 * `@1.1` write that omits it could not be projected onto a `@1.0` host, and
 * a `null` one is refused there, which is right, since that host has no
 * idle window to write.
 */
export const configSimulatorSetRequestSchema = lazySchema(() =>
  z.object({
    enabled: z.boolean().nullable(),
    idleMinutes: idleMinutesSchema.optional(),
  }),
);
export type ConfigSimulatorSetRequest = z.infer<
  typeof configSimulatorSetRequestSchema
>;
export const configSimulatorSetResponseSchemaV10 =
  configSimulatorResponseSchemaV10;
export const configSimulatorSetResponseSchema = configSimulatorResponseSchema;
export type ConfigSimulatorSetResponse = z.infer<
  typeof configSimulatorSetResponseSchema
>;
