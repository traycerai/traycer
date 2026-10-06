import { z } from "zod";
import {
  providerIdSchema,
  providerIdSchemaV80,
  providerIdSchemaV91,
} from "@traycer/protocol/host/provider-schemas";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const providersChangedOpenRequestSchema = lazySchema(() => z.object({}));

export const providersChangedServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      providerId: providerIdSchema,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type ProvidersChangedServerFrame = z.infer<
  typeof providersChangedServerFrameSchema
>;

export const providersChangedClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

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
export const providersChangedServerFrameSchemaPreAntigravity = lazySchema(() =>
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
  ]),
);

export const providersChangedV10 = defineStreamRpcContract({
  method: "providers.changed",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: providersChangedOpenRequestSchema,
  serverFrameSchema: providersChangedServerFrameSchemaPreAntigravity,
  clientFrameSchema: providersChangedClientFrameSchema,
});

/**
 * Frozen server-frame shape as the 1.5.0 tags shipped @1.1: the `changed`
 * arm's provider id pinned to the twenty-one ids those peers strict-decode
 * (`providerIdSchemaV91`, through Antigravity). Same reasoning as the @1.0
 * freeze above: the host does not send a later id below @1.2, and a peer that
 * cannot name a provider has no state of it to invalidate.
 */
export const providersChangedServerFrameSchemaV11 = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("changed"),
      providerId: providerIdSchemaV91,
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

/**
 * @1.1 is the first minor whose `changed` frames may name Antigravity, and is
 * frozen there.
 */
export const providersChangedV11 = defineStreamRpcContract({
  method: "providers.changed",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: providersChangedOpenRequestSchema,
  serverFrameSchema: providersChangedServerFrameSchemaV11,
  clientFrameSchema: providersChangedClientFrameSchema,
});

/**
 * @1.2 is the first minor whose `changed` frames may name a provider added
 * after 1.5.0 (Command Code is the first).
 */
export const providersChangedV12 = defineStreamRpcContract({
  method: "providers.changed",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: providersChangedOpenRequestSchema,
  serverFrameSchema: providersChangedServerFrameSchema,
  clientFrameSchema: providersChangedClientFrameSchema,
});
