import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { IStreamSession, StreamFrameEnvelope } from "../stream-session";
import { streamReportsOutboundDebt } from "./logical-stream";
import { TunnelStreamEndpoint } from "./tunnel-stream";

/**
 * The opening side of one `host.tunnel.open` stream: binds a subscribed
 * `IStreamSession` to a {@link TunnelStreamEndpoint} and turns the session's
 * status projection into the one thing a TCP tunnel can use - a reset.
 *
 * A tunnel NEVER survives a reconnect. The shared session re-subscribes every
 * live stream after a redial, which is right for a resumable subscription and
 * wrong here: the bytes in flight when the link dropped are gone and the peer's
 * socket with them. So the first `reconnecting` closes the stream (which also
 * removes it from the session's replay set) and reports `link-dropped`.
 */

export type HostTunnelResetReason =
  /** The accepting host refused or failed the stream; `details` is its typed verdict (`INCOMPATIBLE` with upgrade guidance for a host without tunnels). */
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails }
  /** The accepting host closed the stream without a verdict. */
  | { readonly kind: "peer-closed" }
  /** The session under the tunnel dropped; a tunnel is not resumable. */
  | { readonly kind: "link-dropped" }
  /** The peer broke the tunnel framing or overran its window, or one of this side's handlers threw. */
  | { readonly kind: "violation"; readonly reason: string };

/**
 * Thrown by {@link openHostTunnel} for a stream that cannot report its
 * outbound debt. Not a fallback to credits alone, on purpose: without the debt
 * bound a peer's credit grants are all that limits what this side queues, and
 * the only stream that would take that path in production is one somebody
 * forgot to wire.
 */
export class HostTunnelUnsupportedStreamError extends Error {
  readonly code = "TUNNEL_STREAM_DEBT_UNAVAILABLE";

  constructor() {
    super(
      "This stream does not report outbound debt, so a tunnel over it could not bound what it queues",
    );
    this.name = "HostTunnelUnsupportedStreamError";
  }
}

export interface HostTunnelHandlers {
  /** The accepting host authorized the stream; bytes written before this were held. */
  readonly onOpen: () => void;
  /** One inbound slice; owe one `ackConsumed(1)` once it has been drained. */
  readonly onData: (bytes: Uint8Array) => void;
  /** The peer half-closed. */
  readonly onEnd: () => void;
  /** The send window reopened after `write` returned `false`. */
  readonly onDrain: () => void;
  /** Both directions ended and nothing of this side's was left unsent, in the endpoint or the scheduler. Terminal. */
  readonly onFinished: () => void;
  /** The tunnel died. Terminal; at most one of `onFinished` / `onReset` fires. */
  readonly onReset: (reason: HostTunnelResetReason) => void;
}

export interface HostTunnel {
  /** `false` = stop reading the source until `onDrain` (the bytes of this call are still taken). */
  write(bytes: Uint8Array): boolean;
  /** Half-closes this direction after everything already written. */
  end(): void;
  ackConsumed(frames: number): void;
  /** Aborts the tunnel from this side. Idempotent; fires no handler. */
  reset(): void;
}

export function openHostTunnel(
  stream: IStreamSession,
  handlers: HostTunnelHandlers,
): HostTunnel {
  if (!streamReportsOutboundDebt(stream)) {
    stream.close();
    throw new HostTunnelUnsupportedStreamError();
  }
  let settled = false;
  const endpoint = new TunnelStreamEndpoint({
    role: "opener",
    sendFrame: (envelope, binaryPayload) =>
      stream.sendClientFrame(envelope, binaryPayload),
    outboundDebtBytes: () => stream.outboundDebtBytes(),
    onData: handlers.onData,
    onEnd: handlers.onEnd,
    onDrain: handlers.onDrain,
    onAccept: handlers.onOpen,
    onFinished: () => {
      if (settled) {
        return;
      }
      settled = true;
      stream.close();
      handlers.onFinished();
    },
    onFault: (reason) => fail({ kind: "violation", reason }),
  });
  stream.onOutboundProgress(() => endpoint.notifyOutboundProgress());

  function fail(reason: HostTunnelResetReason): void {
    if (settled) {
      return;
    }
    settled = true;
    endpoint.close();
    stream.close();
    try {
      handlers.onReset(reason);
    } catch {
      // Terminal, and reached from the session's status fan-out: a throwing
      // handler must not interrupt the teardown of its sibling streams.
    }
  }

  // Handled one microtask late, in arrival order. A logical stream only turns
  // `open` AFTER its first frame's handler returns, and drops client frames
  // until then - so handling `accept` inline would discard exactly the bytes
  // it releases (everything written while waiting for it).
  const inbox: Array<{
    readonly envelope: StreamFrameEnvelope;
    readonly binaryPayload: Uint8Array | null;
  }> = [];
  let draining = false;
  stream.onServerFrame((envelope, binaryPayload) => {
    inbox.push({ envelope, binaryPayload });
    if (draining) {
      return;
    }
    draining = true;
    void Promise.resolve().then(() => {
      draining = false;
      for (const frame of inbox.splice(0)) {
        endpoint.handleFrame(frame.envelope, frame.binaryPayload);
      }
    });
  });
  stream.onStatusChange((status, reason) => {
    if (status === "reconnecting") {
      fail({ kind: "link-dropped" });
      return;
    }
    if (status === "closed") {
      fail(
        reason !== null && reason.kind === "fatalError"
          ? { kind: "fatal", details: reason.details }
          : { kind: "peer-closed" },
      );
    }
  });

  return {
    write: (bytes) => endpoint.write(bytes),
    end: () => endpoint.end(),
    ackConsumed: (frames) => endpoint.ackConsumed(frames),
    reset: () => {
      if (settled) {
        return;
      }
      settled = true;
      endpoint.close();
      stream.close();
    },
  };
}
