/**
 * `host.tunnel.open@1.0` - a bidirectional byte stream between two hosts, the
 * transport a port forward rides on. Host-to-host only: the dialing host
 * subscribes, the accepting host authorizes the named lease PER STREAM and
 * answers `accept` or a typed per-stream FATAL.
 *
 * Frames, both directions unless noted:
 *  - `accept` (server only): the lease was authorized; the opener may send.
 *  - `data`: one slice of the byte stream in the binary payload, at most
 *    `TUNNEL_MAX_DATA_BYTES` so it always rides ONE unchunked mux frame and is
 *    delivered as it arrives, never reassembled.
 *  - `credit`: reopens the sender's window by `credits` data frames; sent as
 *    the receiver's consumer actually drains, which is what makes the window
 *    end-to-end backpressure rather than transport accounting.
 *  - `end`: half-close; no more `data` follows in this direction.
 *  - `finished` (server only): the accepting side has received the opener's
 *    `end` and sent its own. Per-stream FIFO puts it after every byte the
 *    acceptor sent, and it proves the opener's last byte arrived, so the
 *    opener may now CLOSE the stream without purging anything still queued.
 *
 * Reset is the stream's own CLOSE / FATAL from either side. The windowing both
 * peers must agree on lives in `host-transport/remote/tunnel-stream.ts`.
 *
 * Brand-new method, unknown to every host shipped before it: a dialer reads
 * `SESSION_CAPABILITY_TUNNEL_STREAMS` and the stream manifest at `openAck` and
 * refuses locally, so there is no degrade.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

export const HOST_TUNNEL_OPEN_METHOD = "host.tunnel.open";

export const hostTunnelOpenRequestSchema = z.object({
  /** The task the lease belongs to; the accepting host checks editor access on it. */
  epicId: z.string().min(1),
  /** The live lease this stream claims; re-checked per stream, not per session. */
  leaseId: z.string().min(1),
});
export type HostTunnelOpenRequest = z.infer<typeof hostTunnelOpenRequestSchema>;

const tunnelDataFrameSchema = z.object({
  kind: z.literal("data"),
  hasBinaryPayload: z.literal(true),
});

const tunnelCreditFrameSchema = z.object({
  kind: z.literal("credit"),
  hasBinaryPayload: z.literal(false),
  credits: z.number().int().positive(),
});

const tunnelEndFrameSchema = z.object({
  kind: z.literal("end"),
  hasBinaryPayload: z.literal(false),
});

const tunnelAcceptFrameSchema = z.object({
  kind: z.literal("accept"),
  hasBinaryPayload: z.literal(false),
});

const tunnelFinishedFrameSchema = z.object({
  kind: z.literal("finished"),
  hasBinaryPayload: z.literal(false),
});

export const hostTunnelServerFrameSchema = z.discriminatedUnion("kind", [
  tunnelAcceptFrameSchema,
  tunnelFinishedFrameSchema,
  tunnelDataFrameSchema,
  tunnelCreditFrameSchema,
  tunnelEndFrameSchema,
]);
export type HostTunnelServerFrame = z.infer<typeof hostTunnelServerFrameSchema>;

export const hostTunnelClientFrameSchema = z.discriminatedUnion("kind", [
  tunnelDataFrameSchema,
  tunnelCreditFrameSchema,
  tunnelEndFrameSchema,
]);
export type HostTunnelClientFrame = z.infer<typeof hostTunnelClientFrameSchema>;

export const hostTunnelOpenV10 = defineStreamRpcContract({
  method: HOST_TUNNEL_OPEN_METHOD,
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: hostTunnelOpenRequestSchema,
  serverFrameSchema: hostTunnelServerFrameSchema,
  clientFrameSchema: hostTunnelClientFrameSchema,
});
