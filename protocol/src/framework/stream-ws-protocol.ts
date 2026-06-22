import { z } from "zod";
import {
  connectionManifestSchema,
  schemaVersionSchema,
  fatalErrorDetailsSchema,
  type ConnectionManifest,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * Control frames exchanged on the `/stream` WS before (and alongside) the
 * per-method stream traffic declared by the active streaming contract. These
 * mirror the unary `/rpc` handshake plus a `subscribe` frame that declares
 * the streaming method being activated on the connection.
 *
 * Per the tech plan:
 *   - client dials `/stream`, sends `open { token, manifest }`
 *   - host replies `openAck { manifest }` or `fatalError { details }`
 *   - client runs mirror `checkStreamCompatibility`, then sends
 *     `subscribe { method, schemaVersion, params }` declaring the streaming
 *     method
 *   - from that point onward, frames are defined by the active contract's
 *     `serverFrameSchema` / `clientFrameSchema`. Paired binary frames are
 *     the payload of the immediately preceding text envelope whose control
 *     flag `hasBinaryPayload` is `true`.
 *
 * Control-kind values (`open`, `openAck`, `subscribe`, `fatalError`) are
 * deliberately disjoint from the per-method server/client frame kinds
 * shipped by the combined `streamRpcRegistry` (`snapshot`, `update`,
 * `awareness`, `permissionChanged`, `pong`, `applyUpdate`, `ping`) so that
 * the stream client can route inbound text envelopes cleanly between
 * control-path and application-path handlers.
 */

/** First frame sent by the client: bearer token + per-method canonicals. */
export type ClientStreamOpenFrame = {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: ConnectionManifest;
};

/**
 * Second client frame - sent after `openAck` passes the mirror compatibility
 * check. Declares the streaming method that binds this connection.
 */
export type ClientStreamSubscribeFrame = {
  readonly kind: "subscribe";
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly params: unknown;
};

/**
 * Fatal error emitted by the client (typically when its mirror compat
 * check against the host manifest fails). Identical in shape to the unary
 * `ClientFatalErrorFrame`, intentionally - the wire-level close envelope
 * is shared across `/rpc` and `/stream`.
 */
export type ClientStreamFatalErrorFrame = {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
};

/** Host ack of the open + manifest. */
export type HostStreamOpenAckFrame = {
  readonly kind: "openAck";
  readonly manifest: ConnectionManifest;
};

/** Fatal error from the host (auth or compat rejection). */
export type HostStreamFatalErrorFrame = {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
};

export const clientStreamOpenFrameSchema = z.object({
  kind: z.literal("open"),
  token: z.string(),
  manifest: connectionManifestSchema,
});

export const clientStreamSubscribeFrameSchema = z.object({
  kind: z.literal("subscribe"),
  method: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  params: z.unknown(),
});

export const clientStreamFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

export const hostStreamOpenAckFrameSchema = z.object({
  kind: z.literal("openAck"),
  manifest: connectionManifestSchema,
});

export const hostStreamFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

/**
 * Text-envelope shape used for every post-`openAck` frame authored by a
 * streaming contract (both directions). The stream client only needs two
 * things from the envelope before pairing it with the (optional) binary
 * follower: a discriminant `kind` and whether a binary payload is
 * expected. Typed wrappers (`EpicStreamClient`, `NotificationsStreamClient`)
 * re-parse the envelope against their contract's full discriminated-union
 * schema to reach typed callbacks.
 */
export const streamMethodFrameEnvelopeSchema = z
  .object({
    kind: z.string().min(1),
    hasBinaryPayload: z.boolean(),
  })
  .passthrough();
export type StreamMethodFrameEnvelope = z.infer<
  typeof streamMethodFrameEnvelopeSchema
>;
