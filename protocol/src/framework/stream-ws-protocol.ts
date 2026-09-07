import { z } from "zod";
import {
  connectionManifestSchema,
  schemaVersionSchema,
  fatalErrorDetailsSchema,
  type ConnectionManifest,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  clientHandshakeIdentitySchema,
  type ClientHandshakeIdentity,
} from "@traycer/protocol/framework/client-identity";
import { isoMillisecondTimestampSchema } from "@traycer/protocol/common/schemas";

/**
 * Control frames exchanged on the `/stream` WS before (and alongside) the per-method stream traffic declared by the active streaming contract.
 * These mirror the unary `/rpc` handshake plus a `subscribe` frame that declares the streaming method being activated on the connection.
 */

/**
 * Capability tag a host advertises in `openAck.capabilities` when it accepts the `credentialUpdate` control frame (in-place bearer rotation on a live stream connection, no reconnect).
 * A client MUST only send `credentialUpdate` after seeing this tag in the host's `openAck`; against an older host that omits it the client stays silent and relies on reconnect-time re-auth.
 */
export const STREAM_CAPABILITY_CREDENTIAL_UPDATE = "credentialUpdate";

/**
 * Capability tag a host advertises in `openAck.capabilities` when it accepts the `hostCredentialProvision` control frame - the delegated host-credential handoff.
 * Same contract as `credentialUpdate`: a client MUST NOT send the frame without seeing this tag, so a newer client against an older host stays silent instead of tripping the unknown-frame guard.
 */
export const STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION =
  "hostCredentialProvision";

/** What the host reports about its own device credential in `openAck`. */
export type HostCredentialState = "missing" | "active" | "needs-reauth";

export const hostCredentialStateSchema = z.enum([
  "missing",
  "active",
  "needs-reauth",
]);

/** Fatal code used by the stream host's pre-subscribe deadlines. */
export const STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE = "STREAM_SUBSCRIBE_TIMEOUT";

/** First frame sent by the client: bearer token + per-method version manifest. */
export type ClientStreamOpenFrame = {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: ConnectionManifest;
  /** Who is connecting - see {@link ClientHandshakeIdentity}. */
  readonly clientIdentity?: ClientHandshakeIdentity;
};

/**
 * Pushes a freshly-rotated bearer onto an already-open stream connection so the host updates the connection's credential lease in place - without a reconnect.
 */
export type ClientStreamCredentialUpdateFrame = {
  readonly kind: "credentialUpdate";
  readonly token: string;
};

/** Hands the host a freshly minted device credential of its own. */
export type ClientStreamHostCredentialProvisionFrame = {
  readonly kind: "hostCredentialProvision";
  readonly token: string;
  readonly refreshToken: string;
  /**
   * The credential's own refresh family, and when the server recorded it (ISO-8601, millisecond resolution).
   */
  readonly familyId: string;
  readonly provisionedAt: string;
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
 * Fatal error emitted by the client (typically when its mirror compat check against the host manifest fails).
 */
export type ClientStreamFatalErrorFrame = {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
};

/** Host ack of the open + manifest, plus the control-frame capabilities it accepts. */
export type HostStreamOpenAckFrame = {
  readonly kind: "openAck";
  readonly manifest: ConnectionManifest;
  readonly capabilities: readonly string[];
  /**
   * What the host reports about its own device credential, or `null` when it did not report at all (every host predating the delegated-credential work).
   */
  readonly hostCredentialState: HostCredentialState | null;
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
  // Additive/optional in both directions - same rule as the unary open frame.
  clientIdentity: clientHandshakeIdentitySchema.optional(),
});

export const clientStreamSubscribeFrameSchema = z.object({
  kind: z.literal("subscribe"),
  method: z.string().min(1),
  schemaVersion: schemaVersionSchema,
  params: z.unknown(),
});

export const clientStreamCredentialUpdateFrameSchema = z.object({
  kind: z.literal("credentialUpdate"),
  token: z.string().min(1),
});

export const clientStreamHostCredentialProvisionFrameSchema = z.object({
  kind: z.literal("hostCredentialProvision"),
  token: z.string().min(1),
  refreshToken: z.string().min(1),
  familyId: z.string().min(1),
  // The exact wire form is enforced here, not left to the host: the adoption rule ORDERS by this value, so a shape it was not written for - a date-only string, a coarser or finer sub-second resolution - orders wrongly.
  // Same schema as the HTTP mint response, so the two cannot drift.
  provisionedAt: isoMillisecondTimestampSchema,
});

export const clientStreamFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

export const hostStreamOpenAckFrameSchema = z.object({
  kind: z.literal("openAck"),
  manifest: connectionManifestSchema,
  capabilities: z.array(z.string()).default([]),
  // Backward-compat: an older host omits `hostCredentialState`.
  // It defaults to `null` ("did not report"), which the client treats as "do not provision" - see the field's doc comment on `HostStreamOpenAckFrame`.
  hostCredentialState: hostCredentialStateSchema.nullable().default(null),
});

export const hostStreamFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

/**
 * Text-envelope shape used for every post-`openAck` frame authored by a streaming contract (both directions).
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
