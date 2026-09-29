import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  RemoteSession as ProtocolRemoteSession,
  type IRemoteSession,
  type RemoteSessionOptions as ProtocolRemoteSessionOptions,
  type SessionLivenessProbe,
} from "@traycer/protocol/host-transport/remote/session";
import type { RemoteSessionAuth } from "@traycer/protocol/host-transport/remote/auth";
import type { RemoteTrafficSnapshot } from "@traycer/protocol/host-transport/remote/traffic-accounting";
import { extractBearerForOpenFrame } from "../ws-rpc-client";
import { recordNegotiatedHostManifest } from "../negotiated-manifest-registry";
import { recordNegotiatedStreamMethodVersions } from "../negotiated-stream-version-registry";
import { CLIENT_SERVED_STREAM_MAJORS } from "../served-stream-majors";
import { UNARY_RESPONSE_TIMEOUT_MS } from "./config";

export type { IRemoteSession, SessionLivenessProbe };
export { PLAN_RESTRICTED_FATAL_CODE } from "@traycer/protocol/host-transport/remote/session";

/**
 * The desktop client's liveness probe: the method a silence candidate sends to
 * find out whether the host is still answering anything at all.
 *
 * `host.status` because it is (a) a RELEASED FLOOR method, so every host
 * negotiates it and the probe can never be refused pre-send in the field, and
 * (b) an ordinary domain resolver on the host's own event loop rather than a
 * transport-layer echo - so an answer proves the host is running, not merely
 * that its socket layer is. Its v1.0 request is `{}`.
 *
 * Lives here, in the client adapter, rather than in the protocol session: the
 * session is generic over an RPC registry it must not name, and every
 * composition root above this adapter is generic too.
 */
export const HOST_STATUS_LIVENESS_PROBE: SessionLivenessProbe = {
  method: "host.status",
  params: {},
};

/** Set to `1` in sessionStorage for reloads or localStorage for app relaunches. */
export const REMOTE_TRAFFIC_DEBUG_STORAGE_KEY = "traycer:remote-traffic-debug";

/** Backstop for live sessions; a closed session leaves on its own. */
const MAX_DEBUG_READERS = 32;

/**
 * Live sessions' readers by capture id, oldest first. An id is never reused,
 * so two samples of one capture line up even after an earlier session leaves.
 */
const debugReaders = new Map<number, () => RemoteTrafficSnapshot>();
let nextDebugCaptureSession = 0;
let droppedDebugSessions = 0;

export function readRemoteTrafficDebugSnapshots(): ReadonlyArray<
  RemoteTrafficSnapshot & { readonly captureSession: number }
> {
  return Array.from(debugReaders, ([captureSession, read]) => ({
    ...read(),
    captureSession,
  }));
}

function registerRemoteTrafficDebugReader(
  read: () => RemoteTrafficSnapshot,
): number {
  const captureSession = nextDebugCaptureSession;
  nextDebugCaptureSession += 1;
  debugReaders.set(captureSession, read);
  if (debugReaders.size > MAX_DEBUG_READERS) {
    const oldest = debugReaders.keys().next();
    if (!oldest.done) debugReaders.delete(oldest.value);
    droppedDebugSessions += 1;
  }
  return captureSession;
}

function remoteTrafficDebugEnabled(): boolean {
  try {
    if (sessionStorage.getItem(REMOTE_TRAFFIC_DEBUG_STORAGE_KEY) === "1") {
      return true;
    }
  } catch {
    // A denied session store must not hide a persistent diagnostic opt-in.
  }
  try {
    return localStorage.getItem(REMOTE_TRAFFIC_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function installRemoteTrafficDebugSurface(): void {
  try {
    Object.defineProperty(globalThis, "__traycerRemoteTraffic", {
      configurable: true,
      value: Object.freeze({
        snapshot: readRemoteTrafficDebugSnapshots,
        droppedSessions: () => droppedDebugSessions,
      }),
    });
  } catch {
    // A hardened embed may refuse globals. Keep the transport usable; the
    // exported reader remains available to a local diagnostic harness.
  }
}

export interface RemoteSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends Omit<
  ProtocolRemoteSessionOptions<RpcRegistry, StreamRegistry>,
  | "auth"
  | "onNegotiatedMethods"
  | "onNegotiatedStreamMethodVersions"
  | "evidence"
  | "servedStreamMajors"
  | "unaryResponseMs"
> {
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
  readonly evidence: TransportEvidenceReporter;
}

/**
 * Client compatibility adapter over the runtime-neutral protocol session.
 * It preserves the original constructor while keeping bearer/auth-service
 * coupling on the client side of the package boundary.
 */
export class RemoteSession<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends ProtocolRemoteSession<RpcRegistry, StreamRegistry> {
  constructor(options: RemoteSessionOptions<RpcRegistry, StreamRegistry>) {
    const { bearer, auth, ...coreOptions } = options;
    super({
      ...coreOptions,
      auth: createClientRemoteSessionAuth(bearer, auth),
      onNegotiatedMethods: recordNegotiatedHostManifest,
      // The stream sibling of the line above, and installed here for the same
      // reason: BOTH transports must publish, or every per-host gate built on
      // the registry fails closed forever for the hosts one of them serves -
      // which for a stream-version gate means every remote host, i.e. the ones
      // the gate exists for.
      onNegotiatedStreamMethodVersions: recordNegotiatedStreamMethodVersions,
      servedStreamMajors: CLIENT_SERVED_STREAM_MAJORS,
      unaryResponseMs: UNARY_RESPONSE_TIMEOUT_MS,
    });
    if (remoteTrafficDebugEnabled() && this.enableTrafficAccounting()) {
      const reader = this.trafficSnapshotReader();
      if (reader !== null) {
        const captureSession = registerRemoteTrafficDebugReader(reader);
        // Caller close and terminal fatal both end here. A closed session's
        // accounting is final, so keeping its reader would only pin its rows
        // and crowd live sessions out of the cap.
        this.onClosed(() => {
          debugReaders.delete(captureSession);
        });
        installRemoteTrafficDebugSurface();
      }
    }
  }
}

function createClientRemoteSessionAuth(
  bearer: BearerSourceProvider,
  auth: StreamAuthRevalidator | null | undefined,
): RemoteSessionAuth {
  const readBearer = (): string | null => {
    try {
      return extractBearerForOpenFrame(bearer());
    } catch {
      return null;
    }
  };
  return {
    missingOpenAuthCause: "missing-bearer",
    readOpenAuth: () => {
      const token = readBearer();
      if (token === null) {
        return null;
      }
      return { bearer: token, authz: null, fingerprint: token };
    },
    readCredentialUpdateBearer: readBearer,
    currentFingerprint: readBearer,
    revalidateForReconnect:
      auth === null || auth === undefined
        ? null
        : () => auth.revalidateForReconnect(),
  };
}
