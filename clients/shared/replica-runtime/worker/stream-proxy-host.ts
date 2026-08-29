/**
 * The main-thread half of the stream proxy.
 *
 * Owns the REAL `IStreamSession`s, one per `streamId` the worker opened, and
 * relays each one's frames and status back. It is deliberately the only object
 * on this side that knows a worker exists: the durable transport it is built
 * over is untouched, and `detachTransport()` acts on THIS, not on the socket.
 *
 * Three rules that are all about the same hazard - a message arriving for
 * something that is gone:
 *
 *   1. an open for a method outside the closed union is answered with a
 *      synthetic `closed` + `fatalError`, never a throw and never
 *      `INCOMPATIBLE`;
 *   2. a `send` / `reconnect` / `close` for a `streamId` this host no longer
 *      holds is DROPPED - the worker closed it, or an older worker generation
 *      is still draining;
 *   3. `dispose()` closes every real session it opened, so a worker that goes
 *      away cannot leave a live subscription behind it.
 */
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { MainToWorkerEvent, WorkerToMainEvent } from "./bridge-protocol";
import {
  EPIC_WORKER_STREAM_METHODS,
  OPEN_PARAMS_PARSERS,
  STREAM_PROXY_UNKNOWN_METHOD_CODE,
  type EpicWorkerStreamMethod,
} from "./stream-proxy-protocol";
import { takeBytesForTransfer, NO_TRANSFER } from "./transferable-bytes";

export type StreamProxyPush = (
  event: MainToWorkerEvent,
  transfer: readonly ArrayBuffer[],
) => void;

export interface StreamProxyHost {
  /** Applies one worker->main stream event. Unknown ids are dropped. */
  handle(event: WorkerToMainEvent): boolean;
  /** Closes every real session this host opened. Idempotent. */
  dispose(): void;
  /** How many real sessions are open. For the leak pin. */
  openCount(): number;
}

/**
 * Narrows a wire method to the closed union WITHOUT asserting.
 *
 * `Object.hasOwn` against the record is the check; the record's type is a
 * mapped literal over the union, so a key it owns IS a member. This is why the proxy needs no
 * cast anywhere: everything downstream of this guard is typed.
 */
function isCarriedMethod(method: string): method is EpicWorkerStreamMethod {
  return Object.hasOwn(EPIC_WORKER_STREAM_METHODS, method);
}

export function createStreamProxyHost(
  streams: IStreamClient<HostStreamRpcRegistry>,
  push: StreamProxyPush,
): StreamProxyHost {
  const sessions = new Map<number, IStreamSession>();
  /** Last params the worker pushed, per stream, for the provider form. */
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
      // Version BEFORE status, so a worker reacting to `open` already reads the
      // version negotiated for it. Achievable because the real session sets its
      // version before transitioning and clears it on the first line of
      // `resetForReconnect` - both checked at source.
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
    // Synthetic, because there is no real session to transition. Its own code:
    // `INCOMPATIBLE` is read by `isMethodIncompatibleClose` as a verdict about
    // the HOST's capability, and would pin a permanent "too old" on a host that
    // is perfectly able to serve a method this proxy simply does not carry.
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
    handle(event): boolean {
      if (disposed) return false;
      switch (event.kind) {
        case "stream/open": {
          const { streamId, method, params, withParamsProvider } = event.open;
          if (!isCarriedMethod(method)) {
            refuseUnknownMethod(streamId, method);
            return true;
          }
          // Raw is held, parsed is handed over: the provider re-parses each
          // time, so a pushed params value is validated on the same path as the
          // opening one rather than trusted because it arrived later.
          heldParams.set(streamId, params);
          const session = withParamsProvider
            ? streams.subscribeWithParamsProvider(method, () =>
                // Re-read on every wire subscribe, including a reconnect
                // re-declare. Answers from the last value the worker pushed:
                // the provider itself cannot cross, because `WsStreamClient`
                // invokes it synchronously and a bridge round trip is not.
                OPEN_PARAMS_PARSERS[method](heldParams.get(streamId) ?? params),
              )
            : streams.subscribe(method, OPEN_PARAMS_PARSERS[method](params));
          sessions.set(streamId, session);
          wire(streamId, session);
          return true;
        }
        case "stream/params": {
          // A params push for a stream this host no longer holds is dropped -
          // the worker closed it, or an older generation is still draining.
          if (!sessions.has(event.params.streamId)) return false;
          heldParams.set(event.params.streamId, event.params.params);
          return true;
        }
        case "stream/send": {
          const session = sessions.get(event.frame.streamId);
          if (session === undefined) return false;
          session.sendClientFrame(
            event.frame.envelope,
            event.frame.binaryPayload,
          );
          return true;
        }
        case "stream/reconnect": {
          const session = sessions.get(event.stream.streamId);
          if (session === undefined) return false;
          session.requestReconnect();
          return true;
        }
        case "stream/close": {
          const session = sessions.get(event.stream.streamId);
          if (session === undefined) return false;
          sessions.delete(event.stream.streamId);
          heldParams.delete(event.stream.streamId);
          session.close();
          return true;
        }
        default:
          return false;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const open = [...sessions.entries()];
      sessions.clear();
      heldParams.clear();
      for (const [streamId, session] of open) {
        // Tell the worker BEFORE closing, even though the common case is a
        // worker about to be terminated. The uncommon case is the one that
        // matters: `detachTransport()` ends the transport while the session
        // KEEPS its replica - a retained-dirty buffer that must stop dialling a
        // host this window has left. There the worker SURVIVES, and without
        // this its streams would simply go quiet, which is indistinguishable
        // from a slow host and runs none of the adapters' close handling.
        push(
          {
            kind: "stream/status",
            status: { streamId, status: "closed", reason: { kind: "caller" } },
          },
          NO_TRANSFER,
        );
        // Every one, not just the ones the worker asked about. A worker that was
        // terminated mid-life never sends its closes, and a real session left
        // subscribed is a socket carrying frames nothing reads.
        session.close();
      }
    },
    openCount: () => sessions.size,
  };
}
