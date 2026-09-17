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

/**
 * Capability tag a host advertises in `openAck.capabilities` when it accepts
 * the `credentialUpdate` control frame (in-place bearer rotation on a live
 * stream connection, no reconnect). A client MUST only send `credentialUpdate`
 * after seeing this tag in the host's `openAck`; against an older host that
 * omits it the client stays silent and relies on reconnect-time re-auth. This
 * keeps a newer-client / older-host pairing from tripping the host's
 * unknown-frame guard and dropping the connection.
 */
export const STREAM_CAPABILITY_CREDENTIAL_UPDATE = "credentialUpdate";

/**
 * Capability tag a host advertises in `openAck.capabilities` when it accepts the
 * `hostCredentialProvision` control frame - the delegated host-credential
 * handoff. Same contract as `credentialUpdate`: a client MUST NOT send the frame
 * without seeing this tag, so a newer client against an older host stays silent
 * instead of tripping the unknown-frame guard.
 *
 * The two capabilities are deliberately independent. `credentialUpdate` pushes
 * the USER's rotated bearer onto a live connection; this one hands the host its
 * OWN long-lived credential, which it then refreshes autonomously.
 */
export const STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION =
  "hostCredentialProvision";

/**
 * Capability tag a host advertises in `openAck.capabilities` when it accepts the
 * `cloudVerdictUpdate` control frame - an in-place change to what this session's
 * credential may BUY, with no reconnect and no bearer rotation. Same contract as
 * the two tags above: a client MUST NOT send the frame without seeing this tag,
 * so a newer client against an older host stays silent instead of tripping the
 * unknown-frame guard.
 *
 * Deliberately independent of `credentialUpdate`, and the independence is the
 * whole reason this is a sibling frame rather than a field on that one. The two
 * events do not coincide in either direction:
 *
 *   - A verdict change with NO rotation. A demotion whose store is merely
 *     unavailable leaves the bearer untouched, and a regain after a successful
 *     `validateToken` rotates nothing. Riding the credential frame would make
 *     both transitions unsendable without fabricating a redundant token push.
 *   - A rotation with NO verdict change: every ordinary refresh. Overloading the
 *     frame would make each rotation implicitly re-assert a verdict, so a
 *     refresh racing a demotion could silently re-authorize a session that had
 *     just lost its verdict.
 *
 * "What the token IS" and "what the token may BUY" are two claims, so they get
 * two frames - exactly the split `credentialUpdate` and `hostCredentialProvision`
 * are already documented as being kept apart for.
 */
export const STREAM_CAPABILITY_CLOUD_VERDICT_UPDATE = "cloudVerdictUpdate";

/**
 * What the host reports about its own device credential in `openAck`.
 *
 *   - `missing`      - the host holds no credential and can accept a handoff.
 *   - `active`       - the host holds one it believes is usable; do not mint.
 *   - `needs-reauth` - the host held one and its refresh family is dead
 *                      (revoked, superseded, or expired); a fresh handoff is
 *                      the recovery door.
 */
export type HostCredentialState = "missing" | "active" | "needs-reauth";

export const hostCredentialStateSchema = z.enum([
  "missing",
  "active",
  "needs-reauth",
]);

/**
 * Fatal code used by the stream host's pre-subscribe deadlines. In particular,
 * when the host sent `openAck` but did not observe the client's `subscribe`, it
 * pairs this code with `retryable: true`. Older hosts omit the additive flag, so
 * clients also use this stable code as the backward-compatible recovery signal.
 */
export const STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE = "STREAM_SUBSCRIBE_TIMEOUT";

/**
 * The lifecycle codes a host's chat session answers when a `chat.subscribe`
 * reaches it at the wrong moment, rather than with a verdict on the chat:
 *
 *   - `SESSION_NOT_READY` - the session has not finished opening, or a field a
 *     subscribe needs was released under it.
 *   - `SESSION_CLOSED` - the session is shutting down. The next subscribe
 *     opens a fresh one.
 *
 * Either one means "ask again". Hosts released before these codes were
 * flagged send them as plain fatals without `retryable`, so a client that read
 * only the flag went terminal on a chat its next attempt would have opened.
 * That is the "Still opening this agent" incident: Try again closed the socket
 * while the open was under way, the host tore the session down under the
 * subscribe that was joining it, and that subscribe answered
 * `SESSION_NOT_READY`. See `isRetryableSessionLifecycleFatal` for the method
 * guard both transports apply.
 */
export const SESSION_NOT_READY_FATAL_CODE = "SESSION_NOT_READY";
export const SESSION_CLOSED_FATAL_CODE = "SESSION_CLOSED";

/** First frame sent by the client: bearer token + per-method version manifest. */
export type ClientStreamOpenFrame = {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: ConnectionManifest;
  /**
   * Who is connecting - see {@link ClientHandshakeIdentity}. The `/stream`
   * socket authenticates independently of `/rpc`, so it gates independently
   * too and carries its own copy of the same process-constant identity.
   */
  readonly clientIdentity?: ClientHandshakeIdentity;
  /**
   * Whether this session may spend a CLOUD CAPABILITY on the account behind
   * `token` - the client's own admission/authorization split asserted to the
   * host, so host-side background work inherits it.
   *
   * PRESENCE IS THE DECLARATION, and that is what makes the default per-connection
   * rather than global. A peer that omits the field predates the capability and
   * has no unauthorized state to be in, so the host reads it as authorized; a peer
   * that sends it has one, and the host uses the value. Neither global default is
   * right on its own: fail-closed would refuse every released client, CLI and
   * extension outright, while fail-open would keep a verdict-speaking client
   * spending after a demotion whose frame went missing.
   *
   * It rides `open` rather than waiting for a control frame precisely so there is
   * no window in which a capable, demoted client is authorized by default - its
   * verdict is present in its first frame, before any resolver runs. Subsequent
   * changes travel on `cloudVerdictUpdate`.
   *
   * Additive and optional on the wire, so it needs no capability tag to SEND:
   * zod objects are non-strict, so an older host strips the key and behaves
   * exactly as it does today. The tag gates the control frame, which is the half
   * that would otherwise trip an older host's unknown-frame guard.
   */
  readonly cloudAuthorized?: boolean;
};

/**
 * Pushes a freshly-rotated bearer onto an already-open stream connection so the
 * host updates the connection's credential lease in place - without a reconnect.
 * Sent only after a proactive/reactive token refresh and only when the host
 * advertised `credentialUpdate` support in its `openAck`. The host re-verifies
 * the token (signature + owner binding) and rotates only on a same-user match.
 */
export type ClientStreamCredentialUpdateFrame = {
  readonly kind: "credentialUpdate";
  readonly token: string;
};

/**
 * Hands the host a freshly minted device credential of its own. Sent at most
 * once per acquisition, only after the host advertised
 * `hostCredentialProvision` AND reported a `hostCredentialState` other than
 * `active`. The client mints it against authn-v3 with its own step-up-fresh
 * bearer; the host verifies the access JWS (own `hostId`, connection's verified
 * user) and treats `refreshToken` as OPAQUE - only authn-v3 can decrypt it, so
 * the host's first scheduled rotation is its real validation.
 *
 * Fire-and-forget by design: there is no host->client ack in v1. Whether the
 * handoff stuck is reported by the NEXT connection's `openAck.hostCredentialState`.
 */
export type ClientStreamHostCredentialProvisionFrame = {
  readonly kind: "hostCredentialProvision";
  readonly token: string;
  readonly refreshToken: string;
  /**
   * The credential's own refresh family, and when the server recorded it
   * (ISO-8601, millisecond resolution).
   *
   * **These two ARE the adoption rule.** A host handed two credentials keeps the
   * one with the greater `(provisionedAt, familyId)` tuple - the same total
   * order the server's supersede sweep uses, with `familyId` as the tie-break at
   * equal timestamps. They are on the frame rather than left to be read out of
   * the token because neither is derivable from it: the access JWS carries no
   * `familyId`, and its `iat` is a DIFFERENT order (a mint records its row
   * before it signs, so a stalled request carries the later `iat` on the earlier
   * row) at one-second resolution. A host ordering by `iat` can adopt exactly
   * the credential the server retired and then sit tokenless.
   */
  readonly familyId: string;
  readonly provisionedAt: string;
};

/**
 * Pushes a changed cloud verdict onto an already-open stream connection so the
 * host updates every request context bound to it IN PLACE - no reconnect, and
 * no bearer rotation.
 *
 * Sent only after the host advertised {@link STREAM_CAPABILITY_CLOUD_VERDICT_UPDATE}.
 * A client that sends this frame necessarily speaks verdicts and so also declared
 * `cloudAuthorized` on its `open` frame - but the host does NOT condition on
 * having seen that declaration, and deliberately so. The two ways of being wrong
 * are not symmetric: honouring a verdict from a peer the host had filed as legacy
 * costs at most a refused cloud call the peer asked to have refused, while
 * ignoring one costs a demoted session that keeps spending. Only the second
 * failure direction spends, so the frame is honoured whenever it arrives.
 *
 * Carries the ABSOLUTE verdict rather than an edge. A lost or reordered frame
 * then converges on the next one instead of leaving the two sides disagreeing
 * about how many transitions have happened - the same reason `credentialUpdate`
 * carries the token rather than "rotate now".
 */
export type ClientStreamCloudVerdictUpdateFrame = {
  readonly kind: "cloudVerdictUpdate";
  readonly cloudAuthorized: boolean;
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

/** Host ack of the open + manifest, plus the control-frame capabilities it accepts. */
export type HostStreamOpenAckFrame = {
  readonly kind: "openAck";
  readonly manifest: ConnectionManifest;
  /**
   * Optional, additive control-frame capabilities (e.g.
   * `credentialUpdate`). A client only uses a capability it finds here; an
   * older host omits the field entirely and the schema defaults it to `[]`,
   * so a newer client safely reads "none supported".
   */
  readonly capabilities: readonly string[];
  /**
   * What the host reports about its own device credential, or `null` when it
   * did not report at all (every host predating the delegated-credential work).
   *
   * `null` is NOT "missing". A client provisions only on an explicit
   * `missing` / `needs-reauth`, so an unreported state can never trigger the
   * interactive mint - the failure mode of guessing wrong here is an
   * unprompted-for OTP challenge, which is exactly what must not happen by
   * accident.
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
  // `.optional()` and NOT `.default(true)`. The host has to be able to tell
  // "this peer says it is authorized" from "this peer does not speak verdicts":
  // the first may later be withdrawn by a control frame, the second may not, and
  // a default would erase the distinction at the parse boundary where it is
  // still recoverable. `undefined` reaching `createRequestContext` is the same
  // absence, and reads as authorized there.
  cloudAuthorized: z.boolean().optional(),
});

export const clientStreamCloudVerdictUpdateFrameSchema = z.object({
  kind: z.literal("cloudVerdictUpdate"),
  cloudAuthorized: z.boolean(),
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
  // The exact wire form is enforced here, not left to the host: the adoption
  // rule ORDERS by this value, so a shape it was not written for - a date-only
  // string, a coarser or finer sub-second resolution - orders wrongly rather
  // than loudly, and would strand a host on a credential the server had already
  // retired. Same schema as the HTTP mint response, so the two cannot drift.
  provisionedAt: isoMillisecondTimestampSchema,
});

export const clientStreamFatalErrorFrameSchema = z.object({
  kind: z.literal("fatalError"),
  details: fatalErrorDetailsSchema,
});

export const hostStreamOpenAckFrameSchema = z.object({
  kind: z.literal("openAck"),
  manifest: connectionManifestSchema,
  // Backward-compat: an older host omits `capabilities`; default to none so a
  // newer client parsing an older host's ack still succeeds and treats every
  // capability as unsupported.
  capabilities: z.array(z.string()).default([]),
  // Backward-compat: an older host omits `hostCredentialState`. It defaults to
  // `null` ("did not report"), which the client treats as "do not provision" —
  // see the field's doc comment on `HostStreamOpenAckFrame`.
  hostCredentialState: hostCredentialStateSchema.nullable().default(null),
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
