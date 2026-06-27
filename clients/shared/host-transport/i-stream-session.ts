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
 *     compatibility check, then re-declares the same streaming method on
 *     every reconnect so the consumer never re-subscribes by hand.
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
   * Tears down the session: cancels any pending reconnect backoff, closes
   * the current socket (if any), and transitions status to `"closed"`.
   * Idempotent.
   */
  close(): void;
}
