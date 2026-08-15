import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

/**
 * Interface for a single open `/stream` subscription. Returned by
 * `WsStreamClient.subscribe(...)` once it has declared a streaming method on
 * the connection. The shape is intentionally generic - the discriminated
 * frame shape authored by each contract (`epicSubscribeServerFrameSchema`,
 * `notificationsSubscribeServerFrameSchema`, ...) is applied above this
 * layer by the typed wrappers that consume it.
 *
 * Lifecycle:
 *   - The session opens lazily on `WsStreamClient.subscribe(...)` - the
 *     client dials, runs the open/openAck handshake, mirrors the
 *     compatibility check, then re-declares the same streaming method with
 *     its current parameters on every reconnect so the consumer never
 *     re-subscribes by hand.
 *   - Inbound text envelopes are delivered through `onServerFrame` paired
 *     with a binary payload iff `envelope.hasBinaryPayload === true`
 *     (per the `/stream` wire protocol - a binary WS frame is the payload
 *     of the immediately preceding text envelope).
 *   - Outbound frames are sent through `sendClientFrame`. When the caller
 *     supplies a non-null binary payload the transport emits the text
 *     envelope immediately followed by a binary frame.
 *   - Status changes flow through `onStatusChange` so callers can surface a
 *     connection indicator without owning the reconnect loop themselves.
 *   - `close()` is idempotent and stops further reconnect attempts.
 */
export type StreamConnectionStatus =
  "connecting" | "open" | "reconnecting" | "closed";

/**
 * Reason surfaced alongside `"closed"` transitions so the consumer can
 * distinguish between caller-initiated teardown and fatal-error closes
 * originating from the host or the mirror compatibility check.
 */
export type StreamCloseReason =
  | { readonly kind: "caller" }
  | {
      readonly kind: "fatalError";
      readonly details: FatalErrorDetails;
    };

/**
 * Whether a close reason PROVES the connected host cannot serve this session's
 * method at all - the fatal class that is a statement about the host's
 * CAPABILITY rather than about this attempt.
 *
 * It is the only capability evidence a remote session ever produces: the mux
 * resolves an incompatible method as a fatal on the subscribe attempt rather
 * than as a queryable pre-check, so `RemoteStreamClient.getMethodSupport`
 * answers `"unknown"` forever and a consumer that waits for it waits for
 * nothing (see `getMethodSupport`'s own note). The local `StreamSession`
 * reaches the same close through its mirror check, so a caller reading this
 * gets one answer on both transports.
 *
 * Deliberately a WHITELIST rather than "any fatal". `CLIENT_CLOSED` (a late
 * subscribe on a torn-down client), `UNAUTHORIZED`, `STREAM_MESSAGE_TOO_LARGE`,
 * `PLAN_RESTRICTED` and the transport timeouts all arrive through this same
 * channel and say nothing about what the host can serve. Reading any of them as
 * incompatibility would pin a permanent "this host is too old" verdict on a
 * failure the next dial clears - and worse, on hosts that are perfectly capable.
 *
 * `INCOMPATIBLE` is the whole list, because it is the whole set that is
 * actually emitted here: `checkStreamMethodCompatibility` (both the local
 * mirror check and `RemoteSession.openSubscription`) is the only producer of a
 * capability fatal on a stream. `DOWNGRADE_UNSUPPORTED` reads like a member and
 * is NOT one - it is a `DowngradeResult` error on a unary RPC result, never a
 * `FatalErrorDetails.code` - so adding it would widen this to a code that
 * cannot arrive, which no test could ever hold honest. `FatalErrorDetails.code`
 * is an open `string` by design (older hosts must be able to send codes we do
 * not know), so this cannot be a total switch; it is a membership test, and it
 * must only name codes with a real emitter.
 */
export function isMethodIncompatibleClose(
  reason: StreamCloseReason | null,
): boolean {
  if (reason === null || reason.kind !== "fatalError") {
    return false;
  }
  return reason.details.code === "INCOMPATIBLE";
}

/**
 * Frame envelope shape exposed to session consumers. The `kind` discriminant
 * plus `hasBinaryPayload` is the minimum the transport needs to route each
 * frame; every other field is contract-specific and is preserved verbatim
 * from the wire so the typed wrappers can narrow against their Zod schema.
 */
export type StreamFrameEnvelope = {
  readonly kind: string;
  readonly hasBinaryPayload: boolean;
  readonly [key: string]: unknown;
};

export type ServerFrameHandler = (
  envelope: StreamFrameEnvelope,
  binaryPayload: Uint8Array | null,
) => void;

export type StatusChangeHandler = (
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
) => void;

export interface IStreamSession {
  /**
   * Sends a client frame authored by the active streaming contract. The
   * transport emits the JSON-encoded envelope first, followed (when
   * `binaryPayload !== null`) by a binary WS frame carrying the raw bytes.
   *
   * If the connection is mid-reconnect the frame is dropped on the floor -
   * streaming contracts are fire-and-forget by design (decision #9 in the
   * tech plan), and Y.js CRDT convergence absorbs any missed update once
   * the socket returns.
   */
  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void;

  /**
   * Installs the single handler that receives every non-control server
   * frame. The envelope is the parsed JSON of the text WS frame; the
   * binary payload is `null` unless `envelope.hasBinaryPayload` is `true`,
   * in which case it is the companion binary WS frame that followed.
   *
   * Only one handler may be installed; installing a second replaces the
   * first (matching the native WebSocket `onmessage` contract).
   */
  onServerFrame(handler: ServerFrameHandler): void;

  /**
   * Installs the single connection-status handler. Fired on every
   * transition of the reconnect state machine so UI can surface an
   * indicator without owning the lifecycle.
   */
  onStatusChange(handler: StatusChangeHandler): void;

  /**
   * Asks this session to discard its current socket and reconnect through its
   * existing backoff state machine. Consumers keep the same session and never
   * create their own reconnect loop. No-op when there is no current socket or
   * the session has already been closed.
   */
  requestReconnect(): void;

  /**
   * The schema version THIS session negotiated for its method, or `null` before
   * the handshake has settled (and again after a disconnect drops it).
   *
   * Takes no method argument: a session is bound to one streaming method for
   * life, so the method is already implied.
   *
   * Prefer this over `IHostStreamClient.getMethodSchemaVersion(method)`
   * ANYWHERE a specific session's frames are being parsed, gated, or sent. That
   * accessor is client-wide per method: `reconcileMethodSchemaVersion` reports
   * whichever live session for the method it reaches first, so with two streams
   * open on one client - two repos, two chat tabs - it can describe the OTHER
   * one. The skew is not exotic; a reconnect may reach a new host incarnation
   * and renegotiate one session while its sibling keeps the version it had.
   *
   * `null` must be treated as "not yet known", never as a floor or a ceiling:
   * fall back to the same conservative default the caller would use before any
   * handshake, and never to the client-wide value - that reintroduces exactly
   * the skew this exists to remove.
   */
  getNegotiatedSchemaVersion(): SchemaVersion | null;

  /**
   * Tears down the session: cancels any pending reconnect backoff, closes
   * the current socket (if any), and transitions status to `"closed"`.
   * Idempotent.
   */
  close(): void;
}
