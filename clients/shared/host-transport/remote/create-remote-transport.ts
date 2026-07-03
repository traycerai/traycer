import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import { RemoteSession } from "./remote-session";
import { RemoteHostMessenger } from "./remote-host-messenger";
import { RemoteStreamClient } from "./remote-stream-client";
import { createAttachGrantProvider } from "./grant-client";
import { decodeHostPublicKey } from "./noise-channel";
import { registerActiveRemoteSession } from "./active-remote-sessions";

/**
 * Assembles the client remote transport for one host: one shared
 * `RemoteSession` behind both a `RemoteHostMessenger` (unary) and a
 * `RemoteStreamClient` (streams), exactly as the transport-seam spike proved —
 * one connection carrying unary + N streams.
 *
 * The caller supplies the base URLs (relay + authn) and one `BearerSourceProvider`
 * that serves BOTH the in-channel `open{bearer}` identity (A2) and the user
 * bearer used to mint attach grants at CS (the grant HTTP derives its token from
 * the same source). Returns `null` when the host's published public key is not a
 * valid X25519 key, so a malformed registry row degrades to "unconnectable"
 * rather than crashing the caller.
 */
export interface CreateRemoteTransportOptions<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  readonly hostId: string;
  /** Relay attach endpoint, e.g. `wss://relay.example/attach`. */
  readonly relayAttachUrl: string;
  /** authn-v3 base URL used to mint `role:"client"` attach grants. */
  readonly authnBaseUrl: string;
  /** The host's registry-published static public key (DTO string form). */
  readonly hostPublicKey: string;
  /** Serves the in-channel bearer AND (derived) the grant-mint user bearer. */
  readonly bearer: BearerSourceProvider;
  readonly rpcRegistry: RpcRegistry;
  readonly streamRegistry: StreamRegistry;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly requestId: () => string;
}

export interface RemoteHostTransport<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  readonly session: RemoteSession<RpcRegistry, StreamRegistry>;
  readonly messenger: RemoteHostMessenger<RpcRegistry, StreamRegistry>;
  readonly streamClient: RemoteStreamClient<RpcRegistry, StreamRegistry>;
}

export function createRemoteHostTransport<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
>(
  options: CreateRemoteTransportOptions<RpcRegistry, StreamRegistry>,
): RemoteHostTransport<RpcRegistry, StreamRegistry> | null {
  let hostStaticPublicKey: Uint8Array;
  try {
    hostStaticPublicKey = decodeHostPublicKey(options.hostPublicKey);
  } catch {
    return null;
  }

  const grantProvider = createAttachGrantProvider({
    authnBaseUrl: options.authnBaseUrl,
    hostId: options.hostId,
    getBearerToken: () => deriveBearerToken(options.bearer),
  });

  const session = new RemoteSession<RpcRegistry, StreamRegistry>({
    hostId: options.hostId,
    attachBaseUrl: options.relayAttachUrl,
    hostStaticPublicKey,
    grantProvider,
    bearer: options.bearer,
    rpcRegistry: options.rpcRegistry,
    streamRegistry: options.streamRegistry,
    webSocketFactory: options.webSocketFactory,
    requestId: options.requestId,
  });

  // Live-session-evidence registration (Architecture §7, R4-B5): every
  // independently-constructed session for this host participates in the
  // "does ANY client hold an open E2E session to this host" signal
  // `my-hosts-model.ts` reads, regardless of which consumer (RPC messenger,
  // durable stream, app-wide client) owns it. Unregistered exactly once, on
  // `session.close()` - the single teardown path every consumer already calls.
  const unregister = registerActiveRemoteSession(options.hostId, session);
  const originalClose = session.close.bind(session);
  session.close = () => {
    unregister();
    originalClose();
  };

  return {
    session,
    messenger: new RemoteHostMessenger(session),
    streamClient: new RemoteStreamClient(session),
  };
}

/** Reads the current user bearer string from the shared bearer source. */
function deriveBearerToken(bearer: BearerSourceProvider): string | null {
  const source = bearer();
  if (source === null) {
    return null;
  }
  try {
    const token = source.getBearerToken();
    return token.length === 0 ? null : token;
  } catch {
    return null;
  }
}
