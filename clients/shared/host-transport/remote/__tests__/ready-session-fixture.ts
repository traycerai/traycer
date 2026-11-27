import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  SchemaVersion,
  VersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import type { StreamMethodSupport } from "@traycer/protocol/host-transport/stream-session";
import type { IRemoteSession } from "../remote-session";
import {
  acquireRemoteSession,
  hasReadyRemoteSession,
  retireAllRemoteSessions,
  type RemoteSessionIdentity,
} from "../active-remote-sessions";

let nextReadySession = 0;

function readySession(): IRemoteSession<
  VersionedRpcRegistry,
  VersionedStreamRpcRegistry
> {
  let closed = false;
  const version: SchemaVersion = { major: 1, minor: 0 };
  return {
    start: () => undefined,
    isClosed: () => closed,
    isReady: () => !closed,
    isSilentFor: () => false,
    sendUnary: async () => {
      throw new Error("the readiness fixture does not send unary RPCs");
    },
    subscribe: () => {
      throw new Error("the readiness fixture does not open streams");
    },
    subscribeAtVersion: () => {
      throw new Error("the readiness fixture does not open streams");
    },
    subscribeWithParamsProvider: () => {
      throw new Error("the readiness fixture does not open streams");
    },
    notifyBearerRotated: () => undefined,
    notifyCloudVerdictChanged: () => undefined,
    wake: () => undefined,
    forceReconnect: () => undefined,
    onClosed: () => () => undefined,
    terminalFatal: () => null,
    subscribeAvailabilityRecovered: () => () => undefined,
    subscribeReadinessLost: () => () => undefined,
    getMethodSupport: () => "supported" satisfies StreamMethodSupport,
    getMethodSchemaVersion: () => version,
    subscribeMethodSupport: () => () => undefined,
    close: () => {
      closed = true;
    },
  };
}

/** Registers a ready session through the same cache read by hasReadyRemoteSession. */
export function mountReadyRemoteSession(hostId: string): () => void {
  nextReadySession += 1;
  const identity: RemoteSessionIdentity = {
    hostId,
    userId: `ready-session-fixture-${nextReadySession}`,
    hostPublicKey: `ready-session-key-${nextReadySession}`,
    relayAttachUrl: `wss://ready-session-${nextReadySession}.test/attach`,
    authRecovery: "revalidate",
    authEpoch: `ready-session-auth-${nextReadySession}`,
    openAuth: "pool-bearer",
  };
  const session = readySession();
  const view = acquireRemoteSession(
    identity,
    { proactiveWakeEligible: true },
    () => session,
  );
  if (!view.isReady() || !hasReadyRemoteSession(hostId)) {
    view.close();
    retireAllRemoteSessions();
    throw new Error("expected the ready session fixture to be ready");
  }

  return () => {
    view.close();
    session.close();
    retireAllRemoteSessions();
  };
}
