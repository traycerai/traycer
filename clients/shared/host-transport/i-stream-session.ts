import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";

/**
 * Interface for a single open `/stream` subscription.
 * - Status changes flow through `onStatusChange` so callers can surface a connection indicator without owning the reconnect loop themselves.
 */
export type StreamConnectionStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

  /**
   * Reason surfaced alongside `"closed"` transitions so the consumer can distinguish between caller-initiated teardown and fatal-error closes originating from the host or the mirror compatibility check.
   */
export type StreamCloseReason =
  | { readonly kind: "caller" }
  | {
      readonly kind: "fatalError";
      readonly details: FatalErrorDetails;
    };

    /**
     * Whether a close reason proves the connected host cannot serve this session's method at all - the fatal class that is a statement about the host's capability rather than about this attempt.
     * Deliberately a whitelist rather than "any fatal".
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
 * Whether an incompatibility close is explicitly attributed to `method`.
 * Consumers must not treat that as proof that one optional method is absent, because doing so can incorrectly enter a legacy fallback instead of surfacing the connection incompatibility.
 */
export function isIncompatibleCloseForMethod(
  reason: StreamCloseReason | null,
  method: string,
): boolean {
  if (!isMethodIncompatibleClose(reason) || reason?.kind !== "fatalError") {
    return false;
  }
  return (
    reason.details.incompatibleMethods?.some(
      (details) => details.method === method,
    ) === true
  );
}

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
   * Sends a client frame authored by the active streaming contract.
   * The transport emits the JSON-encoded envelope first, followed (when `binaryPayload !== null`) by a binary WS frame carrying the raw bytes.
   */
  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void;

  /**
   * Installs the single handler that receives every non-control server frame.
   * Only one handler may be installed; installing a second replaces the first (matching the native WebSocket `onmessage` contract).
   */
  onServerFrame(handler: ServerFrameHandler): void;

  /**
   * Installs the single connection-status handler.
   * Fired on every transition of the reconnect state machine so UI can surface an indicator without owning the lifecycle.
   */
  onStatusChange(handler: StatusChangeHandler): void;

  /**
   * Asks this session to discard its current socket and reconnect through its existing backoff state machine.
   * Consumers keep the same session and never create their own reconnect loop.
   */
  requestReconnect(): void;

  /**
   * The schema version this session negotiated for its method, or `null` before the handshake has settled (and again after a disconnect drops it).
   * Takes no method argument: a session is bound to one streaming method for life, so the method is already implied.
   */
  getNegotiatedSchemaVersion(): SchemaVersion | null;

  /**
   * Tears down the session: cancels any pending reconnect backoff, closes the current socket (if any), and transitions status to `"closed"`.
   * Idempotent.
   */
  close(): void;
}
