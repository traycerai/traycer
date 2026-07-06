/**
 * `resources.subscribe@1.0` - versioned streaming-RPC contract for live
 * process-resource snapshots, scoped to a single epic.
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

export const resourcesSubscribeOpenRequestSchema = z.object({
  epicId: z.string(),
});
export type ResourcesSubscribeOpenRequest = z.infer<
  typeof resourcesSubscribeOpenRequestSchema
>;

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

const resourcesProjectionFields = {
  epicId: z.string(),
  sampledAt: z.number(),
  app: appResourceSnapshotSchema.nullable(),
  owners: z.array(ownerResourceSnapshotSchema),
  // `null` when the epic has no tracked owner roots - "not currently tracked",
  // distinct from an aggregate whose totals happen to be zero.
  epic: epicResourceSnapshotSchema.nullable(),
  hasBinaryPayload: z.literal(false),
} as const;

export const resourcesSubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      ...resourcesProjectionFields,
    }),
    z.object({
      kind: z.literal("update"),
      ...resourcesProjectionFields,
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
  openRequestSchema: resourcesSubscribeOpenRequestSchema,
  serverFrameSchema: resourcesSubscribeServerFrameSchema,
  clientFrameSchema: resourcesSubscribeClientFrameSchema,
});
