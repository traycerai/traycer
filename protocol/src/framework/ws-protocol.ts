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
  | "client-missing-method"
  | "host-missing-method"
  | "no-bridge";

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
   * JWKS fetch timed out while verifying the bearer) - NOT a statement about
   * the credential's authenticity. A client that understands this field should
   * reconnect with plain backoff instead of running credential recovery or
   * going terminal. Additive and optional: an older host omits it entirely and
   * a newer client then reads "not retryable".
   */
  readonly retryable?: boolean;
};

/**
 * First frame sent by the client: bearer token plus the client's per-method
 * canonical manifest.
 */
export type ClientOpenFrame = {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: ConnectionManifest;
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
  | ClientOpenFrame
  | ClientRequestFrame
  | ClientFatalErrorFrame;

/**
 * Host acknowledgement of a successful token + compatibility check, carrying
 * the host's per-method canonical manifest so the client can run its own
 * mirror check.
 */
export type HostOpenAckFrame = {
  readonly kind: "openAck";
  readonly manifest: ConnectionManifest;
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
  | HostOpenAckFrame
  | HostResponseFrame
  | HostFatalErrorFrame;

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

/**
 * Canonical schema for the full detail payload carried by a fatal error
 * frame.
 */
export const fatalErrorDetailsSchema = z.object({
  code: z.string().min(1),
  reason: z.string(),
  incompatibleMethods: z.array(incompatibleMethodDetailsSchema).nullable(),
  upgradeGuidance: incompatibilityUpgradeGuidanceSchema.nullable(),
  // Additive/optional: an older host omits it, so a newer client parsing an
  // older host's frame reads `undefined` (not retryable). Set `true` only for
  // transient host-side rejections (e.g. a JWKS fetch timeout) that the client
  // recovers from with plain reconnect backoff, not credential revalidation.
  retryable: z.boolean().optional(),
});

/** Canonical schema for the client `open` frame. */
export const clientOpenFrameSchema = z.object({
  kind: z.literal("open"),
  token: z.string(),
  manifest: connectionManifestSchema,
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
