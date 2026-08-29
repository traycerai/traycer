/**
 * The worker's `IStreamClient`: a real implementation whose frames cross the
 * bridge instead of a socket.
 *
 * Everything the interface promises SYNCHRONOUSLY is answered from worker-side
 * state, which is what makes the proxy possible at all: `subscribe` returns a
 * session object built here and now (the `streamId` is ours, so nothing has to
 * be awaited), and both schema-version reads answer from replicas the main
 * thread pushes.
 *
 * Frames and statuses for a `streamId` this client no longer holds are DROPPED
 * silently. That is not laziness - it is the only safe answer. A frame can be
 * in flight when a session closes, and a worker that was replaced leaves its
 * predecessor's frames arriving at a live successor; a throw here would be an
 * unhandled error inside a `message` listener with no route back to anyone.
 */
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IStreamClient } from "@traycer-clients/shared/host-transport/i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ParamsOf } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { WorkerToMainEvent } from "./bridge-protocol";
import {
  parseStreamProxyFrame,
  type StreamProxyFrame,
  type StreamProxyManifest,
} from "./stream-proxy-protocol";
import { takeBytesForTransfer, NO_TRANSFER } from "./transferable-bytes";

/** What the client needs from its owner to put an event on the wire. */
export type StreamProxyEmit = (
  event: WorkerToMainEvent,
  transfer: readonly ArrayBuffer[],
) => void;

export interface WorkerStreamClientHandle {
  readonly client: IStreamClient<HostStreamRpcRegistry>;
  /**
   * A frame from main, for one session. Validated before delivery and dropped
   * (with its reason) if the payload is not bytes or the session is gone.
   */
  deliverFrame(frame: StreamProxyFrame): void;
  /** A status transition from main. Dropped if that session is gone. */
  deliverStatus(
    streamId: number,
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void;
  /** The per-session negotiated version, pushed before its status. */
  deliverSessionVersion(streamId: number, version: SchemaVersion | null): void;
  /** Client-wide versions, support and the doc arm. */
  deliverManifest(manifest: StreamProxyManifest): void;
  /** The last manifest main pushed, or `null` before the first. */
  manifest(): StreamProxyManifest | null;
  /** Fires whenever a manifest lands - the worker's `subscribeSupport`. */
  subscribeManifest(listener: () => void): () => void;
  /**
   * Closes every session this client opened, and tells main to close the real
   * ones. Called on worker teardown: a session left open on main is a socket
   * subscription with nothing behind it.
   */
  disposeAll(): void;
}

interface ProxiedSession {
  readonly session: IStreamSession;
  readonly deliverFrame: ServerFrameHandler;
  readonly deliverStatus: StatusChangeHandler;
  setVersion(version: SchemaVersion | null): void;
  /** Re-reads a params provider, if this session has one, and returns it. */
  readParams(): { readonly has: boolean; readonly params: unknown };
  markClosed(): void;
  isClosed(): boolean;
}

export function createWorkerStreamClient(
  emit: StreamProxyEmit,
  /** Where a rejected frame's reason goes. Required, for the same reason. */
  onReject: (reason: string) => void,
): WorkerStreamClientHandle {
  const sessions = new Map<number, ProxiedSession>();
  const manifestListeners = new Set<() => void>();
  let lastManifest: StreamProxyManifest | null = null;
  let nextStreamId = 1;

  function open<Method extends keyof HostStreamRpcRegistry & string>(
    method: Method,
    readParams: () => unknown,
    withParamsProvider: boolean,
  ): IStreamSession {
    const streamId = nextStreamId;
    nextStreamId += 1;

    let frameHandler: ServerFrameHandler | null = null;
    let statusHandler: StatusChangeHandler | null = null;
    let negotiated: SchemaVersion | null = null;
    let closed = false;

    const session: IStreamSession = {
      sendClientFrame(envelope, binaryPayload): void {
        if (closed) return;
        const prepared =
          binaryPayload === null ? null : takeBytesForTransfer(binaryPayload);
        emit(
          {
            kind: "stream/send",
            frame: {
              streamId,
              envelope,
              binaryPayload: prepared === null ? null : prepared.bytes,
            },
          },
          prepared === null ? NO_TRANSFER : prepared.transfer,
        );
      },
      onServerFrame(handler): void {
        // Replaces, matching the native `onmessage` contract the interface
        // documents - not an additive subscription.
        frameHandler = handler;
      },
      onStatusChange(handler): void {
        statusHandler = handler;
      },
      requestReconnect(): void {
        if (closed) return;
        emit({ kind: "stream/reconnect", stream: { streamId } }, NO_TRANSFER);
      },
      getNegotiatedSchemaVersion(): SchemaVersion | null {
        return negotiated;
      },
      close(): void {
        if (closed) return;
        closed = true;
        sessions.delete(streamId);
        emit({ kind: "stream/close", stream: { streamId } }, NO_TRANSFER);
      },
    };

    sessions.set(streamId, {
      session,
      deliverFrame: (envelope, binaryPayload) => {
        frameHandler?.(envelope, binaryPayload);
      },
      deliverStatus: (status, reason) => {
        statusHandler?.(status, reason);
      },
      setVersion: (version) => {
        negotiated = version;
      },
      readParams: () =>
        withParamsProvider
          ? { has: true, params: readParams() }
          : { has: false, params: null },
      markClosed: () => {
        closed = true;
      },
      isClosed: () => closed,
    });

    emit(
      {
        kind: "stream/open",
        open: { streamId, method, params: readParams(), withParamsProvider },
      },
      NO_TRANSFER,
    );
    return session;
  }

  const client: IStreamClient<HostStreamRpcRegistry> = {
    subscribe<Method extends keyof HostStreamRpcRegistry & string>(
      method: Method,
      params: ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession {
      return open(method, () => params, false);
    },
    subscribeWithParamsProvider<
      Method extends keyof HostStreamRpcRegistry & string,
    >(
      method: Method,
      paramsProvider: () => ParamsOf<HostStreamRpcRegistry, Method>,
    ): IStreamSession {
      return open(method, paramsProvider, true);
    },
    getMethodSchemaVersion<Method extends keyof HostStreamRpcRegistry & string>(
      method: Method,
    ): SchemaVersion | null {
      const entry = lastManifest?.methodVersions.find(
        (candidate) => candidate.method === method,
      );
      return entry === undefined ? null : entry.version;
    },
  };

  return {
    client,
    deliverFrame(frame): void {
      const parsed = parseStreamProxyFrame(frame);
      if (!parsed.ok) {
        onReject(`stream/frame rejected: ${parsed.reason}`);
        return;
      }
      sessions
        .get(parsed.frame.streamId)
        ?.deliverFrame(parsed.frame.envelope, parsed.frame.binaryPayload);
    },
    deliverStatus(streamId, status, reason): void {
      const entry = sessions.get(streamId);
      if (entry === undefined) return;
      entry.deliverStatus(status, reason);
      // A status transition is when a re-declare becomes imminent, so it is
      // where a params provider is re-read. Pushed AFTER the handler runs: the
      // handler is what applies the state the provider reads, so reading first
      // would report the value the reconnect was already going to use.
      const params = entry.readParams();
      if (!params.has || entry.isClosed()) return;
      emit(
        { kind: "stream/params", params: { streamId, params: params.params } },
        NO_TRANSFER,
      );
    },
    deliverSessionVersion(streamId, version): void {
      sessions.get(streamId)?.setVersion(version);
    },
    deliverManifest(manifest): void {
      lastManifest = manifest;
      for (const listener of [...manifestListeners]) listener();
    },
    manifest: () => lastManifest,
    subscribeManifest(listener): () => void {
      manifestListeners.add(listener);
      return () => {
        manifestListeners.delete(listener);
      };
    },
    disposeAll(): void {
      const outstanding = [...sessions.entries()];
      sessions.clear();
      for (const [streamId, entry] of outstanding) {
        entry.markClosed();
        emit({ kind: "stream/close", stream: { streamId } }, NO_TRANSFER);
      }
      manifestListeners.clear();
    },
  };
}
