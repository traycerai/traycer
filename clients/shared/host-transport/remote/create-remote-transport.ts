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
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import { RemoteSession, type IRemoteSession } from "./remote-session";
import { RemoteHostMessenger } from "./remote-host-messenger";
import { RemoteStreamClient } from "./remote-stream-client";
import { createAttachGrantProvider } from "./grant-client";
import { decodeHostPublicKey } from "./noise-channel";
import { acquireRemoteSession } from "./active-remote-sessions";

/**
 * Assembles the client remote transport for one host: one `RemoteSession`,
 * shared across every consumer for the same `(hostId, userId)` via the
 * get-or-create cache (Architecture §4, fix #4 / S1), behind a caller-owned
 * `RemoteHostMessenger` (unary) and `RemoteStreamClient` (streams) - one
 * connection carrying unary + N streams for every consumer that binds to it,
 * exactly as the transport-seam spike proved.
 *
 * The caller supplies the base URLs (relay + authn) and one `BearerSourceProvider`
 * that serves BOTH the in-channel `open{bearer}` identity (A2) and the user
 * bearer used to mint attach grants at CS (the grant HTTP derives its token from
 * the same source). Those two uses are one SOURCE but not one PERMISSION - see
 * {@link CreateRemoteTransportOptions.cloudAuthorized}, which gates the mint
 * alone. Returns `null` when the host's published public key is not a valid
 * X25519 key, so a malformed registry row degrades to "unconnectable" rather
 * than crashing the caller.
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
   * Whether this client currently holds a CLOUD capability - a session the
   * account's authn has confirmed - read live, per attach.
   *
   * Gates the attach-grant mint ONLY, never the in-channel `open{bearer}`.
   * The two are the same token from the same source, and they are not the same
   * permission:
   *
   *   - Minting an attach grant asks authn to ISSUE a `role:"client"`
   *     credential against this bearer. That is a capability, and a bearer
   *     nothing has confirmed must not buy one.
   *   - The in-channel `open{bearer}` PRESENTS the token to a host that
   *     validates it and `UNAUTHORIZED`s if it is bad - which is precisely the
   *     edge {@link RemoteSessionOptions.auth} revalidation exists to catch.
   *     Refusing it here would duplicate that check while breaking the
   *     recovery it drives.
   *
   * READ PER ATTACH, INSIDE THE MINT CLOSURE, and deliberately not folded into
   * {@link canProvideBearer}: that probe runs ONCE at build time, and the
   * session cache is keyed on `authEpochFor(bearerSource)` - an identity of the
   * SOURCE OBJECT, which a verdict transition does not change. Gating at build
   * time would therefore cache a session whose mint path is permanently dead,
   * with no event that ever rebuilds it. Live inside the closure, the next
   * attach after a verdict lands mints normally.
   *
   * No invalidation is needed on the verdict transition, and that is measured
   * rather than assumed: a refused mint returns `null`, which the grant client
   * already folds into `unavailable`, whose arm calls `scheduleReconnect()` -
   * an unbounded retry ladder capped at `RECONNECT_MAX_BACKOFF_MS`, with no
   * terminal branch. (`noProgressUnauthorizedReconnects`, the one counter that
   * does go terminal, is incremented only on the UNAUTHORIZED-revalidation
   * path and never from the mint arm.) So the session self-heals within one
   * backoff rung of the verdict arriving.
   *
   * THIS GATE HAS A DEPENDENCY OUTSIDE ITSELF, and it is written here because
   * this is the line that would have to change. A refused mint reports
   * `indeterminate` to the selection authority, and
   * `selection-authority-engine.ts` returns on that outcome BEFORE the sole
   * `evidence.refusalStreak += 1`. That is what keeps a refusal from marking the
   * host confirmed-dead in the directory while the session itself is quietly
   * retrying - the UI does not disagree with the transport.
   *
   * That inertness is not incidental to us: it is a pre-existing protection
   * against one authn outage failing an entire remote fleet over to local, and
   * this gate is a NEW producer of `unavailable` riding on it. If anyone ever
   * makes `indeterminate` count toward the death streak, this gate acquires a
   * wedge it does not have today - an unverified session would drive its own
   * hosts to confirmed-dead, and the directory would stay wrong after the
   * verdict lands, because nothing here clears it. No test will produce that
   * sentence and no reviewer will re-derive it, so it lives at the gate rather
   * than in a report.
   */
  readonly cloudAuthorized: () => boolean;
  /**
   * Auth recovery for an `UNAUTHORIZED` session fatal (an expired bearer at a
   * wake-time re-attach; see `RemoteSessionOptions.auth`). `null` keeps such
   * a fatal terminal. Only the FIRST acquirer for a `(hostId, userId)` cache
   * key constructs the shared session, so production callers should all pass
   * the app revalidator - a cache hit reuses whatever the creator wired.
   */
  readonly auth: StreamAuthRevalidator | null;
  readonly rpcRegistry: RpcRegistry;
  readonly streamRegistry: StreamRegistry;
  readonly webSocketFactory: IStreamWebSocketFactory;
  readonly requestId: () => string;
  /**
   * Where the session's dial outcomes and liveness go (redesign P1.3).
   *
   * Part of the CONSUMER wiring, not of the cache identity: on a cache hit the
   * factory below never runs, so a session keeps whatever reporter its first
   * acquirer passed. That is safe only because production passes a RELAY whose
   * scope matches the pool's - see `TransportEvidenceRelay`. Passing a kernel
   * (or a per-mount reporter) here instead would pin warm sessions to a
   * reporter that outlives its consumer.
   */
  readonly evidence: TransportEvidenceReporter;
  /**
   * WHO THIS CLIENT IS - see `RemoteSessionOptions.clientIdentity`.
   *
   * Deliberately NOT part of the cache identity above, unlike `authRecovery` /
   * `authEpoch`. Those two vary per consumer, so inheriting the first
   * acquirer's value is a real hazard; this one cannot vary at all - kind,
   * epoch and build version are process constants and updating the
   * application restarts the process - so a cache hit inheriting it is
   * inheriting the only value any consumer could have passed.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
  /**
   * Whether the process-wide wake sweep may proactively poke or force-drop
   * the session this consumer acquires - the consumer's statement that a
   * reconnect's subscribe replay is safe for the streams it will carry. A
   * one-shot side-effecting transport passes `false`; see
   * `RemoteSessionAcquirePolicy.proactiveWakeEligible` for why this is not
   * inferred from `auth`.
   */
  readonly proactiveWakeEligible: boolean;
}

export interface RemoteHostTransport<
  RpcRegistry extends VersionedRpcRegistry,
  StreamRegistry extends VersionedStreamRpcRegistry,
> {
  /**
   * A per-caller view onto the shared `(hostId, userId)` session. Every
   * method delegates to the same live connection as every other consumer's
   * view; `close()` releases only THIS caller's reference (Architecture §4 /
   * S1) - the underlying connection tears down only after every consumer has
   * released AND the cache's keep-warm linger has expired, never on any
   * single caller's `close()`.
   */
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
    // No usable auth context at build time - the same "unconnectable"
    // degradation as a malformed public key, NOT a cacheable state. Two
    // shapes, one verdict:
    //
    //  - a NULL source: the bearer thunk is a live read, so a session built
    //    now could later dial once a context appears - while keyed under an
    //    epoch label divorced from that context.
    //  - a RELEASED source (non-null, but its lease has been retired, so
    //    `getBearerToken()` throws): a stale factory invocation running after
    //    its context was aborted. Its source object still labels the RETIRED
    //    epoch, so letting it into the cache would either re-adopt an entry
    //    supersession already condemned or - worse - present the stale epoch
    //    as newest on a miss and supersede the CURRENT context's live entry,
    //    while the session it builds can never mint a grant.
    //
    // Callers hitting either are in a teardown/transition gap (a sign-out or
    // context handoff landing between capture and build) and will rebuild
    // once a live context exists.
    return null;
  }

  const session = acquireRemoteSession(
    {
      hostId: options.hostId,
      userId: options.userId,
      hostPublicKey: options.hostPublicKey,
      relayAttachUrl: options.relayAttachUrl,
      // Part of the identity, not a per-consumer option: on a cache hit the
      // factory below never runs, so `auth` would otherwise be silently
      // inherited from whichever consumer happened to build the session first.
      authRecovery: options.auth === null ? "terminal" : "revalidate",
      // Same reasoning applied to WHICH auth context wired those closures, not
      // just which policy they implement. See `RemoteSessionIdentity.authEpoch`.
      authEpoch: authEpochFor(bearerSource),
    },
    { proactiveWakeEligible: options.proactiveWakeEligible },
    () => {
      const grantProvider = createAttachGrantProvider({
        authnBaseUrl: options.authnBaseUrl,
        hostId: options.hostId,
        // The mint's permission check. `null` is a value the grant client
        // already handles (it is the signed-out channel), so this refuses
        // through an existing, tested path rather than inventing a failure
        // mode. See `cloudAuthorized` for why the check lives in here and not
        // at build time.
        getBearerToken: () =>
          options.cloudAuthorized() ? deriveBearerToken(options.bearer) : null,
      });
      return new RemoteSession<RpcRegistry, StreamRegistry>({
        hostId: options.hostId,
        attachBaseUrl: options.relayAttachUrl,
        hostStaticPublicKey,
        grantProvider,
        bearer: options.bearer,
        auth: options.auth,
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
    streamClient: new RemoteStreamClient(session),
  };
}

/** Reads the current user bearer string from the shared bearer source. */
/**
 * Stable per-auth-context label for the session cache key.
 *
 * Identity is taken from the bearer SOURCE OBJECT rather than the token it
 * currently holds, because the two change on different events: a same-user
 * refresh rotates the token inside the existing lease (so the object, and
 * therefore this label, is unchanged and the connection keeps being shared),
 * while a real context transition - sign-out/sign-in, a rebuilt host runtime -
 * hands over a different lease and so a different label.
 *
 * A `WeakMap` both keeps the label stable for repeat acquires by the same
 * context and lets a retired lease be collected; the counter only ever needs
 * to be distinct, never meaningful. A `null` source never reaches here -
 * `createRemoteHostTransport` refuses to build (let alone cache) a session
 * with no auth context - so every label names a real lease.
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
 * Whether the source can provide a bearer RIGHT NOW - the same read the mint
 * path performs per attach (`deriveBearerToken`), probed once at build time.
 * A released credential lease keeps its object identity (and so its epoch
 * label) but throws on read; an empty token cannot authorize a mint either.
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
