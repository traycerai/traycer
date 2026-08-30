import { z } from "zod";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";
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

export const providersChangedV10 = defineStreamRpcContract({
  method: "providers.changed",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: providersChangedOpenRequestSchema,
  serverFrameSchema: providersChangedServerFrameSchema,
  clientFrameSchema: providersChangedClientFrameSchema,
});
