/**
 * `notifications.subscribe@1.0` - versioned streaming-RPC contract for the
 * per-user notifications Y.Doc subscription.
 *
 * `userId` is inferred from the host authentication context, so the open
 * request carries no parameters.
 *
 * Server frames:
 *
 * - `snapshot` - initial state for the user's notifications doc. Text
 *                envelope carries just the notifications-doc schema version
 *                as a semver string; the Y.Doc snapshot rides the paired
 *                binary payload.
 * - `update`   - an incremental Y.Doc update. Binary-only payload.
 * - `pong`     - heartbeat response to a client `ping`. Text-only.
 *
 * Client frames:
 *
 * - `applyUpdate` - an incremental Y.Doc update pushed by the client.
 *                   Binary payload.
 * - `ping`        - heartbeat. Text-only.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

export const notificationsSubscribeOpenRequestSchema = z.object({});
export type NotificationsSubscribeOpenRequest = z.infer<
  typeof notificationsSubscribeOpenRequestSchema
>;

const notificationsSnapshotMetaSchema = z.object({
  schemaVersion: z.string(),
});

export const notificationsSubscribeServerFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("snapshot"),
      meta: notificationsSnapshotMetaSchema,
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("update"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type NotificationsSubscribeServerFrame = z.infer<
  typeof notificationsSubscribeServerFrameSchema
>;

export const notificationsSubscribeClientFrameSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("applyUpdate"),
      hasBinaryPayload: z.literal(true),
    }),
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ],
);
export type NotificationsSubscribeClientFrame = z.infer<
  typeof notificationsSubscribeClientFrameSchema
>;

export const notificationsSubscribeV10 = defineStreamRpcContract({
  method: "notifications.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: notificationsSubscribeOpenRequestSchema,
  serverFrameSchema: notificationsSubscribeServerFrameSchema,
  clientFrameSchema: notificationsSubscribeClientFrameSchema,
});
