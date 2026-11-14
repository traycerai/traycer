import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  revalidateStream,
  type StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  RemoteSession as ProtocolRemoteSession,
  type IRemoteSession,
  type PoolSessionOptions as ProtocolPoolSessionOptions,
  type RemoteSessionEvidence,
  type RemoteSessionOptions as ProtocolRemoteSessionOptions,
  type SessionLivenessProbe,
} from "@traycer/protocol/host-transport/remote/session";
import type {
  PoolSessionAuth,
  RemoteSessionAuth,
} from "@traycer/protocol/host-transport/remote/auth";
import { OPEN_AUTHZ_SESSION_GRANT_VERSION } from "@traycer/protocol/host-transport/mux";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import type { RemoteTrafficSnapshot } from "@traycer/protocol/host-transport/remote/traffic-accounting";
import { extractBearerForOpenFrame } from "../ws-rpc-client";
import { recordNegotiatedHostManifest } from "../negotiated-manifest-registry";
import { recordNegotiatedStreamMethodVersions } from "../negotiated-stream-version-registry";
import { CLIENT_SERVED_STREAM_MAJORS } from "../served-stream-majors";
import { UNARY_RESPONSE_TIMEOUT_MS } from "./config";

export type { IRemoteSession, SessionLivenessProbe };

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

/** Sessions that closed while registered, and what their rows had received. */
export interface RemoteTrafficDebugClosedSessions {
  readonly sessions: number;
  readonly receivedBytes: number;
  readonly receivedFrames: number;
}

/**
 * A closed session's reader leaves with it, so a session opened and closed
 * between two samples would otherwise leave no trace in either: no row, no
 * ID gap, no drop. These totals are what a capture checks for that loss.
 */
let closedDebugSessions: RemoteTrafficDebugClosedSessions = {
  sessions: 0,
  receivedBytes: 0,
  receivedFrames: 0,
};

export function readRemoteTrafficDebugClosedSessions(): RemoteTrafficDebugClosedSessions {
  return closedDebugSessions;
}

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

function releaseRemoteTrafficDebugReader(captureSession: number): void {
  const read = debugReaders.get(captureSession);
  // Already evicted by the cap, and counted there.
  if (read === undefined) return;
  debugReaders.delete(captureSession);
  const final = read();
  closedDebugSessions = {
    sessions: closedDebugSessions.sessions + 1,
    receivedBytes: closedDebugSessions.receivedBytes + final.receivedBytes,
    receivedFrames: closedDebugSessions.receivedFrames + final.receivedFrames,
  };
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
        closedSessions: readRemoteTrafficDebugClosedSessions,
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
  /**
   * The host-only token, for every host kind: `OPEN` presents it in `authz`
   * v2 with an EMPTY bearer, and a `CREDENTIAL_UPDATE` carries a renewed one
   * in `bearer`. The sign-in token never reaches a host.
   */
  readonly hostToken: () => string | null;
  readonly auth: StreamAuthRevalidator | null;
  readonly door: SessionDoorObserver | null;
  readonly evidence: TransportEvidenceReporter;
}

/**
 * The client's options for a session to the server pool. The bearer source
 * serves `open` directly: there is no grant to mint, no session grant and no
 * member credential, so a pool session carries the user bearer and nothing
 * else.
 */
export interface PoolSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends Omit<
  ProtocolPoolSessionOptions<RpcRegistry, StreamRegistry>,
  | "auth"
  | "onNegotiatedMethods"
  | "onNegotiatedStreamMethodVersions"
  | "servedStreamMajors"
  | "unaryResponseMs"
> {
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
  readonly evidence: RemoteSessionEvidence<"pool-direct">;
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
  constructor(
    options:
      | RemoteSessionOptions<RpcRegistry, StreamRegistry>
      | PoolSessionOptions<RpcRegistry, StreamRegistry>,
  ) {
    super(toProtocolSessionOptions(options));
    if (remoteTrafficDebugEnabled() && this.enableTrafficAccounting()) {
      const reader = this.trafficSnapshotReader();
      if (reader !== null) {
        const captureSession = registerRemoteTrafficDebugReader(reader);
        // Caller close and terminal fatal both end here. A closed session's
        // accounting is final, so keeping its reader would only pin its rows
        // and crowd live sessions out of the cap; its totals stay counted.
        this.onClosed(() => {
          releaseRemoteTrafficDebugReader(captureSession);
        });
        installRemoteTrafficDebugSurface();
      }
    }
  }
}

function bearerReader(bearer: BearerSourceProvider): () => string | null {
  return () => {
    try {
      return extractBearerForOpenFrame(bearer());
    } catch {
      return null;
    }
  };
}

function createHostTokenRemoteSessionAuth(
  readHostToken: () => string | null,
  auth: StreamAuthRevalidator | null,
  door: SessionDoorObserver | null,
): RemoteSessionAuth {
  return {
    missingOpenAuthCause: "missing-host-token",
    readOpenAuth: () => {
      const grant = readHostToken();
      if (grant === null) {
        return null;
      }
      return {
        bearer: "",
        authz: { v: OPEN_AUTHZ_SESSION_GRANT_VERSION, grant },
        fingerprint: grant,
      };
    },
    readCredentialUpdateBearer: readHostToken,
    currentFingerprint: readHostToken,
    // `undefined` too: an untyped caller can omit the option, and a wrapper
    // over nothing would turn "no revalidator" into an endless retry.
    revalidateForReconnect:
      auth === null || auth === undefined
        ? null
        : (refusal) => revalidateStream(auth, refusal),
    ...(door === null ? {} : { door }),
  };
}

/**
 * The pool's `open` presents the user bearer, as a personal host's does, with
 * nowhere to put anything else: no `authz`, no session grant.
 */
function createClientPoolSessionAuth(
  bearer: BearerSourceProvider,
  auth: StreamAuthRevalidator | null,
): PoolSessionAuth {
  const readBearer = bearerReader(bearer);
  return {
    missingOpenAuthCause: "missing-bearer",
    readOpenAuth: () => {
      const token = readBearer();
      return token === null ? null : { bearer: token, fingerprint: token };
    },
    readCredentialUpdateBearer: readBearer,
    currentFingerprint: readBearer,
    revalidateForReconnect:
      auth === null ? null : (refusal) => revalidateStream(auth, refusal),
  };
}

/**
 * The protocol session's options for either client shape. The client-side
 * wiring is the same for both: BOTH transports must publish what they
 * negotiated, or every per-host gate built on those registries fails closed
 * forever for the hosts one of them serves - which for a stream-version gate
 * means every remote host, i.e. the ones the gate exists for.
 */
function toProtocolSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
>(
  options:
    | RemoteSessionOptions<RpcRegistry, StreamRegistry>
    | PoolSessionOptions<RpcRegistry, StreamRegistry>,
):
  | ProtocolRemoteSessionOptions<RpcRegistry, StreamRegistry>
  | ProtocolPoolSessionOptions<RpcRegistry, StreamRegistry> {
  const clientWiring = {
    onNegotiatedMethods: recordNegotiatedHostManifest,
    onNegotiatedStreamMethodVersions: recordNegotiatedStreamMethodVersions,
    servedStreamMajors: CLIENT_SERVED_STREAM_MAJORS,
    unaryResponseMs: UNARY_RESPONSE_TIMEOUT_MS,
  };
  if ("poolUrl" in options) {
    const { bearer, auth, ...coreOptions } = options;
    return {
      ...coreOptions,
      ...clientWiring,
      auth: createClientPoolSessionAuth(bearer, auth),
    };
  }
  const { hostToken, auth, door, ...coreOptions } = options;
  return {
    ...coreOptions,
    ...clientWiring,
    auth: createHostTokenRemoteSessionAuth(hostToken, auth, door),
  };
}
