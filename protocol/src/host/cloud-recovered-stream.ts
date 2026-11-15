import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

export const CLOUD_RECOVERED_STREAM_METHOD = "cloud.recovered.subscribe";

export const cloudRecoveredOpenRequestSchema = lazySchema(() => z.object({}));

/**
 * The host's cloud-recovery doorbell. `recovered` carries nothing on purpose:
 * it says "a read of yours that failed because this host could not reach the
 * cloud, or was refused by its egress budget, may succeed if asked again now".
 * The host rings it once when the subscription opens, so a client that
 * subscribed after an edge still re-asks, and again on each edge it observes:
 * the cloud answering after a transport failure, a route family's breaker
 * closing, and a route family's breaker being due a probe (a re-ask then is
 * the probe that can close it).
 *
 * A client re-asks only reads THIS host answered with a transient cloud code
 * (`E_CLOUD_REQUEST_REFUSED`, `E_CLOUD_UNREACHABLE`); a frame from one host
 * never re-asks another host's reads.
 */
export const cloudRecoveredServerFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("recovered"),
      hasBinaryPayload: z.literal(false),
    }),
    z.object({
      kind: z.literal("pong"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);
export type CloudRecoveredServerFrame = z.infer<
  typeof cloudRecoveredServerFrameSchema
>;

export const cloudRecoveredClientFrameSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      hasBinaryPayload: z.literal(false),
    }),
  ]),
);

export const cloudRecoveredV10 = defineStreamRpcContract({
  method: CLOUD_RECOVERED_STREAM_METHOD,
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: cloudRecoveredOpenRequestSchema,
  serverFrameSchema: cloudRecoveredServerFrameSchema,
  clientFrameSchema: cloudRecoveredClientFrameSchema,
});
