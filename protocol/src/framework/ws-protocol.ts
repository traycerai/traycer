import { z } from "zod";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  clientCompatibilityRequirementSchema,
  clientHandshakeIdentitySchema,
  type ClientCompatibilityRequirement,
  type ClientHandshakeIdentity,
} from "@traycer/protocol/framework/client-identity";
import {
  holdersRevisionWireFieldSchema,
  worktreeBusyHoldersWireFieldSchema,
  type WorktreeBusyHolder,
} from "./worktree-busy-holders";

/**
 * Wire-level frame types for the per-request WebSocket RPC protocol.
 * Host-side dispatch, client-side transport, and any future mirror implementations must parse frames through these schemas so shapes on the wire stay byte-identical across sides.
 */

export type ConnectionManifest = Readonly<Record<string, ManifestMethodEntry>>;

/** Discriminated reason for a method being incompatible between two sides. */
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
 * Fatal code emitted when the unary host sent `openAck` but did not observe the client's `request` before its bounded post-open deadline.
 * This is a transport timeout, not an authentication rejection: the request was never dispatched, so a client may safely retry even a non-idempotent method on a fresh socket.
 */
export const RPC_REQUEST_TIMEOUT_FATAL_CODE = "RPC_REQUEST_TIMEOUT";

/**
 * Host-to-client unary capability: this exact host handshake accepts a stable per-request idempotency key and deduplicates it for the authenticated user.
 * If the guarantee ever changes, a new name must be introduced; this string must never be redefined in place.
 */
export const UNARY_CAPABILITY_IDEMPOTENCY_KEY = "unary.idempotencyKey";

/**
 * Client-to-host capability for the first write-path command contract.
 * As with every capability name, changed semantics get a new name instead of silently widening this contract.
 */
export const CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1 = "epic.writePath/1";

/**
 * Fatal code a host emits on every live connection when it is deliberately standing itself down and expects to come back - the restart tombstone (connection registry §3 / D5 / M1).
 * The code is stable and separate from the payload on purpose: the payload is what a selection authority acts on, while the code is what a log line, a support transcript, or a client that never grew the payload reads.
 */
export const HOST_RESTARTING_FATAL_CODE = "HOST_RESTARTING";

/**
 * The restart tombstone a host publishes to every client attached to it, at the moment it latches restart intent and before any teardown step runs.
 * A host cannot make an attached client subscribe to a new method retroactively, so the ones that never did would hear nothing.
 */
export type HostRestartIntent = {
  readonly tombstoneId: string;
  readonly expiresAt: number | null;
};

/**
 * Full detail payload carried by a fatal error frame prior to WebSocket close.
 * The subsequent close event is only the fatal signal - all rich detail MUST travel inside this frame.
 */
export type FatalErrorDetails = {
  readonly code: string;
  readonly reason: string;
  readonly incompatibleMethods: readonly IncompatibleMethodDetails[] | null;
  readonly upgradeGuidance: IncompatibilityUpgradeGuidance | null;
  readonly retryable?: boolean;
  readonly restartIntent?: HostRestartIntent;
  /**
   * Present exactly when this connection was refused by the host's CLIENT COMPATIBILITY EPOCH gate - see {@link ClientCompatibilityRequirement}.
   * That is precisely why the epoch rejection keeps the existing `INCOMPATIBLE` code and why its `reason` has to be independently actionable - the clients that most need to read it are the ones that cannot see this field.
   */
  readonly clientCompatibilityRequirement?: ClientCompatibilityRequirement;
};

/**
 * First frame sent by the client: bearer token plus the client's per-method
 * version manifest.
 */
export type ClientOpenFrame = {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: ConnectionManifest;
  readonly optionalManifest?: ConnectionManifest;
  /** Additive capabilities this client can classify or receive. */
  readonly capabilities?: readonly string[];
  /** Who is connecting - see {@link ClientHandshakeIdentity}. */
  readonly clientIdentity?: ClientHandshakeIdentity;
};

/**
 * Single request frame sent by the client after a successful ack from the host and a successful client-side compatibility check against the host manifest.
 */
export type ClientRequestFrame = {
  readonly kind: "request";
  readonly requestId: string;
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly params: unknown;
  /**
   * Non-null only after this connection's host openAck advertised {@link UNARY_CAPABILITY_IDEMPOTENCY_KEY}.
   */
  readonly idempotencyKey?: string | null;
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
 * Host acknowledgement of a successful token + compatibility check, carrying the host's selected per-method manifest so the client can run its own mirror check.
 */
export type HostOpenAckFrame = {
  readonly kind: "openAck";
  readonly manifest: ConnectionManifest;
  readonly optionalManifest?: ConnectionManifest;
  /** Additive capabilities this exact host connection can honour. */
  readonly capabilities?: readonly string[];
};

/** Single response frame emitted by the host. */
export type HostResponseFrame = {
  readonly kind: "response";
  readonly requestId: string;
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly result: unknown | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly holders?: readonly WorktreeBusyHolder[];
    readonly holdersRevision?: string;
  } | null;
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
 * Per-method manifest entry.
 * This deliberately remains non-strict: a newer peer's future additive keys must be stripped by an older peer rather than rejecting an otherwise compatible connection.
 */
export const manifestMethodEntrySchema = schemaVersionSchema.extend({
  supportedMajors: z.array(z.number().int().nonnegative()).min(1).optional(),
});

export type ManifestMethodEntry = z.infer<typeof manifestMethodEntrySchema>;

/**
 * Canonical schema for the per-method version manifest exchanged on `open` /
 * `openAck`.
 */
export const connectionManifestSchema = z.record(
  z.string(),
  manifestMethodEntrySchema,
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
  // The host's own clock, and display-only - so a peer whose clock is absurd costs a wrong tooltip, never a wrong deadline.
  // Nullable rather than omitted-when-unknown: "the host did not say" is a real answer here.
  expiresAt: z.number().nullable(),
});

/** Canonical schema for the full detail payload carried by a fatal error frame. */
export const fatalErrorDetailsSchema = z.object({
  code: z.string().min(1),
  reason: z.string(),
  incompatibleMethods: z.array(incompatibleMethodDetailsSchema).nullable(),
  upgradeGuidance: incompatibilityUpgradeGuidanceSchema.nullable(),
  // Additive/optional: an older host omits it, so a newer client parsing an older host's frame reads `undefined` (not retryable).
  retryable: z.boolean().optional(),
  // Additive/optional, same rule as `retryable`: absent from every host that
  // predates the restart tombstone, and stripped by every client that does.
  restartIntent: hostRestartIntentSchema.optional(),
  clientCompatibilityRequirement:
    clientCompatibilityRequirementSchema.optional(),
});

export const clientOpenFrameSchema = z.object({
  kind: z.literal("open"),
  token: z.string(),
  manifest: connectionManifestSchema,
  optionalManifest: connectionManifestSchema.optional(),
  capabilities: z.array(z.string()).optional(),
  clientIdentity: clientHandshakeIdentitySchema.optional(),
});

export const clientRequestFrameSchema = z.object({
  kind: z.literal("request"),
  requestId: z.string().min(1),
  method: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  params: z.unknown(),
  idempotencyKey: z.string().min(1).nullable().optional(),
});

/** Canonical schema for the client `fatalError` frame. */
export const clientFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

/** Discriminated-union schema covering every frame the client may emit. */
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
  capabilities: z.array(z.string()).optional(),
});

export const hostResponseErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  // Typed `WORKTREE_BUSY` inventory.
  // Malformed values are sanitized to absent rather than rejecting the envelope - adding this optional field must never fail a `{ code, message }` that parsed before it.
  holders: worktreeBusyHoldersWireFieldSchema,
  holdersRevision: holdersRevisionWireFieldSchema,
});

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

/** Discriminated-union schema covering every frame the host may emit. */
export const hostFrameSchema = z.discriminatedUnion("kind", [
  hostOpenAckFrameSchema,
  hostResponseFrameSchema,
  hostFatalErrorFrameSchema,
]);
