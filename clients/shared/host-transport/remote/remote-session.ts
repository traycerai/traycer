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
import { extractBearerForOpenFrame } from "../ws-rpc-client";
import { recordNegotiatedHostManifest } from "../negotiated-manifest-registry";
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

export interface RemoteSessionOptions<
  RpcRegistry extends
    import("@traycer/protocol/framework/index").VersionedRpcRegistry,
  StreamRegistry extends
    import("@traycer/protocol/framework/versioned-stream-rpc").VersionedStreamRpcRegistry,
> extends Omit<
  ProtocolRemoteSessionOptions<RpcRegistry, StreamRegistry>,
  | "auth"
  | "onNegotiatedMethods"
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
      servedStreamMajors: CLIENT_SERVED_STREAM_MAJORS,
      unaryResponseMs: UNARY_RESPONSE_TIMEOUT_MS,
    });
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
