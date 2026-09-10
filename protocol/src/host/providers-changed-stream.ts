import { z } from "zod";
import {
  providerIdSchema,
  providerIdSchemaV80,
} from "@traycer/protocol/host/provider-schemas";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

export const providersChangedOpenRequestSchema = z.object({});

export const providersChangedServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("changed"),
    providerId: providerIdSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type ProvidersChangedServerFrame = z.infer<
  typeof providersChangedServerFrameSchema
>;

export const providersChangedClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ping"),
    hasBinaryPayload: z.literal(false),
  }),
]);

/**
 * Frozen server-frame shape as `cli-v1.3.0` / `host-v1.3.0` shipped @1.0: the
 * `changed` arm's provider id is pinned to the twenty ids those peers strict-
 * decode.
 *
 * Streams carry no downgrade bridge, so a host cannot project an Antigravity
 * notification down to this minor - it must simply not send one. That is
 * lossless here in a way it would not be for a catalog method: the frame is a
 * pure invalidation signal, and a peer that cannot name Antigravity has no
 * Antigravity state to invalidate.
 */
export const providersChangedServerFrameSchemaPreAntigravity =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      providerId: providerIdSchemaV80,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]);

export const providersChangedV10 = defineStreamRpcContract({
  method: "providers.changed",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: providersChangedOpenRequestSchema,
  serverFrameSchema: providersChangedServerFrameSchemaPreAntigravity,
  clientFrameSchema: providersChangedClientFrameSchema,
});

/**
 * @1.1 is the first minor whose `changed` frames may name Antigravity.
 */
export const providersChangedV11 = defineStreamRpcContract({
  method: "providers.changed",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: providersChangedOpenRequestSchema,
  serverFrameSchema: providersChangedServerFrameSchema,
  clientFrameSchema: providersChangedClientFrameSchema,
});
