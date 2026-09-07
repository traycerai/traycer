/**
 * The main-thread half of the stream proxy.
 * It is deliberately the only object on this side that knows a worker exists: the durable transport it is built over is untouched, and `detachTransport()` acts on this, not on the socket.
 */
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  MainToWorkerEvent,
  StreamProxyWorkerEvent,
} from "./bridge-protocol";
import {
  EPIC_WORKER_STREAM_METHODS,
  OPEN_PARAMS_PARSERS,
  parseStreamProxyFrame,
  STREAM_PROXY_UNKNOWN_METHOD_CODE,
  type EpicWorkerStreamMethod,
} from "./stream-proxy-protocol";
import { takeBytesForTransfer, NO_TRANSFER } from "./transferable-bytes";

export type StreamProxyPush = (
  event: MainToWorkerEvent,
  transfer: readonly ArrayBuffer[],
) => void;

export interface StreamProxyHost {
  /**
   * Applies one worker->main stream event.
   * Takes the narrowed family rather than the whole union, and answers nothing.
   */
  handle(event: StreamProxyWorkerEvent): void;
  /** Closes every real session this host opened. Idempotent. */
  dispose(): void;
  /** How many real sessions are open. For the leak pin. */
  openCount(): number;
}

/** Narrows a wire method to the closed union without asserting. */
function isCarriedMethod(method: string): method is EpicWorkerStreamMethod {
  return Object.hasOwn(EPIC_WORKER_STREAM_METHODS, method);
}

export function createStreamProxyHost(
  streams: IStreamClient<HostStreamRpcRegistry>,
  push: StreamProxyPush,
  /**
   * Where a rejected frame's reason goes.
   * Required, not optional: a frame dropped silently on this path is indistinguishable from a host that went quiet, and this is the boundary a stale chunk arrives at.
   */
  onReject: (reason: string) => void,
): StreamProxyHost {
  const sessions = new Map<number, IStreamSession>();
  const heldParams = new Map<number, unknown>();
  let disposed = false;

  function wire(streamId: number, session: IStreamSession): void {
    session.onServerFrame((envelope, binaryPayload) => {
      const prepared =
        binaryPayload === null ? null : takeBytesForTransfer(binaryPayload);
      push(
        {
          kind: "stream/frame",
          frame: {
            streamId,
            envelope,
            binaryPayload: prepared === null ? null : prepared.bytes,
          },
        },
        prepared === null ? NO_TRANSFER : prepared.transfer,
      );
    });
    session.onStatusChange((status, reason) => {
      // Version before status, so a worker reacting to `open` already reads the version negotiated for it.
      // Achievable because the real session sets its version before transitioning and clears it on the first line of `resetForReconnect` - both checked at source.
      push(
        {
          kind: "stream/session-version",
          version: {
            streamId,
            version: session.getNegotiatedSchemaVersion(),
          },
        },
        NO_TRANSFER,
      );
      push(
        { kind: "stream/status", status: { streamId, status, reason } },
        NO_TRANSFER,
      );
    });
  }

  function refuseUnknownMethod(streamId: number, method: string): void {
    // Synthetic, because there is no real session to transition.
    push(
      {
        kind: "stream/status",
        status: {
          streamId,
          status: "closed",
          reason: {
            kind: "fatalError",
            details: {
              code: STREAM_PROXY_UNKNOWN_METHOD_CODE,
              reason: `The runtime worker stream proxy does not carry '${method}'`,
              incompatibleMethods: null,
              upgradeGuidance: null,
            },
          },
        },
      },
      NO_TRANSFER,
    );
  }

  return {
    handle(event): void {
      if (disposed) return;
      switch (event.kind) {
        case "stream/open": {
          const { streamId, method, params, withParamsProvider } = event.open;
          if (!isCarriedMethod(method)) {
            refuseUnknownMethod(streamId, method);
            return;
          }
          // Raw is held, parsed is handed over: the provider re-parses each time, so a pushed params value is validated on the same path as the opening one rather than trusted because it arrived later.
          heldParams.set(streamId, params);
          const session = withParamsProvider
            ? streams.subscribeWithParamsProvider(method, () =>
                // Re-read on every wire subscribe, including a reconnect re-declare.
                // Answers from the last value the worker pushed: the provider itself cannot cross, because `WsStreamClient` invokes it synchronously and a bridge round trip is not.
                OPEN_PARAMS_PARSERS[method](heldParams.get(streamId) ?? params),
              )
            : streams.subscribe(method, OPEN_PARAMS_PARSERS[method](params));
          sessions.set(streamId, session);
          wire(streamId, session);
          return;
        }
        case "stream/params": {
          // A params push for a stream this host no longer holds is dropped -
          // the worker closed it, or an older generation is still draining.
          if (!sessions.has(event.params.streamId)) return;
          heldParams.set(event.params.streamId, event.params.params);
          return;
        }
        case "stream/send": {
          const parsed = parseStreamProxyFrame(event.frame);
          if (!parsed.ok) {
            onReject(`stream/send rejected: ${parsed.reason}`);
            return;
          }
          const session = sessions.get(parsed.frame.streamId);
          if (session === undefined) return;
          session.sendClientFrame(
            parsed.frame.envelope,
            parsed.frame.binaryPayload,
          );
          return;
        }
        case "stream/reconnect": {
          const session = sessions.get(event.stream.streamId);
          if (session === undefined) return;
          session.requestReconnect();
          return;
        }
        case "stream/close": {
          const session = sessions.get(event.stream.streamId);
          if (session === undefined) return;
          sessions.delete(event.stream.streamId);
          heldParams.delete(event.stream.streamId);
          session.close();
          return;
        }
        default:
          assertNever(event);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const open = [...sessions.entries()];
      sessions.clear();
      heldParams.clear();
      for (const [streamId, session] of open) {
        // Tell the worker before closing, even though the common case is a worker about to be terminated.
        // The uncommon case is the one that matters: `detachTransport()` ends the transport while the session keeps its replica - a retained-dirty buffer that must stop dialling a host this window has left.
        push(
          {
            kind: "stream/status",
            status: { streamId, status: "closed", reason: { kind: "caller" } },
          },
          NO_TRANSFER,
        );
        // Every one, not just the ones the worker asked about.
        // A worker that was terminated mid-life never sends its closes, and a real session left subscribed is a socket carrying frames nothing reads.
        session.close();
      }
    },
    openCount: () => sessions.size,
  };
}

/**
 * The unhandled-member throw behind the switch's `default`.
 * Unreachable in production rather than merely unlikely: both ends of this bridge ship in one module graph, so a peer cannot construct a `stream/*` kind this build does not know.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled stream proxy event ${JSON.stringify(value)}`);
}
