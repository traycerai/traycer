/**
 * `resources.subscribe@1.0` / `@1.1` / `@1.2` - versioned streaming-RPC contract for
 * live process-resource snapshots.
 *
 * Subscribing opens a per-epic view over the host's `ResourceTracker`: the
 * owner snapshots (chats, terminals, terminal-agents) whose `epicId` matches
 * the requested epic, plus the epic-level aggregate for the local host. All
 * values are host-local; cross-host aggregation is a later protocol/UI layer,
 * not implied here.
 *
 * Frame shape (v1): every server frame carries the FULL current projection for
 * the epic - the complete owner set plus the epic aggregate. The client
 * replaces its view wholesale on each frame, so an owner dropping out of
 * `owners` (or `epic` going `null`) is exactly "no longer tracked". This keeps
 * removal semantics implicit and the host free of per-owner diffing, at the
 * cost of resending unchanged owners; acceptable for the small owner counts a
 * single epic holds. Deferred to future minors: cross-host fields and richer app
 * process categories (add as new optional fields / frame variants, never by
 * narrowing these).
 *
 * A missing owner snapshot means "not currently tracked", NOT zero use; a
 * `null` epic aggregate (owners empty) is a quiet, valid state. The host emits
 * one initial `snapshot`, then an `update` only when the epic's projection
 * actually changes - so an epic with no tracked roots stays silent after its
 * initial (empty) snapshot.
 *
 * Server frames:
 *
 * - `snapshot` - initial projection for the epic, emitted once on subscribe.
 * - `update`   - a later projection, emitted when the epic's owners or
 *                aggregate changed since the last emitted frame.
 * - `pong`     - heartbeat response.
 *
 * Client frames:
 *
 * - `ping` - heartbeat. No application client frames.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { defineRpcContract } from "@traycer/protocol/framework/index";

export const resourcesSubscribeOpenRequestV10Schema = z.object({
  epicId: z.string(),
});
export type ResourcesSubscribeOpenRequestV10 = z.infer<
  typeof resourcesSubscribeOpenRequestV10Schema
>;

export const resourcesSubscribeScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("epic"),
    epicId: z.string(),
  }),
  z.object({
    kind: z.literal("global"),
  }),
]);
export type ResourcesSubscribeScopeWire = z.infer<
  typeof resourcesSubscribeScopeSchema
>;

export const resourcesSubscribeOpenRequestV11Schema = z.object({
  // Kept on wire so a newer client can safely downgrade a global probe to
  // @1.0 without failing client-side request projection.
  epicId: z.string(),
  scope: resourcesSubscribeScopeSchema,
});
export type ResourcesSubscribeOpenRequestV11 = z.infer<
  typeof resourcesSubscribeOpenRequestV11Schema
>;

export const resourcesSubscribeOpenRequestSchema =
  resourcesSubscribeOpenRequestV10Schema;
export type ResourcesSubscribeOpenRequest = ResourcesSubscribeOpenRequestV10;

export const resourceOwnerKindSchema = z.enum([
  "chat",
  "terminal",
  "terminal-agent",
]);
export type ResourceOwnerKindWire = z.infer<typeof resourceOwnerKindSchema>;

export const resourceOwnerRefSchema = z.object({
  kind: resourceOwnerKindSchema,
  hostId: z.string(),
  epicId: z.string(),
  ownerId: z.string(),
});
export type ResourceOwnerRefWire = z.infer<typeof resourceOwnerRefSchema>;

export const resourceProcessSnapshotSchema = z.object({
  pid: z.number().int().nonnegative(),
  parentPid: z.number().int().nonnegative().nullable(),
  rootPid: z.number().int().nonnegative(),
  name: z.string(),
  command: z.string().nullable(),
  cpuPercent: z.number(),
  rssBytes: z.number().int().nonnegative(),
});
export type ResourceProcessSnapshotWire = z.infer<
  typeof resourceProcessSnapshotSchema
>;

/**
 * Live resource use for one owner at a single sample. `cpuPercent` is derived
 * from CPU-time deltas over wall time and may exceed 100 on multi-core hosts;
 * `rssBytes` is summed resident set across the owner's process tree.
 */
export const ownerResourceSnapshotSchema = z.object({
  owner: resourceOwnerRefSchema,
  sampledAt: z.number(),
  rootPids: z.array(z.number()),
  activeProcessName: z.string().nullable(),
  processCount: z.number().int().nonnegative(),
  cpuPercent: z.number(),
  rssBytes: z.number().int().nonnegative(),
  processes: z.array(resourceProcessSnapshotSchema),
});
export type OwnerResourceSnapshotWire = z.infer<
  typeof ownerResourceSnapshotSchema
>;

/**
 * Frozen `@1.3` owner snapshot: adds `harnessId`, the provider that owns the
 * tree (`claude`, `codex`, …) so the client can render the provider icon
 * instead of a generic "GUI agent" / "TUI agent" label. `null` for a
 * harness-less owner (a plain terminal shell). Additive-only: the `@1.0`–`@1.2`
 * `ownerResourceSnapshotSchema` above stays frozen.
 */
export const ownerResourceSnapshotSchemaV13 = z.object({
  ...ownerResourceSnapshotSchema.shape,
  harnessId: z.string().nullable(),
});
export type OwnerResourceSnapshotWireV13 = z.infer<
  typeof ownerResourceSnapshotSchemaV13
>;

/** Sum of the local owner snapshots that share the epic (owner roots only). */
export const epicResourceSnapshotSchema = z.object({
  hostId: z.string(),
  epicId: z.string(),
  sampledAt: z.number(),
  ownerCount: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  cpuPercent: z.number(),
  rssBytes: z.number().int().nonnegative(),
});
export type EpicResourceSnapshotWire = z.infer<
  typeof epicResourceSnapshotSchema
>;

export const appResourceSnapshotSchema = z.object({
  sampledAt: z.number(),
  hostTotalMemoryBytes: z.number().int().nonnegative(),
  process: resourceProcessSnapshotSchema.nullable(),
  processCount: z.number().int().nonnegative(),
  cpuPercent: z.number(),
  rssBytes: z.number().int().nonnegative(),
});
export type AppResourceSnapshotWire = z.infer<typeof appResourceSnapshotSchema>;

/** Aggregate resource use for the host process and all of its descendants. */
export const hostTreeResourceSnapshotSchema = z.object({
  sampledAt: z.number(),
  processCount: z.number().int().nonnegative(),
  cpuPercent: z.number(),
  rssBytes: z.number().int().nonnegative(),
});
export type HostTreeResourceSnapshotWire = z.infer<
  typeof hostTreeResourceSnapshotSchema
>;

/**
 * Host-tree processes that are not charged to an owner. Process readings are
 * self values only; consumers derive inclusive subtree totals from the process
 * parent/root relationships.
 */
export const otherResourceSnapshotSchema = z.object({
  sampledAt: z.number(),
  rootPids: z.array(z.number().int().nonnegative()),
  processCount: z.number().int().nonnegative(),
  cpuPercent: z.number(),
  rssBytes: z.number().int().nonnegative(),
  processes: z.array(resourceProcessSnapshotSchema),
});
export type OtherResourceSnapshotWire = z.infer<
  typeof otherResourceSnapshotSchema
>;

const resourcesProjectionFieldsV11 = {
  epicId: z.string(),
  sampledAt: z.number(),
  app: appResourceSnapshotSchema.nullable(),
  owners: z.array(ownerResourceSnapshotSchema),
  epics: z.array(epicResourceSnapshotSchema).optional(),
  // `null` when the epic has no tracked owner roots - "not currently tracked",
  // distinct from an aggregate whose totals happen to be zero.
  epic: epicResourceSnapshotSchema.nullable(),
  hasBinaryPayload: z.literal(false),
} as const;

// Frozen `resources.subscribe@1.0` / `@1.1` frame shape. Do not add fields
// here: a resolver serving either minor must emit precisely this projection.
export const resourcesSubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...resourcesProjectionFieldsV11,
    }),
    z.object({
      kind: z.literal("update"),
      ...resourcesProjectionFieldsV11,
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type ResourcesSubscribeServerFrame = z.infer<
  typeof resourcesSubscribeServerFrameSchema
>;

const resourcesProjectionFieldsV12 = {
  ...resourcesProjectionFieldsV11,
  hostTree: hostTreeResourceSnapshotSchema.nullable(),
  other: otherResourceSnapshotSchema.nullable(),
} as const;

export const resourcesSubscribeServerFrameSchemaV12 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...resourcesProjectionFieldsV12,
    }),
    z.object({
      kind: z.literal("update"),
      ...resourcesProjectionFieldsV12,
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type ResourcesSubscribeServerFrameV12 = z.infer<
  typeof resourcesSubscribeServerFrameSchemaV12
>;

export const resourcesSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type ResourcesSubscribeClientFrame = z.infer<
  typeof resourcesSubscribeClientFrameSchema
>;

export const resourcesSubscribeV10 = defineStreamRpcContract({
  method: "resources.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: resourcesSubscribeOpenRequestV10Schema,
  serverFrameSchema: resourcesSubscribeServerFrameSchema,
  clientFrameSchema: resourcesSubscribeClientFrameSchema,
});

export const resourcesSubscribeV11 = defineStreamRpcContract({
  method: "resources.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: resourcesSubscribeOpenRequestV11Schema,
  serverFrameSchema: resourcesSubscribeServerFrameSchema,
  clientFrameSchema: resourcesSubscribeClientFrameSchema,
});

export const resourcesSubscribeV12 = defineStreamRpcContract({
  method: "resources.subscribe",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: resourcesSubscribeOpenRequestV11Schema,
  serverFrameSchema: resourcesSubscribeServerFrameSchemaV12,
  clientFrameSchema: resourcesSubscribeClientFrameSchema,
});

// `@1.3` frame: identical to `@1.2` except `owners` carry `harnessId`. Prior
// minors stay frozen; a client on `@1.2` or below never receives the field.
const resourcesProjectionFieldsV13 = {
  ...resourcesProjectionFieldsV12,
  owners: z.array(ownerResourceSnapshotSchemaV13),
} as const;

export const resourcesSubscribeServerFrameSchemaV13 = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...resourcesProjectionFieldsV13,
    }),
    z.object({
      kind: z.literal("update"),
      ...resourcesProjectionFieldsV13,
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type ResourcesSubscribeServerFrameV13 = z.infer<
  typeof resourcesSubscribeServerFrameSchemaV13
>;

export const resourcesSubscribeV13 = defineStreamRpcContract({
  method: "resources.subscribe",
  schemaVersion: { major: 1, minor: 3 } as const,
  openRequestSchema: resourcesSubscribeOpenRequestV11Schema,
  serverFrameSchema: resourcesSubscribeServerFrameSchemaV13,
  clientFrameSchema: resourcesSubscribeClientFrameSchema,
});

// ── `resources.kill@1.0` — unary ────────────────────────────────────────────
// Terminates the entire process subtree beneath each requested pid (graceful
// SIGTERM, then SIGKILL escalation for survivors). Brand-new method, NOT on the
// released floor: an old host simply lacks it. The host re-derives which pids
// are killable from its own live sample (tracked owner/other trees, minus the
// app + host process trees), so a stale or stray pid is silently skipped rather
// than trusted. `killed` echoes the subset the host actually acted on.
export const resourcesKillRequestSchema = z.object({
  pids: z.array(z.number().int().nonnegative()),
});
export type ResourcesKillRequest = z.infer<typeof resourcesKillRequestSchema>;

export const resourcesKillResponseSchema = z.object({
  killed: z.array(z.number().int().nonnegative()),
});
export type ResourcesKillResponse = z.infer<typeof resourcesKillResponseSchema>;

export const resourcesKillV10 = defineRpcContract({
  method: "resources.kill",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: resourcesKillRequestSchema,
  responseSchema: resourcesKillResponseSchema,
});
