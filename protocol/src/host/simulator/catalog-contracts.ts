import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { simulatorPlatformSchema } from "./schemas";

/**
 * The cloud's simulator catalog: one record per session a host publishes,
 * read back per task by every device of its user. Copied from the browser
 * catalog; the identity is the per-session `sessionId`, never the instance
 * key, because a tombstoned identity is fenced for good and instance keys
 * are reused.
 */

export const SIMULATOR_CATALOG_VERSION = 1 as const;

/** The task document's map the head-wake writer bumps for this catalog. */
export const SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY = "cloudSimulatorCatalogHead";

const identifier = lazySchema(() => z.string().min(1).max(191));
const epicId = lazySchema(() => z.string().min(1).max(36));
const epochMs = lazySchema(() =>
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);
export const simulatorInventoryRevisionSchema = lazySchema(() =>
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);

export const simulatorCatalogIdentitySchema = lazySchema(() =>
  z.strictObject({ epicId, hostId: identifier, sessionId: identifier }),
);
export type SimulatorCatalogIdentity = z.infer<
  typeof simulatorCatalogIdentitySchema
>;

/**
 * Why a session ended without its owner closing it. A session the person
 * closed is tombstoned at once and never carries one.
 */
export const SIMULATOR_SESSION_END_REASONS = [
  "idle",
  "powerOff",
  "shutdown",
  "archived",
  "switchOff",
  "cold",
  "rebooted",
] as const;
export const simulatorSessionEndReasonSchema = lazySchema(() =>
  z.enum(SIMULATOR_SESSION_END_REASONS),
);
export type SimulatorSessionEndReason = z.infer<
  typeof simulatorSessionEndReasonSchema
>;

/**
 * Discovery metadata only. `drivenByAgent` is the instance's flag, written
 * into every session's record on it, never an agent's identity. `idleUntil`
 * is the epoch-millisecond power-off deadline of an idle instance. A record
 * with `endedReason` is a session that already ended, kept as the row's
 * notice until its tombstone.
 */
export const simulatorCatalogRecordSchema = lazySchema(() =>
  simulatorCatalogIdentitySchema.extend({
    inventoryRevision: simulatorInventoryRevisionSchema,
    lastActivityAt: epochMs,
    instanceKey: identifier,
    simulatorId: identifier,
    name: z.string().max(256),
    platform: simulatorPlatformSchema,
    version: z.string().max(64),
    cloneOf: identifier.nullable(),
    drivenByAgent: z.boolean(),
    idleUntil: epochMs.nullable(),
    endedReason: simulatorSessionEndReasonSchema.nullable(),
  }),
);
export type SimulatorCatalogRecord = z.infer<
  typeof simulatorCatalogRecordSchema
>;

export const simulatorCatalogDeletionSchema = lazySchema(() =>
  simulatorCatalogIdentitySchema.extend({
    inventoryRevision: simulatorInventoryRevisionSchema,
  }),
);
export type SimulatorCatalogDeletion = z.infer<
  typeof simulatorCatalogDeletionSchema
>;

export const simulatorCatalogReadRequestSchema = lazySchema(() =>
  z.strictObject({ epicId }),
);
export type SimulatorCatalogReadRequest = z.infer<
  typeof simulatorCatalogReadRequestSchema
>;

export const simulatorCatalogSnapshotSchema = lazySchema(() =>
  z.strictObject({
    version: simulatorInventoryRevisionSchema,
    records: z.array(simulatorCatalogRecordSchema),
  }),
);
export type SimulatorCatalogSnapshot = z.infer<
  typeof simulatorCatalogSnapshotSchema
>;

/**
 * `simulator.catalog.read`: the host's stateless relay of the caller's task
 * catalog. `not-ready` is a cloud whose simulator catalog is not enabled
 * yet, which an empty snapshot could not tell apart from an empty task;
 * `unavailable` stays for a read that failed.
 */
export const simulatorCatalogReadResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("available"),
      snapshot: simulatorCatalogSnapshotSchema,
    }),
    z.strictObject({ kind: z.literal("local-only") }),
    z.strictObject({ kind: z.literal("inaccessible") }),
    z.strictObject({ kind: z.literal("unavailable") }),
    z.strictObject({ kind: z.literal("not-ready") }),
  ]),
);
export type SimulatorCatalogReadResponse = z.infer<
  typeof simulatorCatalogReadResponseSchema
>;
