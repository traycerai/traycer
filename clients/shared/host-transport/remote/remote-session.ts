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
import { OPEN_AUTHZ_SESSION_GRANT_VERSION } from "@traycer/protocol/host-transport/mux";
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
  readonly bearer: BearerSourceProvider;
  readonly auth: StreamAuthRevalidator | null;
  readonly evidence: TransportEvidenceReporter;
  /**
   * `null` for a personal host: `OPEN` presents the user bearer. For a
   * `kind: sandbox` host, the reader of the session grant minted with the
   * current attach grant: `OPEN` presents it in `authz` v2 with an EMPTY
   * bearer, and the session never sends a `CREDENTIAL_UPDATE` - no user
   * credential reaches a sandbox (seams C1 and H3).
   */
  readonly sessionGrant: (() => string | null) | null;
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
    const { bearer, auth, sessionGrant, ...coreOptions } = options;
    super({
      ...coreOptions,
      auth:
        sessionGrant === null
          ? createClientRemoteSessionAuth(bearer, auth)
          : createSessionGrantRemoteSessionAuth(sessionGrant, auth),
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
        // and crowd live sessions out of the cap; its totals stay counted.
        this.onClosed(() => {
          releaseRemoteTrafficDebugReader(captureSession);
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

function createSessionGrantRemoteSessionAuth(
  readSessionGrant: () => string | null,
  auth: StreamAuthRevalidator | null,
): RemoteSessionAuth {
  return {
    missingOpenAuthCause: "missing-session-grant",
    readOpenAuth: () => {
      const grant = readSessionGrant();
      if (grant === null) {
        return null;
      }
      return {
        bearer: "",
        authz: { v: OPEN_AUTHZ_SESSION_GRANT_VERSION, grant },
        fingerprint: grant,
      };
    },
    readCredentialUpdateBearer: () => null,
    // Unknown until the next attach mints one: the reader still holds the
    // grant that was just refused, because only the next attach replaces it.
    // A grant refusal is therefore never evidence of no progress. The loop
    // stays bounded the way a rotating bearer's is (the reconnect backoff),
    // and the `local-plane-retained` bound is untouched.
    currentFingerprint: () => null,
    // A refused session grant is recovered the way a refused bearer is: the
    // user bearer that mints the next pair is revalidated, then the session
    // redials and the provider mints a fresh attach and session grant.
    revalidateForReconnect:
      auth === null ? null : () => auth.revalidateForReconnect(),
  };
}
