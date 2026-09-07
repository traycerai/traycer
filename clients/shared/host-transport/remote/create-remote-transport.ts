import type {
  FirstPartyClientIdentity,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { ServerClockSkewSignal } from "@traycer-clients/shared/clock/server-time-offset-tracker";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import { RemoteSession, type IRemoteSession } from "./remote-session";
import { RemoteHostMessenger } from "./remote-host-messenger";
import { RemoteStreamClient } from "./remote-stream-client";
import { createAttachGrantProvider } from "./grant-client";
import { decodeHostPublicKey } from "./noise-channel";
import {
  acquireRemoteSession,
  planRestrictedReprobeAt,
  type RemoteSessionIdentity,
} from "./active-remote-sessions";

/**
 * Returns `null` when the host's published public key is not a valid X25519 key, so a malformed registry row degrades to "unconnectable" rather than crashing the caller.
 */
export interface CreateRemoteTransportOptions<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  readonly hostId: string;
  /** The signed-in user this session is minted for; part of the cache key. */
  readonly userId: string;
  /** Relay attach endpoint, e.g. `wss://relay.example/attach`. */
  readonly relayAttachUrl: string;
  /** authn-v3 base URL used to mint `role:"client"` attach grants. */
  readonly authnBaseUrl: string;
  /** The host's registry-published static public key (DTO string form). */
  readonly hostPublicKey: string;
  /** Serves the in-channel bearer AND (derived) the grant-mint user bearer. */
  readonly bearer: BearerSourceProvider;
  /**
   * Auth recovery for an `unauthorized` session fatal (an expired bearer at a wake-time re-attach; see `RemoteSessionOptions.auth`).
   * Only the first acquirer for a `(hostId, userId)` cache key constructs the shared session, so production callers should all pass the app revalidator - a cache hit reuses whatever the creator wired.
   */
  readonly auth: StreamAuthRevalidator | null;
  /**
   * Clock-skew verdict for the session's `unauthorized` park (see `RemoteSessionOptions.clock`).
   * Deliberately not part of the cache identity above, for the same reason `clientIdentity` is not: unlike `auth`, this cannot vary between consumers.
   */
  readonly clock: ServerClockSkewSignal | null;
  readonly rpcRegistry: RpcRegistry;
  readonly streamRegistry: StreamRegistry;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly requestId: () => string;
  /**
   * Part of the consumer wiring, not of the cache identity: on a cache hit the factory below never runs, so a session keeps whatever reporter its first acquirer passed.
   * That is safe only because production passes a relay whose scope matches the pool's - see `TransportEvidenceRelay`.
   */
  readonly evidence: TransportEvidenceReporter;
  /** Who this client IS - see `RemoteSessionOptions.clientIdentity`. */
  readonly clientIdentity: FirstPartyClientIdentity;
  /**
   * Whether the process-wide wake sweep may proactively poke or force-drop the session this consumer acquires - the consumer's statement that a reconnect's subscribe replay is safe for the streams it will carry.
   * A one-shot side-effecting transport passes `false`; see `RemoteSessionAcquirePolicy.proactiveWakeEligible` for why this is not inferred from `auth`.
   */
  readonly proactiveWakeEligible: boolean;
}

export interface RemoteHostTransport<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  /** A per-caller view onto the shared `(hostId, userId)` session. */
  readonly session: IRemoteSession<RpcRegistry, StreamRegistry>;
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

  const bearerSource = options.bearer();
  if (bearerSource === null || !canProvideBearer(bearerSource)) {
    // No usable auth context at build time - the same "unconnectable" degradation as a malformed public key, not a cacheable state.
    // - a released source (non-null, but its lease has been retired, so `getBearerToken()` throws): a stale factory invocation running after its context was aborted.
    return null;
  }

  const identity: RemoteSessionIdentity = {
    hostId: options.hostId,
    userId: options.userId,
    hostPublicKey: options.hostPublicKey,
    relayAttachUrl: options.relayAttachUrl,
    // Part of the identity, not a per-consumer option: on a cache hit the factory below never runs, so `auth` would otherwise be silently inherited from whichever consumer happened to build the session first.
    authRecovery: options.auth === null ? "terminal" : "revalidate",
    // Same reasoning applied to which auth context wired those closures, not
    // just which policy they implement. See `RemoteSessionIdentity.authEpoch`.
    authEpoch: authEpochFor(bearerSource),
  };
  const session = acquireRemoteSession(
    identity,
    { proactiveWakeEligible: options.proactiveWakeEligible },
    () => {
      const grantProvider = createAttachGrantProvider({
        authnBaseUrl: options.authnBaseUrl,
        hostId: options.hostId,
        getBearerToken: () => deriveBearerToken(options.bearer),
      });
      return new RemoteSession<RpcRegistry, StreamRegistry>({
        hostId: options.hostId,
        attachBaseUrl: options.relayAttachUrl,
        hostStaticPublicKey,
        grantProvider,
        bearer: options.bearer,
        auth: options.auth,
        clock: options.clock,
        rpcRegistry: options.rpcRegistry,
        streamRegistry: options.streamRegistry,
        webSocketFactory: options.webSocketFactory,
        requestId: options.requestId,
        evidence: options.evidence,
        clientIdentity: options.clientIdentity,
      });
    },
  );

  return {
    session,
    messenger: new RemoteHostMessenger(session),
    streamClient: new RemoteStreamClient(session, () =>
      planRestrictedReprobeAt(identity),
    ),
  };
}

/** Reads the current user bearer string from the shared bearer source. */
/**
 * Stable per-auth-context label for the session cache key.
 * A `WeakMap` both keeps the label stable for repeat acquires by the same context and lets a retired lease be collected; the counter only ever needs to be distinct, never meaningful.
 */
const authEpochLabels = new WeakMap<OpenFrameBearerSource, string>();
let nextAuthEpoch = 0;

function authEpochFor(source: OpenFrameBearerSource): string {
  const existing = authEpochLabels.get(source);
  if (existing !== undefined) {
    return existing;
  }
  nextAuthEpoch += 1;
  const label = `lease-${nextAuthEpoch}`;
  authEpochLabels.set(source, label);
  return label;
}

/**
 * Whether the source can provide a bearer right now - the same read the mint path performs per attach (`deriveBearerToken`), probed once at build time.
 * A released credential lease keeps its object identity (and so its epoch label) but throws on read; an empty token cannot authorize a mint either.
 */
function canProvideBearer(source: OpenFrameBearerSource): boolean {
  try {
    return source.getBearerToken().length > 0;
  } catch {
    return false;
  }
}

function deriveBearerToken(bearer: BearerSourceProvider): string | null {
  const source = bearer();
  if (source === null) {
    return null;
  }
  try {
    const token = source.getBearerToken();
    return token.length === 0 ? null : token;
  } catch (error) {
    console.error("createRemoteHostTransport: bearer read failed", error);
    return null;
  }
}
