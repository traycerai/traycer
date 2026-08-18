import { z } from "zod";
import type { SchemaVersion } from "@traycer/protocol/framework/index";

/**
 * Wire-level frame types for the per-request WebSocket RPC protocol.
 *
 * Each accepted WebSocket connection carries exactly one RPC call and the
 * preceding open/manifest dance. Frames are JSON text frames discriminated
 * by `kind`.
 *
 * This module is the authoritative home for the full WS session contract:
 * every frame type and the canonical Zod schema that validates it on the
 * wire lives here. Host-side dispatch, client-side transport, and any
 * future mirror implementations must parse frames through these schemas so
 * shapes on the wire stay byte-identical across sides.
 */

/**
 * Per-method canonical version manifest exchanged on connection open.
 *
 * Each side advertises, per known method, only its canonical (highest
 * installed) `{ major, minor }`. Local registries carry the structural
 * invariants required to answer "can I bridge from my canonical to theirs?"
 * without extra data on the wire.
 */
export type ConnectionManifest = Readonly<Record<string, SchemaVersion>>;

/**
 * Discriminated reason for a method being incompatible between two sides.
 *
 * - `client-missing-method`: host advertises the method; client does not.
 * - `host-missing-method`: client advertises the method; host does not.
 * - `no-bridge`: both sides advertise the method but neither side can bridge
 *   between the two canonicals using its installed upgrade/downgrade paths.
 */
export type IncompatibleMethodBlocking =
  "client-missing-method" | "host-missing-method" | "no-bridge";

/**
 * Per-method incompatibility record carried on a fatal error frame. Either
 * canonical may be `null` when the method is absent from that side.
 */
export type IncompatibleMethodDetails = {
  readonly method: string;
  readonly clientCanonical: SchemaVersion | null;
  readonly hostCanonical: SchemaVersion | null;
  readonly blocking: IncompatibleMethodBlocking;
};

/**
 * Hints for which side should upgrade when a connection is terminated for
 * incompatibility. Both flags may be `true` when the break is mutual.
 */
export type IncompatibilityUpgradeGuidance = {
  readonly clientShouldUpgrade: boolean;
  readonly hostShouldUpgrade: boolean;
};

/**
 * Fatal code emitted when the unary host sent `openAck` but did not observe the
 * client's `request` before its bounded post-open deadline. This is a transport
 * timeout, not an authentication rejection: the request was never dispatched,
 * so a client may safely retry even a non-idempotent method on a fresh socket.
 */
export const RPC_REQUEST_TIMEOUT_FATAL_CODE = "RPC_REQUEST_TIMEOUT";

/**
 * Fatal code a host emits on every live connection when it is deliberately
 * standing itself down and expects to come back - the restart tombstone
 * (connection registry §3 / D5 / M1). Always paired with `retryable: true`
 * and a {@link FatalErrorDetails.restartIntent} payload.
 *
 * The code is stable and separate from the payload on purpose: the payload is
 * what a selection authority acts on, while the code is what a log line, a
 * support transcript, or a client that never grew the payload reads.
 */
export const HOST_RESTARTING_FATAL_CODE = "HOST_RESTARTING";

/**
 * The restart tombstone a host publishes to every client attached to it, at
 * the moment it latches restart intent and before any teardown step runs.
 *
 * It rides {@link FatalErrorDetails} rather than a frame kind of its own
 * because that one payload is shared verbatim by all three host->client
 * planes - the unary `/rpc` `fatalError` frame, the `/stream` `fatalError`
 * frame, and the relay mux's `FATAL` on the session control stream - so one
 * additive field reaches every attached client whatever transport it holds.
 * The alternatives are both fail-closed against peers that predate them: a
 * new mux frame type throws `MuxFrameDecodeError` in `decodeMuxFrame`
 * (unknown type bytes are rejected, not skipped), and a new `/stream` control
 * kind falls through to the application-frame envelope, whose required
 * `hasBinaryPayload` is absent - tearing the socket down as malformed.
 *
 * A new METHOD name does not fit either, though the reason is narrower than
 * "the release invariant forbids it" - a new OPTIONAL stream method is
 * additive and degrades quietly, as this repo's own two-sided tests show. It
 * fails for a different reason: a method is something a client SUBSCRIBES to,
 * and this frame has to reach peers that already hold whatever sessions they
 * hold, at the instant the host is going down. A host cannot make an attached
 * client subscribe to a new method retroactively, so the ones that never did
 * would hear nothing. Putting it on the FLOOR instead - so every peer must
 * serve it - is what the release invariant genuinely bars, since a floor
 * addition breaks every host below the version bump.
 *
 * `tombstoneId` is minted once per teardown episode and is IDENTICAL on every
 * connection and both planes. That is what makes the authority's
 * (hostId, tombstoneId) episode key work: first receipt anchors one fixed
 * expected-outage episode and every duplicate - another window, the other
 * plane, a replay - is inert.
 *
 * `expiresAt` is the HOST's clock (epoch ms) and is display-only; an
 * authority bounds the episode with its own ceiling, never with a peer's
 * clock.
 */
export type HostRestartIntent = {
  readonly tombstoneId: string;
  readonly expiresAt: number | null;
};

/**
 * Full detail payload carried by a fatal error frame prior to WebSocket
 * close. The subsequent close event is only the fatal signal - all rich
 * detail MUST travel inside this frame.
 */
export type FatalErrorDetails = {
  readonly code: string;
  readonly reason: string;
  readonly incompatibleMethods: readonly IncompatibleMethodDetails[] | null;
  readonly upgradeGuidance: IncompatibilityUpgradeGuidance | null;
  /**
   * When `true`, the rejection is transient and host-side (e.g. the host's
   * JWKS fetch timed out while verifying the bearer, or a post-open frame
   * deadline elapsed while a process was suspended) - NOT a statement about the
   * credential's authenticity. A client that understands this field should
   * reconnect with plain backoff instead of running credential recovery or
   * going terminal. Additive and optional: an older host omits it entirely and
   * a newer client then reads "not retryable".
   */
  readonly retryable?: boolean;
  /**
   * Present exactly when this connection is being closed by a host that is
   * deliberately restarting - see {@link HostRestartIntent} and
   * {@link HOST_RESTARTING_FATAL_CODE}. Additive and optional in both
   * directions: an older host omits it and a newer client reads "no
   * tombstone" (bouncing exactly as it does today), while an older client
   * STRIPS it at the schema below and handles the frame as the ordinary
   * retryable fatal it already understands.
   */
  readonly restartIntent?: HostRestartIntent;
};

/**
 * First frame sent by the client: bearer token plus the client's per-method
 * canonical manifest.
 */
export type ClientOpenFrame = {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: ConnectionManifest;
  readonly optionalManifest?: ConnectionManifest;
};

/**
 * Single request frame sent by the client after a successful ack from the
 * host and a successful client-side compatibility check against the host
 * manifest. Carries the envelope `dispatchRpc()` already accepts.
 */
export type ClientRequestFrame = {
  readonly kind: "request";
  readonly requestId: string;
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly params: unknown;
};

/**
 * Fatal error frame emitted by the client (typically when its mirror-check
 * against the host manifest fails). Followed by a WebSocket close.
 */
export type ClientFatalErrorFrame = {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
};

/**
 * Discriminated union of every frame the client may emit over the life of a
 * connection.
 */
export type ClientFrame =
  ClientOpenFrame | ClientRequestFrame | ClientFatalErrorFrame;

/**
 * Host acknowledgement of a successful token + compatibility check, carrying
 * the host's per-method canonical manifest so the client can run its own
 * mirror check.
 */
export type HostOpenAckFrame = {
  readonly kind: "openAck";
  readonly manifest: ConnectionManifest;
  readonly optionalManifest?: ConnectionManifest;
};

/**
 * Single response frame emitted by the host. Mirrors the envelope
 * `dispatchRpc()` already emits; `result` and `error` are mutually exclusive
 * and exactly one is populated on any given frame.
 */
export type HostResponseFrame = {
  readonly kind: "response";
  readonly requestId: string;
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly result: unknown | null;
  readonly error: { readonly code: string; readonly message: string } | null;
};

/**
 * Fatal error frame emitted by the host for authentication, compatibility,
 * or stream-domain rejection. Followed by a WebSocket close.
 */
export type HostFatalErrorFrame = {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
};

/**
 * Discriminated union of every frame the host may emit over the life of a
 * connection.
 */
export type HostFrame =
  HostOpenAckFrame | HostResponseFrame | HostFatalErrorFrame;

// ---- Canonical Zod schemas -------------------------------------------- //

/** Canonical schema for `{ major, minor }` on the wire. */
export const schemaVersionSchema = z.object({
  major: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
});

/**
 * Canonical schema for the per-method canonical version manifest exchanged
 * on `open` / `openAck`.
 */
export const connectionManifestSchema = z.record(
  z.string(),
  schemaVersionSchema,
);

/**
 * Canonical schema for the per-method incompatibility record carried on a
 * fatal error frame.
 */
export const incompatibleMethodDetailsSchema = z.object({
  method: z.string(),
  clientCanonical: schemaVersionSchema.nullable(),
  hostCanonical: schemaVersionSchema.nullable(),
  blocking: z.enum([
    "client-missing-method",
    "host-missing-method",
    "no-bridge",
  ]),
});

/** Canonical schema for upgrade-guidance hints on a fatal error frame. */
export const incompatibilityUpgradeGuidanceSchema = z.object({
  clientShouldUpgrade: z.boolean(),
  hostShouldUpgrade: z.boolean(),
});

/** Canonical schema for the restart tombstone carried on a fatal error frame. */
export const hostRestartIntentSchema = z.object({
  tombstoneId: z.string().min(1),
  // The host's own clock, and display-only - so a peer whose clock is absurd
  // costs a wrong tooltip, never a wrong deadline. Nullable rather than
  // omitted-when-unknown: "the host did not say" is a real answer here.
  expiresAt: z.number().nullable(),
});

/**
 * Canonical schema for the full detail payload carried by a fatal error
 * frame.
 *
 * Deliberately NOT `.strict()`, and load-bearingly so: every additive field
 * below (`retryable`, `restartIntent`) is backward-safe precisely because a
 * peer that predates it parses the frame with its own older copy of this
 * schema, which STRIPS the unknown key instead of rejecting the frame. A
 * `.strict()` here would turn each future addition into a connection-killing
 * parse error on every older peer in the field.
 */
export const fatalErrorDetailsSchema = z.object({
  code: z.string().min(1),
  reason: z.string(),
  incompatibleMethods: z.array(incompatibleMethodDetailsSchema).nullable(),
  upgradeGuidance: incompatibilityUpgradeGuidanceSchema.nullable(),
  // Additive/optional: an older host omits it, so a newer client parsing an
  // older host's frame reads `undefined` (not retryable). Set `true` only for
  // transient host-side rejections (e.g. a JWKS fetch or post-open frame
  // timeout) that the client recovers from with plain reconnect backoff, not
  // credential revalidation.
  retryable: z.boolean().optional(),
  // Additive/optional, same rule as `retryable`: absent from every host that
  // predates the restart tombstone, and stripped by every client that does.
  restartIntent: hostRestartIntentSchema.optional(),
});

/** Canonical schema for the client `open` frame. */
export const clientOpenFrameSchema = z.object({
  kind: z.literal("open"),
  token: z.string(),
  manifest: connectionManifestSchema,
  optionalManifest: connectionManifestSchema.optional(),
});

/** Canonical schema for the client `request` frame. */
export const clientRequestFrameSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().min(1),
  method: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  params: z.unknown(),
});

/** Canonical schema for the client `fatalError` frame. */
export const clientFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

/**
 * Discriminated-union schema covering every frame the client may emit. Use
 * this from the host side to parse an inbound text frame directly into the
 * `ClientFrame` union type.
 */
export const clientFrameSchema = z.discriminatedUnion("kind", [
  clientOpenFrameSchema,
  clientRequestFrameSchema,
  clientFatalErrorFrameSchema,
]);

/** Canonical schema for the host `openAck` frame. */
export const hostOpenAckFrameSchema = z.object({
  kind: z.literal("openAck"),
  manifest: connectionManifestSchema,
  optionalManifest: connectionManifestSchema.optional(),
});

/**
 * Canonical schema for the host `response` envelope's error payload. The
 * error `code` is intentionally an open string because resolvers can surface
 * arbitrary domain-specific codes; the client narrows to the known
 * `RpcErrorCode` set when it interprets the envelope.
 */
export const hostResponseErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

/** Canonical schema for the host `response` frame. */
export const hostResponseFrameSchema = z.object({
  kind: z.literal("response"),
  requestId: z.string().min(1),
  method: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  result: z.unknown().nullable(),
  error: hostResponseErrorSchema.nullable(),
});

/** Canonical schema for the host `fatalError` frame. */
export const hostFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

/**
 * Discriminated-union schema covering every frame the host may emit. Use
 * this from the client side to parse an inbound text frame directly into the
 * `HostFrame` union type.
 */
export const hostFrameSchema = z.discriminatedUnion("kind", [
  hostOpenAckFrameSchema,
  hostResponseFrameSchema,
  hostFatalErrorFrameSchema,
]);
