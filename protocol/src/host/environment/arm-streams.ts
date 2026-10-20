/**
 * The environment arm: a team environment's own rows in one task, served to
 * a member of the environment by the server pool.
 *
 * A team host keys what it writes by its environment (its chats, its
 * plain-terminal catalog, its communication graph), so the member's own reads
 * never see those rows. These three streams carry them, each keyed by
 * `(environmentId, task)`, so the stream's only authority is the viewer's
 * membership of that environment and the task's attachment to it:
 *
 * - The first snapshot comes after the open. A new snapshot follows whenever
 *   the environment's committed position in the task moves. For the graph,
 *   `events` frames carry what is new since the last cursor.
 * - Every frame carries the authorization `generation` it was built under.
 *   A frame older than the newest generation the client has seen is
 *   discarded.
 * - Losing the membership ends the stream with FATAL `TEAM_MEMBER_REMOVED`.
 *   A task that is not attached to the environment ends it with
 *   `FORBIDDEN`.
 *
 * Optional streams: a pool that does not advertise one has no environment
 * arm for it, and the client shows the member's own rows alone.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { cloudChatSummarySchema } from "@traycer/protocol/host/epic/cloud-chat";
import {
  hostCommunicationGraphCloudFeedCursorSchema,
  hostCommunicationGraphCloudFeedEventSchema,
} from "@traycer/protocol/host/epic/communication-graph";
import { plainTerminalRecordSchema } from "@traycer/protocol/host/terminal/plain-schemas";

const textFrameFields = {
  hasBinaryPayload: lazySchema(() => z.literal(false)),
} as const;

const generationSchema = lazySchema(() => z.number().int().nonnegative());

const pongFrameSchema = lazySchema(() =>
  z.object({ kind: z.literal("pong"), ...textFrameFields }),
);

const pingFrameSchema = lazySchema(() =>
  z.object({ kind: z.literal("ping"), ...textFrameFields }),
);

// ---- environment.chats.subscribe ---------------------------------------- //

export const environmentChatsSubscribeOpenRequestSchema = lazySchema(() =>
  z.object({
    environmentId: z.string().min(1),
    taskId: z.string().min(1),
  }),
);

/**
 * The task's chats owned by the environment, private ones included. Each
 * row's `identity.ownerUserId` is the environment id, so a client unites
 * them with the host's arm by the identity triple.
 */
export const environmentChatsSubscribeServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      ...textFrameFields,
      generation: generationSchema,
      chats: z.array(cloudChatSummarySchema),
    }),
    pongFrameSchema,
  ]),
);

export const environmentChatsSubscribeV10 = defineStreamRpcContract({
  method: "environment.chats.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: environmentChatsSubscribeOpenRequestSchema,
  serverFrameSchema: environmentChatsSubscribeServerFrameSchema,
  clientFrameSchema: pingFrameSchema,
});

// ---- environment.plainTerminals.subscribe ------------------------------- //

export const environmentPlainTerminalsSubscribeOpenRequestSchema = lazySchema(
  () =>
    z.object({
      environmentId: z.string().min(1),
      epicId: z.string().min(1),
    }),
);

/** The environment's plain-terminal catalog for the task, whole. */
export const environmentPlainTerminalsSubscribeServerFrameSchema = lazySchema(
  () =>
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("snapshot"),
        ...textFrameFields,
        generation: generationSchema,
        catalogVersion: z.number().int().nonnegative(),
        terminals: z.array(plainTerminalRecordSchema),
      }),
      pongFrameSchema,
    ]),
);

export const environmentPlainTerminalsSubscribeV10 = defineStreamRpcContract({
  method: "environment.plainTerminals.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: environmentPlainTerminalsSubscribeOpenRequestSchema,
  serverFrameSchema: environmentPlainTerminalsSubscribeServerFrameSchema,
  clientFrameSchema: pingFrameSchema,
});

// ---- environment.communicationGraph.subscribe --------------------------- //

export const environmentCommunicationGraphSubscribeOpenRequestSchema =
  lazySchema(() =>
    z.object({
      environmentId: z.string().min(1),
      epicId: z.string().min(1),
      /** Events strictly after this cursor; `null` for the whole graph. */
      sinceCursor: hostCommunicationGraphCloudFeedCursorSchema.nullable(),
    }),
  );

/**
 * The environment's graph events for the task, in cursor order, exactly once
 * each: every `events` frame continues from the previous one's `cursor`.
 * `caughtUp` says the frame reached the head the server read.
 */
export const environmentCommunicationGraphSubscribeServerFrameSchema =
  lazySchema(() =>
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("events"),
        ...textFrameFields,
        generation: generationSchema,
        epicId: z.string().min(1),
        events: z.array(hostCommunicationGraphCloudFeedEventSchema),
        cursor: hostCommunicationGraphCloudFeedCursorSchema.nullable(),
        headVersion: z.number().int().nonnegative(),
        caughtUp: z.boolean(),
      }),
      pongFrameSchema,
    ]),
  );

export const environmentCommunicationGraphSubscribeV10 =
  defineStreamRpcContract({
    method: "environment.communicationGraph.subscribe",
    schemaVersion: { major: 1, minor: 0 } as const,
    openRequestSchema: environmentCommunicationGraphSubscribeOpenRequestSchema,
    serverFrameSchema: environmentCommunicationGraphSubscribeServerFrameSchema,
    clientFrameSchema: pingFrameSchema,
  });
