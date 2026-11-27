import {
  LocalOpenAuth,
  SESSION_GRANT_REQUIRED,
  isLocalAdmissionFatal,
  teamMembershipUnavailable,
} from "./local-open-auth";
import type {
  MethodVersionRegistry,
  SchemaVersion,
  SplitConnectionManifest,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  downgradeRequestAcrossMajors,
  isRpcErrorCode,
  mergeConnectionManifests,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  upgradeResponseToVersion,
  upgradeResponseToVersionWithContext,
} from "@traycer/protocol/framework/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";
import {
  markMayHaveReachedHost,
  mayHaveReachedHost,
  transportFailureBeforeSend,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { isCredentialRefusal } from "@traycer/protocol/host-transport/door-refusal";
import {
  NO_HOST_TOKEN_PROBE,
  readDoorReason,
} from "@traycer/protocol/framework/door-reason";
import {
  createReleasedHostMemory,
  isReleasedHostTokenRefusal,
  markReleasedSignInRefusal,
  signInMayBeWritten,
  type HostInstance,
  type SignInAuthority,
  type SignInRecovery,
  type SignInRefusal,
  type ReleasedHostMemory,
  type ReleasedUnaryCause,
  type ReleasedUnarySignOn,
} from "./released-sign-on";
import { hostSignInKey } from "../auth/host-token-source";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  negotiatedVersionMeetsRequirement,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type HostTransportEndpoint,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import {
  asHostAnswer,
  instanceDoor,
  type HostDoorObserver,
  type InstanceDoor,
} from "./host-door-state";
import { dialPriorityForMethod } from "./dial-priority";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
} from "./ws-factory";
import { whenDialStarted } from "@traycer/protocol/host-transport/websocket";
import {
  CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1,
  checkCompatibility,
  hostFrameSchema,
  toClientHandshakeIdentity,
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
  type ClientHandshakeIdentity,
  type FirstPartyClientIdentity,
  type ClientFrame,
  type ConnectionManifest,
  type HostFrame,
  type HostResponseFrame,
  type HostFatalErrorFrame,
  type IncompatibleMethodDetails,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import type { TimerHandle } from "./timer-handle";
import { recordNegotiatedHostManifest } from "./negotiated-manifest-registry";
import { resolveUnavailableMethodDegrade } from "./unavailable-method-degrade";
import {
  localUnarySessionKey,
  LocalUnarySession,
  LocalUnarySessionDirectory,
  answersAsRun,
  type AttachedPersistentSocket,
  type PersistentSocketHandlers,
  type SessionHandoff,
  type SessionPublisher,
} from "./local-unary-session";

/**
 * Minimal endpoint shape the transport layer needs to dial a host. The
 * app-facing `HostDirectoryEntry` is a structural superset so existing
 * callers keep passing their directory entries unchanged - this narrow type
 * exists purely to keep `host-transport` free of any dependency on the
 * app-runtime host-directory module.
 */
export type { HostTransportEndpoint } from "./host-messenger";

/**
 * The complete reason emitted by hosts through 1.1.9 for the post-open timeout,
 * anchored at both ends so only the host's timeout value may vary.
 *
 * A prefix test is not good enough here. This match is what promotes an
 * `UNAUTHORIZED` - normally a hard credential rejection - into a no-dispatch
 * attestation that permits retrying a non-idempotent method, so it must
 * recognize the historical string and nothing that merely starts like it.
 */
const LEGACY_RPC_REQUEST_TIMEOUT_REASON =
  /^Timed out waiting for 'request' frame after openAck \(\d+ms\)$/;

/**
 * Production value for `WsRpcClientOptions.hostAttestationWindowMs`.
 *
 * The host's own deadline is 30s (`DEFAULT_POST_OPEN_TIMEOUT_MS` in its RPC
 * server), but that timer only *starts* counting event-loop time - a stalled
 * host fires it late. Issue #726 measured awake stalls of 35.7-40.8s, and the
 * profiled stall class reaches roughly 45s; 50s covers that class and leaves
 * bounded slack for delivering the frame afterwards.
 */
export const HOST_POST_OPEN_ATTESTATION_WINDOW_MS = 50_000;

/**
 * Freshly-armed tail of every attestation grace, and the floor for a grace
 * whose window share is already spent.
 *
 * Both peers' deadlines are plain `setTimeout`s, so a suspend/resume or an
 * event-loop stall runs every overdue callback in a single wake batch. A client
 * timer that ends the call from inside that batch wins against nothing: the
 * host's equally overdue post-`openAck` timer has not run yet, let alone put its
 * no-dispatch fatal on the wire. So no client timer ends the wait directly - it
 * hands over to this tail, which was armed *after* that callback ran and
 * therefore measures awake time. Issue #726 recorded 114ms between the desktop's
 * `system resumed` line and the host firing its overdue post-open timer, so a
 * few seconds of awake time is generous slack for emitting and delivering the
 * frame.
 *
 * The same value floors the grace when the caller's own deadline already
 * consumed the whole window - `providers.awaitLogin`'s 16-minute long poll, or
 * any deadline that expired late because both processes were suspended. Such a
 * deadline proves nothing about whether the host consumed the request, so it
 * needs a delivery opportunity too; it just does not need a second full window.
 */
const ATTESTATION_DELIVERY_SLACK_MS = 5_000;

/**
 * Overshoot past a delivery leg's own duration that means the process was not
 * *running* for most of it, rather than merely busy.
 *
 * A healthy event loop fires a timer within milliseconds of its deadline, and
 * even a badly congested one is late by hundreds; issue #726 measured host
 * event-loop gaps of 34-41 *seconds* and suspension gaps of minutes. A second
 * cleanly separates ordinary jitter - which must still let the grace end - from
 * a scheduling gap that froze this process, and with it the host's ability to
 * emit and deliver its attestation.
 */
const SUSPENSION_OVERSHOOT_TOLERANCE_MS = 1_000;

/**
 * Named on an `open` that can be adopted as a session. The persistent-session
 * name is an opt-in: a host that does not advertise it on `openAck` is kept
 * on one socket per call. An older host ignores a capability name it does not
 * know.
 */
const LOCAL_UNARY_OPEN_CAPABILITIES: readonly string[] = [
  CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
];

/**
 * A socket this client will use as one-shot. Omitting the session name keeps
 * an upgraded host on one socket per call: the process-lifetime legacy latch
 * does not re-probe, and advertising the name would make that host require a
 * bearer the one-shot request does not send.
 */
const LOCAL_UNARY_ONE_SHOT_CAPABILITIES: readonly string[] = [
  CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1,
];

/**
 * Injectable source of the host endpoint the client should target. Returning
 * `null` means "no host currently bound" - the client rejects requests with
 * a `HostRpcError` rather than dialing.
 */
export type HostEndpointProvider = () => HostTransportEndpoint | null;

/** Generates request IDs. */
export type RequestIdProvider = () => string;

export interface WsRpcClientOptions<Registry extends VersionedRpcRegistry> {
  readonly registry: Registry;
  readonly requestId: RequestIdProvider;
  readonly webSocketFactory: IWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly frameTimeoutMs: number;
  /**
   * Where this transport's dial outcomes and per-host connectivity go
   * (redesign P1.3). See {@link LocalHostLiveness} for why sessions here are
   * refcounted connectivity episodes rather than one per RPC. Shells with no
   * selection authority to feed pass `NO_TRANSPORT_EVIDENCE`.
   */
  readonly evidence: TransportEvidenceReporter;
  /**
   * How long after `openAck` this deployment's hosts are still expected to be
   * sitting in `awaitingRequest`, and therefore still able to emit their
   * no-dispatch attestation. Production clients pass
   * `HOST_POST_OPEN_ATTESTATION_WINDOW_MS`; `0` disables the grace entirely.
   *
   * When the client's own response deadline expires first, the response wait is
   * held open for whatever is left of this window instead of closing the socket
   * over an ambiguous in-flight request - see `openSession`. Sizing the grace
   * against this window rather than adding a fixed grace on top of the caller's
   * deadline makes it shrink as the caller's deadline grows, so a long CLI wait
   * never stacks a second full window on top of the first.
   *
   * It never shrinks to nothing, though: every post-send timeout keeps at least
   * `ATTESTATION_DELIVERY_SLACK_MS`, because a caller deadline that expired late
   * across a suspension - or a long-poll budget that outlasts this window
   * outright - says nothing about whether the host ever consumed the request.
   * `0` is the only way to opt out of the grace entirely, and means "this caller
   * cannot act on an attestation even if it arrives" (see the CLI's fast-fail
   * policy).
   *
   * The grace is a bound on *active* time, not on wall-clock time. Every leg is
   * a `setTimeout`, so a suspend/resume can run any callback arbitrarily late;
   * when that happens the wait gets a freshly measured delivery leg from
   * whenever the callback actually ran, and total wall-clock can far exceed this
   * window. That is the point - a resume is exactly when a host fires its
   * overdue post-open timer. What is guaranteed is that a process running
   * uninterrupted never waits longer than `hostAttestationWindowMs`, and that
   * the grace always ends on the first delivery leg that gets its full duration
   * of running time. Scheduling gaps neither peer could act through do not
   * consume that bound - and are not counted, since a count of sleeps is not
   * something the transport contract should encode.
   */
  readonly hostAttestationWindowMs: number;
  /**
   * WHO THIS CLIENT IS, sent on every `open` frame this transport writes.
   *
   * REQUIRED, not optional, and that is the whole safety property: a current
   * first-party build must not be able to ship a connection that forgot to
   * identify itself, because the host reads an absent identity as legacy
   * epoch 1 and will terminally refuse it once a floor is active. A default
   * here would let a new composition root silently produce that outcome; the
   * compiler refuses instead.
   *
   * It is a PROCESS CONSTANT (kind, epoch, and build version are all fixed
   * for the life of the process - updating the app restarts it), which is why
   * it is a construction dependency rather than something resolved per call.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
  readonly localOpenAuth?: LocalOpenAuth;
  readonly doorFor?: (hostId: string) => HostDoorObserver;
  /**
   * Replaces the caller's sign-in lease in every frame; `null` when no token can
   * be had now. With `waitForMint` false (a call's first ask, before any dial) it
   * never waits for a mint that has not answered: no dial to this machine's host
   * waits on the cloud. `true` only after a current host named its reason for
   * the probe: the host has answered, and only a host-only token opens it.
   */
  readonly hostBearerFor?: (
    hostId: string,
    signIn: OpenFrameBearerSource,
    waitForMint: boolean,
    /** The call's lifetime: a mint it started reports nothing once it is aborted. */
    callSignal: AbortSignal,
  ) => Promise<OpenFrameBearerSource | null>;
  /**
   * The answer of the mint running for `hostId` now (the token it bought, or
   * `null`), or `null` when none runs. When a current host answers the probe
   * `owner_sign_in` while one runs, the call waits for it: the token it
   * bought opens the host, and only with none is the sign-in asked for, so
   * which of the two answers came first decides nothing.
   */
  readonly runningHostMintFor?: (
    hostId: string,
  ) => Promise<OpenFrameBearerSource | null> | null;
  /**
   * Asked only after a released host's typed refusal of this call's host-only
   * token or probe, with the caller's authority: the sign-in lease to send the
   * call with once more, or `null`. A caller holding the host's row refuses a
   * row that is a team's, a sandbox's or another person's
   * (`opensReleasedWayOnThisMachine`); no caller reads a row for it. Asked too,
   * for this machine's host, when `hostBearerFor` has no token because none can
   * be had (the call then probes), and when a current host answers the probe
   * `owner_sign_in`. If the host refuses the sign-in, its `recovery` refreshes
   * it and the call goes once more, as a released client's did. Synchronous:
   * it is asked again at each write of a frame carrying the sign-in, with
   * nothing awaited between the answer and the write.
   */
  readonly releasedSignOnFor?: (
    authority: HostRequestAuthority,
    cause: ReleasedUnaryCause,
  ) => ReleasedUnarySignOn | null;
  /**
   * What this process has seen of each host's answers: a host that has named a
   * reason is never sent the sign-in. Without it, this client keeps its own.
   */
  readonly releasedHosts?: ReleasedHostMemory;
  /**
   * A probe answered `not_provisioned` fails with the host's own refusal, whose
   * reason is the host's sentence for the person; otherwise with the same error
   * as no token at all. The command line prints it, as a released one did.
   */
  readonly surfacesNotProvisioned?: boolean;
  /**
   * The host refused `presented`, the call's host-only token, as expired.
   * Answers whether it was the held one presented because authn did not answer
   * the mint: then the call asks `hostBearerFor` once more, which no longer
   * presents it while `instance` is still the host's current one.
   */
  readonly heldTokenRefusedFor?: (
    authority: HostRequestAuthority,
    presented: string,
    instance: HostInstance,
  ) => boolean;
  /** No owner's sign-in follows that refusal: see `TrackedHostTokens.forgetHeldRefused`. */
  readonly forgetHeldRefusalFor?: (authority: HostRequestAuthority) => void;
}

/** The released way's sign-in: the host instance whose refusal planned it, and its recovery while unspent. */
interface ReleasedSignIn {
  readonly signIn: Extract<SignInAuthority, { readonly kind: "released" }>;
  readonly recovery: SignInRecovery | null;
  /** The sign-in lease itself, ungated: what a refusal of it is compared with. */
  readonly lease: OpenFrameBearerSource;
}

/** The sign-in a current host invited: the invitation as its probe heard it, and its recovery while unspent. */
interface InvitedSignIn {
  readonly signIn: Extract<SignInAuthority, { readonly kind: "invited" }>;
  readonly recovery: SignInRecovery | null;
  /** The sign-in lease itself, ungated: what a refusal of it is compared with. */
  readonly lease: OpenFrameBearerSource;
}

/**
 * A call whose request was never written to a socket that a host process no
 * longer the host's then lost. It dials once more, planned as a fresh call is
 * (see `openSession`). A written request lost the same way stays as uncertain
 * as any socket loss leaves it.
 */
const lostToReplacedProcess = new WeakSet<HostRpcError>();

/**
 * A planned sign-in found, before the frame carrying it was written, to be one
 * that may no longer go. Nothing was written; the call plans again as a fresh
 * call would, and this never reaches its caller.
 */
class SignInWithdrawnError extends Error {}

/**
 * Concrete `IHostMessenger` that runs a single unary RPC over a freshly
 * dialed WebSocket connection per call.
 *
 * Per-request lifecycle:
 *   resolve bearer → dial → send `open { token, manifest }`
 *        → await `openAck { manifest }`
 *        → run client-side `checkCompatibility` against the host manifest
 *        → compute the asymmetric per-method on-wire schema version
 *        → transform caller's canonical params to on-wire shape
 *        → send `request` framed at the computed on-wire version
 *        → await `response` (correlated by `requestId`)
 *        → transform on-wire response back to caller's canonical shape
 *        → close (1000)
 *
 * Asymmetric per-method version-on-wire (specs/versioned-RPCs.yml, D-S6):
 *   - Same major, client newer minor: on-wire = host's older minor; request
 *     params are Zod-stripped to the older schema; response is upgraded from
 *     host's minor up to the client's canonical. If the caller's payload
 *     doesn't project onto the older schema at all (a newer-minor-only
 *     capability, e.g. a field the older schema requires non-null) this
 *     surfaces as `DOWNGRADE_UNSUPPORTED` before the request frame is sent -
 *     the same-major counterpart to the cross-major no-bridge case below.
 *   - Same major, client older minor: on-wire = caller's canonical; request
 *     and response flow unchanged (host handles the transforms).
 *   - Cross major, client newer: on-wire = host's canonical; the request is
 *     downgraded via `downgradeRequestAcrossMajors`; the response is upgraded
 *     via `upgradeResponseToVersion`. A missing direct downgrade bridge on
 *     the client surfaces as `DOWNGRADE_UNSUPPORTED` before the request frame
 *     is sent.
 *   - Cross major, client older: on-wire = caller's canonical; request and
 *     response flow unchanged.
 *
 * Failure mapping (Refactoring Approach D-N2):
 *   - dial timeout / transport unreachable / transport aborted / frame timeout
 *     → `HostTransportFailureError(code: "RPC_ERROR")` (the pre-send subset is
 *     a `RetryableTransportError`)
 *   - host post-open request timeout (including the exact legacy `UNAUTHORIZED`
 *     spelling) → `RetryableTransportError(code: "RPC_ERROR")`; the fatal is
 *     host attestation that the request was never dispatched. If the client's
 *     own response deadline expires first, the socket is held open for a
 *     bounded remainder of `hostAttestationWindowMs` so that attestation can
 *     still arrive; the ambiguous local timeout on its own stays non-retryable,
 *     and once it has been recorded the only frames that can still settle the
 *     call are that attestation and this request's own response - every other
 *     non-abort terminal event reports the recorded timeout rather than its own
 *     error.
 *   - missing / released bearer before dial → `HostRpcError(code: "RPC_ERROR")`
 *   - every other host `fatalError { code }` (`INCOMPATIBLE`, `UNAUTHORIZED`,
 *     or a domain-specific code) → known RPC codes are preserved on
 *     `HostRpcError.code`; domain-specific codes become `RPC_ERROR` while
 *     the original code stays in `fatalDetails`.
 *   - client mirror compat failure (other than cross-major no-bridge on the
 *     called method) → emits a `fatalError` frame at the client, then
 *     surfaces the same details back as a thrown
 *     `HostRpcError(code: "INCOMPATIBLE")`.
 *   - cross-major no-bridge, or same-major request-projection failure, on
 *     the called method → no `fatalError` frame is emitted; surfaces as
 *     `HostRpcError(code: "DOWNGRADE_UNSUPPORTED")`.
 *   - response upgrade throw → `HostRpcError(code: "RPC_ERROR")` with the
 *     wrapped message.
 *
 * A host that does not advertise `unary.persistentSession` is still dialed
 * once per call, and the socket closes with the response. A host that does
 * is dialed once per host and signed-in identity: the discovering socket
 * stays open, and later calls reuse it. Isolation is then by contract. Each
 * request carries its own bearer and abort, and the host builds a request
 * context for that request alone and discards it when the request settles.
 * The only state kept for the socket is the negotiated manifest, the
 * identity the open frame authenticated, and the host instance that admitted
 * it: a session is reused only while that instance is current.
 */

export class WsRpcClient<
  Registry extends VersionedRpcRegistry,
> implements IHostMessenger<Registry> {
  private readonly registry: Registry;
  private readonly requestIdProvider: RequestIdProvider;
  private readonly webSocketFactory: IWebSocketFactory;
  private readonly dialTimeoutMs: number;
  private readonly frameTimeoutMs: number;
  private readonly hostAttestationWindowMs: number;
  private readonly evidence: TransportEvidenceReporter;
  private readonly liveness: LocalHostLiveness;
  /**
   * Serialized ONCE at construction, not per request: every member is a
   * process constant, so re-projecting it on each of this transport's
   * per-request sockets would allocate an identical object per RPC.
   */
  private readonly clientIdentity: ClientHandshakeIdentity;
  private readonly sessions = new LocalUnarySessionDirectory<Registry>();
  private readonly localOpenAuth: LocalOpenAuth | undefined;
  /** The only door this client answers to: an answer from a host instance that is no longer current reaches none. */
  private readonly door: InstanceDoor | null;
  private readonly hostBearerFor: WsRpcClientOptions<Registry>["hostBearerFor"];
  private readonly runningHostMintFor: WsRpcClientOptions<Registry>["runningHostMintFor"];
  private readonly releasedSignOnFor: WsRpcClientOptions<Registry>["releasedSignOnFor"];
  /** Authorities carrying the released way's sign-in. */
  private readonly signInAuthorities = new WeakMap<
    HostRequestAuthority,
    ReleasedSignIn
  >();
  /** Authorities carrying `NO_HOST_TOKEN_PROBE` in place of a host-only token that cannot be had. */
  private readonly probeAuthorities = new WeakSet<HostRequestAuthority>();
  private readonly releasedHosts: ReleasedHostMemory;
  private readonly surfacesNotProvisioned: boolean;
  private readonly heldTokenRefusedFor: WsRpcClientOptions<Registry>["heldTokenRefusedFor"];
  private readonly forgetHeldRefusalFor: WsRpcClientOptions<Registry>["forgetHeldRefusalFor"];
  /** Authorities carrying the sign-in a current host invited (`owner_sign_in`). */
  private readonly ownerSignInAuthorities = new WeakMap<
    HostRequestAuthority,
    InvitedSignIn
  >();
  /** The invited sign-in was refused as expired, a recovery is left, and the door has not heard of it. */
  private readonly ownerSignInRefusals = new WeakSet<HostRpcError>();
  /** A held token presented while authn did not answer was refused as expired; the door has not heard of it. */
  private readonly heldRefusals = new WeakSet<HostRpcError>();
  /** A released host refused the host-only token, and the door has not heard of it. */
  private readonly releasedRefusals = new WeakSet<HostRpcError>();
  /** A released host refused the sign-in, a recovery is left, and the door has not heard of it. */
  private readonly signInRefusals = new WeakSet<HostRpcError>();
  /**
   * The sign-in the refused OPEN carried, for a refusal of the sign-in or the
   * invited sign-in: the recovery refreshes only that one, never a lease read
   * after it may have rotated. Absent when a session grant was on the wire.
   */
  private readonly refusedSignIns = new WeakMap<HostRpcError, string>();
  /** The host instance that gave each refusal: its OPEN's, or that of the published session it came on. */
  private readonly refusedBy = new WeakMap<HostRpcError, HostInstance>();
  /** The host instance each published session was admitted by: it is reused only while that one is current. */
  private readonly sessionOwners = new WeakMap<
    LocalUnarySession<Registry>,
    HostInstance
  >();
  private readonly reprobeErrors = new WeakSet<HostRpcError>();
  private readonly localRevisionByHost = new Map<string, number>();
  /** Counts `releaseIdleLocalSessions`, so a call can tell one ran since its previous claim. */
  private localReleases = 0;

  constructor(options: WsRpcClientOptions<Registry>) {
    this.localOpenAuth = options.localOpenAuth;
    this.hostBearerFor = options.hostBearerFor;
    this.runningHostMintFor = options.runningHostMintFor;
    this.releasedSignOnFor = options.releasedSignOnFor;
    this.releasedHosts = options.releasedHosts ?? createReleasedHostMemory();
    const doorFor = options.doorFor;
    this.door =
      doorFor === undefined
        ? null
        : instanceDoor(
            {
              admitted: (instance) => doorFor(instance.hostId).admitted(),
              refused: (details, instance) =>
                doorFor(instance.hostId).refused(details),
            },
            this.releasedHosts,
          );
    this.surfacesNotProvisioned = options.surfacesNotProvisioned === true;
    this.heldTokenRefusedFor = options.heldTokenRefusedFor;
    this.forgetHeldRefusalFor = options.forgetHeldRefusalFor;
    this.registry = options.registry;
    this.requestIdProvider = options.requestId;
    this.webSocketFactory = options.webSocketFactory;
    this.dialTimeoutMs = options.dialTimeoutMs;
    this.frameTimeoutMs = options.frameTimeoutMs;
    this.hostAttestationWindowMs = options.hostAttestationWindowMs;
    this.evidence = options.evidence;
    this.liveness = new LocalHostLiveness(options.evidence);
    this.clientIdentity = toClientHandshakeIdentity(options.clientIdentity);
  }

  /**
   * Closes sessions with nothing queued and nothing in flight.
   * A process that builds a client for one call uses this when that call
   * settles, so the adopted socket does not keep the process alive. A client
   * that outlives its calls does not: the idle socket is what the next call
   * reuses.
   */
  releaseIdleLocalSessions(): void {
    this.localReleases += 1;
    this.sessions.releaseIdle();
  }

  async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.requestWithResponseTimeout(
      method,
      params,
      this.frameTimeoutMs,
      options,
    );
  }

  async requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    let challengeRetried = false;
    let grantReprobed = false;
    let heldRetried = false;
    // One call is one dial sequence, and it spends at most one sign-in refresh
    // that authn answered: a second refusal of its sign-in, released or
    // invited, is no progress, and stays quiet as the stream's and the relay's
    // bounds do. A refresh that did not reach authn ends the call with the
    // host's refusal, so it never spends this.
    let signInRefreshSpent = false;
    let signInReplanned = false;
    let replacedRedialed = false;
    const hostBearerFor = this.hostBearerFor;
    // Every claim this call makes follows an await (the token lookup, a
    // redial's plan, a refresh, a mint) that a release can land in while the
    // call holds no slot to arm. Each claim compares against the one before.
    let releasesSeen = this.localReleases;
    // With no token to look up, the claim stays in the caller's tick.
    let hostOptions =
      hostBearerFor === undefined
        ? options
        : await this.withHostBearer(
            hostBearerFor,
            options,
            method,
            "no-host-token",
          );
    for (;;) {
      // A probe dials its own socket and claims no slot, so a release it sees
      // is left for the next iteration's claim.
      const probing = this.probeAuthorities.has(hostOptions.authority);
      const releasedBeforeClaim =
        !probing && this.localReleases !== releasesSeen;
      if (!probing) releasesSeen = this.localReleases;
      try {
        return await this.requestWithResponseTimeoutInternal(
          method,
          params,
          responseTimeoutMs,
          hostOptions,
          releasedBeforeClaim,
        );
      } catch (cause) {
        if (
          cause instanceof HostRpcError &&
          lostToReplacedProcess.has(cause) &&
          !replacedRedialed
        ) {
          // The socket's host process was replaced before it answered for
          // this call: dial once more, planned as a fresh call is. Nothing an
          // earlier attempt planned or heard goes with it.
          replacedRedialed = true;
          hostOptions =
            hostBearerFor === undefined
              ? options
              : await this.withHostBearer(
                  hostBearerFor,
                  options,
                  method,
                  "no-host-token",
                );
          continue;
        }
        if (cause instanceof HostRpcError && this.releasedRefusals.has(cause)) {
          const signIn = this.askReleasedSignOn(options.authority, "refused");
          // The sign-in goes only to the instance whose refusal asked for it.
          const owner = this.refusedBy.get(cause);
          if (signIn === null || owner === undefined) {
            this.reportRefusal(cause);
            throw cause;
          }
          const authority = this.withSignIn(options.authority, signIn.bearer);
          this.signInAuthorities.set(authority, {
            signIn: { kind: "released", owner },
            recovery: signIn.recovery,
            lease: signIn.bearer,
          });
          hostOptions = { ...options, authority };
          continue;
        }
        if (
          cause instanceof HostRpcError &&
          this.ownerSignInRefusals.has(cause)
        ) {
          const authority = hostOptions.authority;
          if (hostBearerFor === undefined) throw cause;
          const invited = this.ownerSignInAuthorities.get(authority);
          const recovery = invited?.recovery ?? null;
          const adopted =
            recovery !== null &&
            cause.fatalDetails !== null &&
            this.holdsNewerSignIn(invited, cause);
          if (!adopted && signInRefreshSpent) throw cause;
          // A call whose caller ended starts no rotation: it fails as it
          // would after one.
          throwIfAuthorityAborted(options.authority, cause.requestId, method);
          const owner = this.refusedBy.get(cause);
          const outcome =
            recovery === null ||
            cause.fatalDetails === null ||
            owner === undefined
              ? "rejected"
              : adopted
                ? "adopted"
                : await recovery
                    .revalidateForReconnect(
                      owner,
                      this.signInRefusalOf(cause),
                      () => !options.authority.abortSignal.aborted,
                    )
                    .then((answer) =>
                      // A replaced refusing process: the call fails with the
                      // refusal, as with a refresh that did not reach authn. A
                      // verdict on the sign-in fails it as a rejection does.
                      answer === "process-replaced"
                        ? ("network-error" as const)
                        : typeof answer === "object"
                          ? ("rejected" as const)
                          : answer,
                    )
                    .catch(() => "network-error" as const);
          throwIfAuthorityAborted(options.authority, cause.requestId, method);
          // A refusal of the person's sign-in never reaches the door; the
          // call fails with it.
          if (outcome !== "rotated" && outcome !== "adopted") throw cause;
          // A sibling's rotation taken from the store was not authn's answer
          // to this call: it spends nothing.
          if (outcome === "rotated") signInRefreshSpent = true;
          // The invitation is spent by the sign-in it invited: the refreshed
          // one goes only if the host invites again. The next attempt presents
          // a host-only token if one can be had, else the placeholder.
          try {
            hostOptions = await this.withHostBearer(
              hostBearerFor,
              options,
              method,
              "no-host-token",
            );
          } catch {
            throw cause;
          }
          continue;
        }
        if (cause instanceof SignInWithdrawnError) {
          // The row, the instance that asked for the sign-in, or the host's
          // answers since withdrew it before a frame carrying it was written:
          // plan again as a fresh call would. Once only; a second withdrawal
          // ends the call as one with no host-only token does.
          if (signInReplanned || hostBearerFor === undefined)
            throw noHostTokenError(this.requestIdProvider(), method);
          signInReplanned = true;
          hostOptions = await this.withHostBearer(
            hostBearerFor,
            options,
            method,
            "no-host-token",
          );
          continue;
        }
        if (
          cause instanceof HostRpcError &&
          this.heldRefusals.has(cause) &&
          hostBearerFor !== undefined &&
          !heldRetried
        ) {
          heldRetried = true;
          try {
            hostOptions = await this.withHostBearer(
              hostBearerFor,
              options,
              method,
              "held-token-refused",
            );
          } catch {
            this.reportRefusal(cause);
            throw cause;
          }
          continue;
        }
        if (cause instanceof HostRpcError && this.signInRefusals.has(cause)) {
          const authority = hostOptions.authority;
          const released = this.signInAuthorities.get(authority);
          const recovery = released?.recovery ?? null;
          const adopted =
            recovery !== null &&
            cause.fatalDetails !== null &&
            this.holdsNewerSignIn(released, cause);
          if (!adopted && signInRefreshSpent) throw cause;
          // A call whose caller ended starts no rotation: it fails as it
          // would after one.
          throwIfAuthorityAborted(options.authority, cause.requestId, method);
          const owner = this.refusedBy.get(cause);
          const outcome =
            recovery === null ||
            cause.fatalDetails === null ||
            owner === undefined
              ? "rejected"
              : adopted
                ? "adopted"
                : await recovery
                    .revalidateForReconnect(
                      owner,
                      this.signInRefusalOf(cause),
                      () => !options.authority.abortSignal.aborted,
                    )
                    .then((answer) =>
                      // A replaced refusing process: the call fails with the
                      // refusal, as with a refresh that did not reach authn. A
                      // verdict on the sign-in fails it as a rejection does.
                      answer === "process-replaced"
                        ? ("network-error" as const)
                        : typeof answer === "object"
                          ? ("rejected" as const)
                          : answer,
                    )
                    .catch(() => "network-error" as const);
          throwIfAuthorityAborted(options.authority, cause.requestId, method);
          // A refusal of the person's sign-in never reaches the door; the
          // call fails with it.
          if (outcome !== "rotated" && outcome !== "adopted") throw cause;
          // A sibling's rotation taken from the store was not authn's answer
          // to this call: it spends nothing.
          if (outcome === "rotated") signInRefreshSpent = true;
          continue;
        }
        // The probe carried no credential of the person's: a current host's
        // answer to it is not theirs to see, and the call fails as with no token.
        if (
          cause instanceof HostRpcError &&
          this.probeAuthorities.has(hostOptions.authority)
        ) {
          // Only a refusal naming its reason is a current host's answer; a
          // transport failure or any other answer leaves the next call to probe again.
          if (cause.fatalDetails === null) throw cause;
          const reason = readDoorReason(cause.fatalDetails.doorReason);
          if (reason === "absent") throw cause;
          const hostId = options.authority.endpoint.hostId;
          // An answer from a process instance this host has since left selects
          // no plan and declines nothing: the call fails as with no token.
          const instance = this.refusedBy.get(cause);
          if (instance === undefined || !this.releasedHosts.isCurrent(instance))
            throw noHostTokenError(this.requestIdProvider(), method);
          // Heard now, before any wait: a refusal meanwhile withdraws it.
          const invitation = this.releasedHosts.invitationHeard(instance);
          const running =
            reason === "owner_sign_in"
              ? (this.runningHostMintFor?.(hostId) ?? null)
              : null;
          if (running !== null) {
            const bought = await untilAborted(
              running.catch(() => null),
              options.authority.abortSignal,
            );
            throwIfAuthorityAborted(options.authority, cause.requestId, method);
            if (bought !== null) {
              hostOptions = {
                ...options,
                authority: { ...options.authority, bearer: bought },
              };
              continue;
            }
          }
          // A current host invites the sign-in: only while no host-only token
          // can be had.
          const invited =
            reason === "owner_sign_in"
              ? this.askReleasedSignOn(options.authority, "owner-sign-in")
              : null;
          if (invited !== null) {
            const authority = this.withSignIn(
              options.authority,
              invited.bearer,
            );
            this.ownerSignInAuthorities.set(authority, {
              signIn: { kind: "invited", invitation },
              recovery: invited.recovery,
              lease: invited.bearer,
            });
            hostOptions = { ...options, authority };
            continue;
          }
          this.forgetHeldRefusalFor?.(options.authority);
          if (reason !== "owner_sign_in" && reason !== "not_provisioned")
            this.releasedHosts.declineProbe(
              options.authority.bearer.identity.userId,
              instance,
            );
          if (reason === "not_provisioned" && this.surfacesNotProvisioned)
            throw cause;
          // The host has answered and takes no sign-in from this person: only a
          // host-only token opens it, so the mint started before the probe is
          // awaited now. A computer with no owner has no token to mint.
          const minted =
            reason === "not_provisioned" || hostBearerFor === undefined
              ? null
              : await untilAborted(
                  hostBearerFor(
                    hostId,
                    options.authority.bearer,
                    true,
                    options.authority.abortSignal,
                  ).catch(() => null),
                  options.authority.abortSignal,
                );
          // The shared mint goes on for whoever else asked; this call ends.
          throwIfAuthorityAborted(options.authority, cause.requestId, method);
          if (minted !== null) {
            hostOptions = {
              ...options,
              authority: { ...options.authority, bearer: minted },
            };
            continue;
          }
          throw noHostTokenError(this.requestIdProvider(), method);
        }
        if (cause instanceof HostRpcError && cause.doorRefusal !== null) {
          const owner = this.refusedBy.get(cause);
          if (owner !== undefined) this.door?.refused(cause.doorRefusal, owner);
        }
        if (
          this.localOpenAuth === undefined ||
          !(cause instanceof HostRpcError)
        )
          throw cause;
        if (this.reprobeErrors.has(cause) && !grantReprobed) {
          grantReprobed = true;
          challengeRetried = false;
          continue;
        }
        if (
          cause.fatalDetails?.code === SESSION_GRANT_REQUIRED &&
          !challengeRetried
        ) {
          challengeRetried = true;
          continue;
        }
        throw cause;
      }
    }
  }

  private async withHostBearer(
    hostBearerFor: NonNullable<WsRpcClientOptions<Registry>["hostBearerFor"]>,
    options: HostRequestOptions,
    method: string,
    cause: "no-host-token" | "held-token-refused",
  ): Promise<HostRequestOptions> {
    const hostId = options.authority.endpoint.hostId;
    const bearer = await hostBearerFor(
      hostId,
      options.authority.bearer,
      false,
      options.authority.abortSignal,
    );
    if (bearer !== null)
      return { ...options, authority: { ...options.authority, bearer } };
    const signIn = this.releasedHosts.probeDeclined(
      options.authority.bearer.identity.userId,
      hostId,
    )
      ? null
      : this.askReleasedSignOn(options.authority, cause);
    // Only a host that answers the probe the released way is then sent the sign-in.
    if (signIn !== null) {
      const authority: HostRequestAuthority = {
        ...options.authority,
        bearer: {
          identity: options.authority.bearer.identity,
          getBearerToken: () => NO_HOST_TOKEN_PROBE,
        },
      };
      this.probeAuthorities.add(authority);
      return { ...options, authority };
    }
    this.forgetHeldRefusalFor?.(options.authority);
    throw noHostTokenError(this.requestIdProvider(), method);
  }

  /** A refusal reported once the call has waited: the door drops it unless the instance that gave it is still current. */
  private reportRefusal(cause: HostRpcError): void {
    const owner = this.refusedBy.get(cause);
    if (cause.fatalDetails !== null && owner !== undefined)
      this.door?.refused(cause.fatalDetails, owner);
  }

  /** `releasedSignOnFor`'s answer, or `null` when there is none or it throws. */
  private askReleasedSignOn(
    authority: HostRequestAuthority,
    cause: ReleasedUnaryCause,
  ): ReleasedUnarySignOn | null {
    try {
      return this.releasedSignOnFor?.(authority, cause) ?? null;
    } catch {
      return null;
    }
  }

  /** The sign-in `cause` refused, for its recovery: a host's refusal, not a mint, so no order. */
  private signInRefusalOf(cause: HostRpcError): SignInRefusal | null {
    const signIn = hostSignInKey(this.refusedSignIns.get(cause) ?? null);
    return signIn === null ? null : { signIn, order: null };
  }

  /**
   * Whether the sign-in lease of the refused authority now holds a different
   * sign-in than the one `cause` refused. A lease that holds none holds no
   * newer one.
   */
  private holdsNewerSignIn(
    signIn: { readonly lease: OpenFrameBearerSource } | undefined,
    cause: HostRpcError,
  ): boolean {
    const refused = this.refusedSignIns.get(cause);
    if (refused === undefined || signIn === undefined) return false;
    try {
      return extractBearerForOpenFrame(signIn.lease) !== refused;
    } catch {
      return false;
    }
  }

  /**
   * `base` carrying `signIn`. Its token is read where each frame carrying it is
   * written, a request on a published session or (after the OPEN's own check,
   * {@link signInMayGoNow} with `atOpen`) an OPEN, in the same tick as that
   * write: once the sign-in may no longer go, the read throws
   * {@link SignInWithdrawnError} and nothing is written.
   */
  private withSignIn(
    base: HostRequestAuthority,
    signIn: OpenFrameBearerSource,
  ): HostRequestAuthority {
    const authority: HostRequestAuthority = {
      ...base,
      bearer: {
        identity: signIn.identity,
        getBearerToken: () => {
          if (!this.signInMayGoNow(authority, false))
            throw new SignInWithdrawnError();
          return signIn.getBearerToken();
        },
      },
    };
    return authority;
  }

  /**
   * `signInMayBeWritten` for the sign-in `authority` carries, read now with
   * nothing awaited before the write. The row is `releasedSignOnFor`'s
   * `refused` answer, the row rule alone; an invited OPEN also needs its
   * `owner-sign-in` answer, which adds the eligibility read now. Where no
   * instance is observed, which is every remote host, the instance is the host
   * id's one and only, so only the row and the named reason decide. An
   * authority with no sign-in has nothing to withdraw.
   */
  private signInMayGoNow(
    authority: HostRequestAuthority,
    atOpen: boolean,
  ): boolean {
    const signIn =
      this.signInAuthorities.get(authority)?.signIn ??
      this.ownerSignInAuthorities.get(authority)?.signIn;
    if (signIn === undefined) return true;
    return signInMayBeWritten(
      {
        hosts: this.releasedHosts,
        rowAllows: () => this.askReleasedSignOn(authority, "refused") !== null,
        ownerSignInEligible: () =>
          this.askReleasedSignOn(authority, "owner-sign-in") !== null,
      },
      signIn,
      atOpen,
    );
  }

  /**
   * The instance that admitted `session`, while it is still current. Otherwise
   * `session` leaves reuse, closing once its calls settle, and `null`: the
   * caller dials as a fresh call would.
   */
  private currentOwnerOf(
    sessionKey: string,
    session: LocalUnarySession<Registry>,
  ): HostInstance | null {
    const owner = this.sessionOwners.get(session);
    if (owner !== undefined && this.releasedHosts.isCurrent(owner))
      return owner;
    this.sessions.fail(sessionKey, session);
    session.releaseIfIdle();
    return null;
  }

  /**
   * A call on a published session: its refusals are `owner`'s. A sign-in the
   * call may no longer send was not written, and takes `session` out of reuse.
   */
  private async callOnSession<Method extends keyof Registry & string>(
    session: LocalUnarySession<Registry>,
    sessionKey: string,
    owner: HostInstance,
    input: {
      readonly requestId: string;
      readonly method: Method;
      readonly params: RequestOfMethod<Registry, Method>;
      readonly responseTimeoutMs: number;
      readonly options: HostRequestOptions;
      readonly boundToDialRelease: boolean;
    },
  ): Promise<ResponseOfMethod<Registry, Method>> {
    try {
      return await session.call(input);
    } catch (cause) {
      if (cause instanceof SignInWithdrawnError) {
        this.sessions.fail(sessionKey, session);
        session.releaseIfIdle();
      } else if (
        cause instanceof RetryableTransportError &&
        !mayHaveReachedHost(cause) &&
        !this.releasedHosts.isCurrent(owner)
      ) {
        // Not written to a session whose host process was since replaced: the
        // call dials once more (see `lostToReplacedProcess`).
        lostToReplacedProcess.add(cause);
      } else if (cause instanceof HostRpcError) {
        this.refusedBy.set(cause, owner);
      }
      throw cause;
    }
  }

  /** See `released-sign-on.ts`. */
  private answersReleasedWay(
    authority: HostRequestAuthority,
    usesSessionGrant: boolean,
    details: FatalErrorDetails,
  ): boolean {
    return (
      this.releasedSignOnFor !== undefined &&
      !usesSessionGrant &&
      !this.signInAuthorities.has(authority) &&
      !this.releasedHosts.namedReason(authority.endpoint.hostId) &&
      isReleasedHostTokenRefusal(details)
    );
  }

  private async requestWithResponseTimeoutInternal<
    Method extends keyof Registry & string,
  >(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    options: HostRequestOptions,
    releasedBeforeClaim: boolean,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const requestId = this.requestIdProvider();
    const selected = options.authority.endpoint;
    throwIfAuthorityAborted(options.authority, requestId, method);
    if (selected.websocketUrl === null) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: `Host '${selected.hostId}' does not expose a WebSocket endpoint`,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    const websocketUrl = selected.websocketUrl;
    const revision = this.localOpenAuth?.revisionFor(selected.hostId) ?? 0;
    const previousRevision = this.localRevisionByHost.get(selected.hostId);
    if (previousRevision !== undefined && previousRevision !== revision)
      this.sessions.releaseIdle();
    this.localRevisionByHost.set(selected.hostId, revision);
    const sessionKey =
      localUnarySessionKey(
        selected.hostId,
        options.authority.bearer.identity.userId,
        websocketUrl,
      ) + (this.localOpenAuth === undefined ? "" : `\u0000${revision}`);
    // The probe is answered at open, so it dials its own socket: a session
    // another call opened would dispatch it, and the probe catch would take
    // that dispatched call's error for the host's answer to the probe.
    if (this.probeAuthorities.has(options.authority))
      return this.requestOnFreshSocket(
        method,
        params,
        responseTimeoutMs,
        options,
        requestId,
        null,
        sessionKey,
      );
    // A sign-in rides a published session only as it would open one: its
    // row, owner, mark and invitation are read as its request frame is
    // written (`withSignIn`).
    let handoff: SessionHandoff | null = null;
    for (;;) {
      const admission = this.sessions.claim(sessionKey, handoff);
      handoff = null;
      if (admission.kind === "ready") {
        const owner = this.currentOwnerOf(sessionKey, admission.session);
        if (owner === null) continue;
        return this.callOnSession(admission.session, sessionKey, owner, {
          requestId,
          method,
          params,
          responseTimeoutMs,
          options,
          boundToDialRelease: false,
        });
      }
      if (admission.kind === "legacy") {
        return this.requestOnFreshSocket(
          method,
          params,
          responseTimeoutMs,
          options,
          requestId,
          null,
          sessionKey,
        );
      }
      if (admission.kind === "wait") {
        const hold = this.sessions.acquireDialHold(sessionKey);
        try {
          const settled = await waitForSessionAdmission(
            admission.settled,
            options.authority,
            requestId,
            method,
          );
          if (settled.kind === "ready") {
            const owner = this.currentOwnerOf(sessionKey, settled.session);
            if (owner !== null)
              return await this.callOnSession(
                settled.session,
                sessionKey,
                owner,
                {
                  requestId,
                  method,
                  params,
                  responseTimeoutMs,
                  options,
                  boundToDialRelease: true,
                },
              );
            continue;
          }
          if (settled.kind === "failed") {
            throw readdressDiscoveryFailure(settled.error, requestId, method);
          }
          if (settled.kind === "legacy") {
            return await this.requestOnFreshSocket(
              method,
              params,
              responseTimeoutMs,
              options,
              requestId,
              null,
              sessionKey,
            );
          }
          // This handoff names the slot that still holds the release.
          // The next claim converts that object and no other.
          handoff = settled.handoff;
        } catch (cause) {
          admission.relinquish();
          throw cause;
        } finally {
          admission.leave();
          hold.release();
        }
        continue;
      }
      // A release since this call's previous claim found no slot to arm.
      if (releasedBeforeClaim) this.sessions.armReleaseBeforeReady(sessionKey);
      return this.requestOnFreshSocket(
        method,
        params,
        responseTimeoutMs,
        options,
        requestId,
        admission.publish,
        sessionKey,
      );
    }
  }

  private async requestOnFreshSocket<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    options: HostRequestOptions,
    requestId: string,
    publish: SessionPublisher<Registry> | null,
    sessionKey: string,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const { idempotencyKey, authority } = options;
    const selected = authority.endpoint;
    const admissionRevision =
      this.localOpenAuth?.revisionFor(selected.hostId) ?? 0;
    let published = false;
    const settleUnpublished = (cause: unknown): void => {
      if (publish === null || published) {
        return;
      }
      if (
        (cause instanceof HostRpcError && this.reprobeErrors.has(cause)) ||
        isCallerSpecificAuthRefusal(cause) ||
        (cause instanceof HostRpcError &&
          cause.fatalDetails?.code === SESSION_GRANT_REQUIRED)
      ) {
        // The host refused this call's open-frame credential. A waiter on
        // the same account can hold a different lease, so it dials its own
        // handshake instead of inheriting this refusal.
        publish.retry();
      } else if (
        cause instanceof HostRpcError &&
        cause.fatalDetails !== null &&
        !(cause instanceof RetryableTransportError)
      ) {
        publish.failed(cause);
      } else {
        publish.retry();
      }
      published = true;
    };
    const discovery = prepareDiscoveryOpen(
      authority,
      requestId,
      method,
      settleUnpublished,
    );

    let session: Session | null = null;
    let socket: WebSocketLike | null = null;
    const onAbort = (): void => {
      session?.abort();
    };
    let adopted = false;

    try {
      const clientManifest = this.buildManifest();
      const usesSessionGrant =
        this.localOpenAuth?.requiresSessionGrant(selected.hostId) === true;
      let sessionGrant: string | null = null;
      if (usesSessionGrant && this.localOpenAuth !== undefined) {
        const readiness = await this.localOpenAuth.ensureMemberReady(
          selected,
          authority.bearer,
          authority.abortSignal,
        );
        throwIfAuthorityAborted(authority, requestId, method);
        if (readiness.kind === "reprobe") {
          const error = hostFatalError(
            { kind: "fatalError", details: readiness.fatal },
            requestId,
            method,
            "beforeRequest",
          );
          this.reprobeErrors.add(error);
          throw error;
        }
        if (readiness.kind !== "ready") {
          throw hostFatalError(
            {
              kind: "fatalError",
              details:
                readiness.kind === "refused"
                  ? readiness.fatal
                  : (readiness.retryCause ?? teamMembershipUnavailable()),
            },
            requestId,
            method,
            "beforeRequest",
          );
        }
        const provision = await this.localOpenAuth.mint(
          selected.hostId,
          authority.bearer,
          authority.abortSignal,
        );
        throwIfAuthorityAborted(authority, requestId, method);
        if (provision.kind !== "ok") {
          throw hostFatalError(
            {
              kind: "fatalError",
              details:
                provision.kind === "refused"
                  ? provision.fatal
                  : (provision.retryCause ?? teamMembershipUnavailable()),
            },
            requestId,
            method,
            "beforeRequest",
          );
        }
        sessionGrant = provision.token;
      }
      // The host process instance this attempt is dialed to: every mark,
      // plan and report this OPEN causes applies to it alone.
      const instance = this.releasedHosts.currentInstance(selected.hostId);
      // Construction is inside this try: `create()` throws synchronously when
      // the runtime has no WebSocket global, and that throw has to release the
      // unpublished dial. A slot left in `dialing` would make the next call
      // wait forever.
      socket = this.webSocketFactory.create(
        discovery.websocketUrl,
        // Classified here because here is where the method is known: the
        // factory sees a URL. A one-shot host is dialed once per call, and
        // the discovering dial of a persistent session uses this call's
        // method. See `dial-priority.ts`.
        dialPriorityForMethod(method),
      );
      session = openSession({
        socket,
        dialTimeoutMs: this.dialTimeoutMs,
        hostAttestationWindowMs: this.hostAttestationWindowMs,
        requestId,
        method,
        hostId: selected.hostId,
        evidence: this.evidence,
        liveness: this.liveness,
        owner: instance,
        isCurrent: (owner) => this.releasedHosts.isCurrent(owner),
      });
      authority.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (authority.abortSignal.aborted) {
        onAbort();
      }

      await session.dial();
      throwIfAuthorityAborted(authority, requestId, method);
      // The sign-in goes only where it still may, asked again at OPEN because
      // the dial can wait for a slot, with nothing awaited before the write:
      // row, owner, mark, invitation, and an invited OPEN's eligibility.
      if (!this.signInMayGoNow(authority, true))
        throw new SignInWithdrawnError();
      // A queued dial must still belong to its bearer lease at OPEN, even
      // when the wire token is the grant minted before socket construction.
      const liveBearer = extractBearerOrThrowRpcError(
        authority.bearer,
        requestId,
        method,
      );
      const token = sessionGrant ?? liveBearer;

      session.send({
        kind: "open",
        // Read again after the dial, which may have waited for a slot
        // (`ws-dial-gate.ts`) with no bound of its own: the bearer can rotate
        // or expire meanwhile. `prepareDiscoveryOpen` still reads it first,
        // so a call with no bearer fails before it dials.
        token,
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
        capabilities:
          publish === null
            ? LOCAL_UNARY_ONE_SHOT_CAPABILITIES
            : LOCAL_UNARY_OPEN_CAPABILITIES,
        clientIdentity: this.clientIdentity,
        // Additive and needs no negotiation to send: an older host's copy of
        // the open-frame schema strips the key (zod objects are non-strict) and
        // behaves exactly as it does today. `undefined` travels as an absent
        // key, which is the same "does not speak verdicts" signal a released
        // client sends - so an authority built before this existed is
        // indistinguishable on the wire from a client that predates it, which
        // is the correct reading of both.
        cloudAuthorized: authority.cloudAuthorized?.(),
      });

      const invitedSignIn = this.ownerSignInAuthorities.has(authority);
      if (invitedSignIn) this.releasedHosts.invitedSignInWritten(instance);
      // Handshake stays on the transport default even when the caller
      // extended the response wait - a host that can't complete `openAck`
      // quickly is unreachable, and long-poll patience must not mask that.
      let ackFrame: HostFrame;
      try {
        ackFrame = await session.next(this.frameTimeoutMs);
      } finally {
        if (invitedSignIn) this.releasedHosts.invitedSignInAnswered(instance);
      }

      if (ackFrame.kind === "fatalError") {
        // A refusal from a process instance this host has since left marks
        // nothing, plans nothing and reports nothing: the call fails with it.
        // The memory and the door drop it themselves; `live` gates what this
        // client plans and what it writes to stores keyed by host id.
        const live = this.releasedHosts.isCurrent(instance);
        const releasedWay =
          live &&
          this.answersReleasedWay(
            authority,
            usesSessionGrant,
            ackFrame.details,
          );
        // Spent or not: only the recovery's branch decides whether it is reported.
        const signInRefused =
          live &&
          isReleasedHostTokenRefusal(ackFrame.details) &&
          this.signInAuthorities.has(authority);
        const probe = this.probeAuthorities.has(authority);
        const reason = readDoorReason(ackFrame.details.doorReason);
        const named = reason !== "absent";
        if (named)
          this.releasedHosts.refusedNamingReason(
            instance,
            reason === "owner_sign_in",
          );
        const ownerSignIn = this.ownerSignInAuthorities.has(authority);
        const ownerSignInRefused =
          live && ownerSignIn && reason === "token_expired";
        // The person's sign-in, refused bare: never the door's older-host
        // cover. The invitation it answered is spent, so the call fails with
        // it and the next one sends the placeholder.
        const invitedSignInRefusedBare =
          ownerSignIn && isReleasedHostTokenRefusal(ackFrame.details);
        if (live && ownerSignIn && named && reason !== "token_expired") {
          // As on the stream: neither describes this person, so neither
          // latches the probe.
          if (reason !== "not_provisioned" && reason !== "owner_sign_in")
            this.releasedHosts.declineProbe(
              authority.bearer.identity.userId,
              instance,
            );
          this.forgetHeldRefusalFor?.(authority);
        }
        const heldRefused =
          live &&
          reason === "token_expired" &&
          !probe &&
          !ownerSignIn &&
          !this.signInAuthorities.has(authority) &&
          (this.heldTokenRefusedFor?.(authority, token, instance) ?? false);
        // Reported once the sign-in, or its refresh, cannot answer it; never
        // for the probe, which carried no credential of the person's.
        if (
          !releasedWay &&
          !signInRefused &&
          !probe &&
          !ownerSignInRefused &&
          !invitedSignInRefusedBare &&
          !heldRefused
        )
          this.door?.refused(ackFrame.details, instance);
        if (
          live &&
          ackFrame.details.code === SESSION_GRANT_REQUIRED &&
          !usesSessionGrant
        ) {
          this.localOpenAuth?.noteSessionGrantRequired(selected.hostId);
        }
        if (live && !probe)
          this.localOpenAuth?.noteRefusal(
            selected.hostId,
            authority.bearer,
            ackFrame.details,
          );
        const error = hostFatalError(
          ackFrame,
          requestId,
          method,
          "beforeRequest",
        );
        this.refusedBy.set(error, instance);
        if (releasedWay) this.releasedRefusals.add(error);
        if (signInRefused) {
          this.signInRefusals.add(error);
          markReleasedSignInRefusal(error);
        }
        if (ownerSignInRefused) this.ownerSignInRefusals.add(error);
        if ((signInRefused || ownerSignInRefused) && sessionGrant === null)
          this.refusedSignIns.set(error, liveBearer);
        if (heldRefused) this.heldRefusals.add(error);
        if (
          usesSessionGrant &&
          this.localOpenAuth !== undefined &&
          !isLocalAdmissionFatal(ackFrame.details.code)
        ) {
          if (live)
            this.localOpenAuth.invalidateHost(
              selected.hostId,
              ackFrame.details,
            );
          this.reprobeErrors.add(error);
        }
        throw error;
      }
      if (ackFrame.kind !== "openAck") {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: `Unexpected host frame '${ackFrame.kind}' before openAck`,
          requestId,
          method,
          fatalDetails: null,
        });
      }

      if (
        this.localOpenAuth !== undefined &&
        this.localOpenAuth.revisionFor(selected.hostId) !== admissionRevision
      ) {
        throw new RetryableTransportError({
          code: "RPC_ERROR",
          message: "Local admission changed before the request was sent",
          requestId,
          method,
          replaySafetyFromKey: false,
          fatalDetails: null,
        });
      }
      if (
        !this.signInAuthorities.has(authority) &&
        !this.probeAuthorities.has(authority) &&
        !this.ownerSignInAuthorities.has(authority)
      )
        this.releasedHosts.hostTokenAdmitted(instance);
      const release = this.door?.admitted(instance);
      if (release !== undefined) session.whenEnded(release);
      if (usesSessionGrant)
        this.localOpenAuth?.noteAdmitted(selected.hostId, authority.bearer);
      const mergedClientManifest = mergeConnectionManifests(
        clientManifest.manifest,
        clientManifest.optionalManifest,
      );
      const mergedHostManifest = mergeConnectionManifests(
        ackFrame.manifest,
        ackFrame.optionalManifest,
      );
      // Publish what this host advertised so UI layers can gate an optional
      // (non-floor) affordance without calling the method to find out. Recorded
      // BEFORE the compatibility check: an incompatible pairing still tells us
      // truthfully which methods the host has, and the gate wants that fact
      // even when this particular call is about to fail.
      recordNegotiatedHostManifest(selected.hostId, mergedHostManifest);
      if (
        publish !== null &&
        ackFrame.capabilities?.includes(UNARY_CAPABILITY_PERSISTENT_SESSION) ===
          true
      ) {
        const sessionCompat = checkCompatibility(
          this.registry,
          clientManifest.manifest,
          ackFrame.manifest,
          "client",
        );
        if (!sessionCompat.ok) {
          const downgradeFailure = classifyDowngradeFailure(
            sessionCompat.details,
            method,
            mergedClientManifest[method],
            mergedHostManifest[method],
          );
          if (downgradeFailure !== null) {
            throw new HostRpcError({
              code: "DOWNGRADE_UNSUPPORTED",
              message: downgradeFailure,
              requestId,
              method,
              fatalDetails: null,
            });
          }
          session.send({ kind: "fatalError", details: sessionCompat.details });
          throw new HostRpcError({
            code: isRpcErrorCode(sessionCompat.details.code)
              ? sessionCompat.details.code
              : "RPC_ERROR",
            message: sessionCompat.details.reason,
            requestId,
            method,
            fatalDetails: sessionCompat.details,
          });
        }
        const recorded = session.recordedFailure();
        if (recorded !== null) {
          throw recorded;
        }
        if (session.isClosed()) {
          throw closedBeforeAdopt(requestId, method);
        }
        const local = this.adoptDiscoveredSession(
          session,
          sessionKey,
          selected.hostId,
          mergedClientManifest,
          mergedHostManifest,
          usesSessionGrant,
          ackFrame.capabilities?.includes(UNARY_CAPABILITY_IDEMPOTENCY_KEY) ===
            true,
        );
        if (local.isRetired) {
          const fatal = local.admissionFatalFrame;
          throw fatal === null
            ? closedBeforeAdopt(requestId, method)
            : hostFatalError(fatal, requestId, method, "beforeRequest");
        }
        this.sessionOwners.set(local, instance);
        publish.ready(local);
        published = true;
        adopted = true;
        authority.abortSignal.removeEventListener("abort", onAbort);
        // Publish is the boundary. A release during the dial is session
        // state before this call and before any waiter continuation. Both
        // are bound to it. A later claim of the published session returns
        // it. A discovery retry keeps this slot while a caller holds its
        // handoff, and only that caller reads the release. A dial hold does
        // not keep the slot. Waiters already admitted hold this dial, so a
        // settlement here cannot close the socket before they enter.
        if (this.sessions.consumeReleaseBeforeReady(sessionKey, local)) {
          local.retainDialRelease();
        }
        return this.callOnSession(local, sessionKey, instance, {
          requestId,
          method,
          params,
          responseTimeoutMs,
          options,
          boundToDialRelease: true,
        });
      }
      if (publish !== null) {
        publish.legacy();
        published = true;
      }
      // The caller's version floor, answered by THIS connection rather than by
      // whatever the registry above remembers. First check after the manifest
      // lands and before anything is written: the point of carrying the
      // requirement on the request is that no frame goes out to a host that
      // does not meet it.
      const requirement = options.requiredHostMethodVersion;
      if (
        requirement !== null &&
        !negotiatedVersionMeetsRequirement(
          mergedHostManifest[requirement.method],
          requirement,
        )
      ) {
        throw new HostMethodVersionUnsatisfiedError({
          requirement,
          negotiated: mergedHostManifest[requirement.method],
          requestId,
          method,
          hostId: selected.hostId,
        });
      }
      const clientCanonical = mergedClientManifest[method];
      const hostCanonical = mergedHostManifest[method];
      const wireIdempotencyKey =
        idempotencyKey !== null &&
        ackFrame.capabilities?.includes(UNARY_CAPABILITY_IDEMPOTENCY_KEY) ===
          true
          ? idempotencyKey
          : null;
      // A REPLAY may not go out unkeyed. Stripping is right on a first attempt
      // against a host that predates the capability - nothing was dispatched,
      // so an unkeyed send is a first send - but this connection is not the one
      // that earned the retry. That was granted because the PREVIOUS connection
      // negotiated a key and the host was therefore deduplicating it; a
      // reconnect onto an incarnation without the capability breaks the very
      // premise the retry rests on, and the earlier attempt may already have
      // committed.
      //
      // Non-retryable, and this attempt sent nothing, so it reads as not
      // reached. `classifyEpicWriteCommandFailure` still routes the class to
      // `unknown-outcome`. An earlier attempt's uncertainty is the retry
      // messenger's wrapper, which engages because these details are non-null.
      if (options.replayMustBeKeyed && wireIdempotencyKey === null) {
        throw transportFailureBeforeSend({
          message: `Host '${selected.hostId}' cannot honour the idempotency key a replay of '${method}' requires`,
          requestId,
          method,
        });
      }

      const compat = checkCompatibility(
        this.registry,
        clientManifest.manifest,
        ackFrame.manifest,
        "client",
      );
      if (!compat.ok) {
        const downgradeFailure = classifyDowngradeFailure(
          compat.details,
          method,
          clientCanonical,
          hostCanonical,
        );
        if (downgradeFailure !== null) {
          throw new HostRpcError({
            code: "DOWNGRADE_UNSUPPORTED",
            message: downgradeFailure,
            requestId,
            method,
            fatalDetails: null,
          });
        }
        session.send({ kind: "fatalError", details: compat.details });
        throw new HostRpcError({
          code: isRpcErrorCode(compat.details.code)
            ? compat.details.code
            : "RPC_ERROR",
          message: compat.details.reason,
          requestId,
          method,
          fatalDetails: compat.details,
        });
      }

      const methodRegistry = this.registry[method] as MethodVersionRegistry;
      if (hostCanonical === undefined) {
        return await executeUnavailableMethodDegrade(
          this.registry,
          session,
          method,
          methodRegistry,
          clientCanonical,
          mergedClientManifest,
          mergedHostManifest,
          params,
          requestId,
          responseTimeoutMs,
          selected.hostId,
          wireIdempotencyKey,
        );
      }

      return await executeAvailableMethodRequest<
        RequestOfMethod<Registry, Method>,
        ResponseOfMethod<Registry, Method>
      >(
        session,
        methodRegistry,
        method,
        clientCanonical,
        hostCanonical,
        params,
        requestId,
        responseTimeoutMs,
        selected.hostId,
        wireIdempotencyKey,
      );
    } catch (cause) {
      // The asynchronous membership/grant work precedes socket construction.
      // Preserve the unary API's typed, proven-pre-dispatch cancellation.
      if (socket === null && authority.abortSignal.aborted) {
        settleUnpublished(cause);
        throwIfAuthorityAborted(authority, requestId, method);
      }
      settleUnpublished(cause);
      throw cause;
    } finally {
      authority.abortSignal.removeEventListener("abort", onAbort);
      if (session !== null && !adopted) {
        session.close(1000, "ok");
      } else if (socket !== null && session === null) {
        socket.close(1000, "ok");
      }
    }
  }

  private adoptDiscoveredSession(
    socketSession: Session,
    sessionKey: string,
    hostId: string,
    clientManifest: ConnectionManifest,
    hostManifest: ConnectionManifest,
    usesSessionGrant: boolean,
    idempotency: boolean,
  ): LocalUnarySession<Registry> {
    const local = new LocalUnarySession<Registry>({
      key: sessionKey,
      registry: this.registry,
      hostId,
      directory: this.sessions,
    });
    const attached: AttachedPersistentSocket = {
      socket: {
        send: (frame) => {
          socketSession.send(frame);
        },
        close: (code, reason) => {
          socketSession.close(code, reason);
        },
      },
      clientManifest,
      hostManifest,
      idempotency,
      usesSessionGrant,
    };
    local.attach(attached);
    socketSession.adoptMultiplex(local.handlers);
    return local;
  }

  private buildManifest(): SplitConnectionManifest {
    // See the note in `remote-session.ts`: unary majors are all serveable by
    // a client, so only the stream manifest narrows.
    return splitConnectionManifest(
      this.registry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
  }
}

async function executeAvailableMethodRequest<Payload, Response>(
  session: Session,
  methodRegistry: MethodVersionRegistry,
  method: string,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  params: Payload,
  requestId: string,
  responseTimeoutMs: number,
  hostId: string,
  idempotencyKey: string | null,
): Promise<Response> {
  const preparedRequest = prepareRequestPayload<Payload>(
    methodRegistry,
    clientCanonical,
    hostCanonical,
    params,
    requestId,
    method,
  );

  session.send({
    kind: "request",
    requestId,
    method,
    schemaVersion: preparedRequest.onWireVersion,
    params: preparedRequest.onWirePayload,
    idempotencyKey,
  });

  // From here the request has been handed to the socket, so it may have
  // reached the host and run. A failure this side detects - a fatal after the
  // request, a malformed, mismatched or unreadable answer - is marked for
  // `mayHaveReachedHost`. The host's own error envelope is its answer and
  // stays unmarked.
  let responseFrame: HostResponseFrame;
  try {
    responseFrame = await receiveResponseFrame(
      session,
      responseTimeoutMs,
      requestId,
      method,
    );
  } catch (cause) {
    throw markedAfterSend(cause);
  }
  if (responseFrame.error !== null) {
    const answer = HostRpcError.fromWireEnvelope(
      responseFrame.error,
      requestId,
      method,
    );
    throw responseFrame.error.retryable === true
      ? answer
      : asHostAnswer(answer, responseFrame.error.code);
  }

  try {
    return decodeResponsePayloadWithContext<Response>(
      methodRegistry,
      clientCanonical,
      hostCanonical,
      responseFrame.result,
      requestId,
      method,
      preparedRequest.onWirePayload,
      hostId,
    );
  } catch (cause) {
    throw markedAfterSend(cause);
  }
}

/**
 * The frame answering this request, or the failure that ends the wait. The
 * host's error envelope is left on the frame for the caller to throw.
 */
async function receiveResponseFrame(
  session: Session,
  responseTimeoutMs: number,
  requestId: string,
  method: string,
): Promise<HostResponseFrame> {
  const responseFrame = await session.next(responseTimeoutMs);

  if (responseFrame.kind === "fatalError") {
    throw hostFatalError(responseFrame, requestId, method, "afterRequest");
  }
  if (responseFrame.kind !== "response") {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Unexpected host frame '${responseFrame.kind}' awaiting response`,
      requestId,
      method,
      fatalDetails: null,
    });
  }
  if (responseFrame.requestId !== requestId) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Response requestId '${responseFrame.requestId}' does not match request '${requestId}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }
  if (responseFrame.method !== method) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Response method '${responseFrame.method}' does not match request method '${method}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }
  return responseFrame;
}

/**
 * Marks a failure that ended a request after it was sent. A transport-class
 * failure is left as it is: it states its own ground, and the host's
 * no-dispatch attestation (a `RetryableTransportError` without a key) must
 * keep reading as unsent.
 */
function markedAfterSend(cause: unknown): unknown {
  if (
    cause instanceof HostRpcError &&
    !(cause instanceof HostTransportFailureError)
  ) {
    markMayHaveReachedHost(cause);
  }
  return cause;
}

async function executeUnavailableMethodDegrade<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
>(
  registry: Registry,
  session: Session,
  method: Method,
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion | undefined,
  clientManifest: ConnectionManifest,
  hostManifest: ConnectionManifest,
  params: RequestOfMethod<Registry, Method>,
  requestId: string,
  responseTimeoutMs: number,
  hostId: string,
  idempotencyKey: string | null,
): Promise<ResponseOfMethod<Registry, Method>> {
  // Degrade POLICY is shared with the remote mux transport (see
  // `unavailable-method-degrade.ts`); only the dispatch below is ws-specific.
  return (await resolveUnavailableMethodDegrade({
    registry,
    method,
    methodRegistry,
    clientCanonical,
    clientManifest,
    hostManifest,
    params,
    requestId,
    execute: (input) =>
      executeAvailableMethodRequest<unknown, unknown>(
        session,
        input.methodRegistry,
        input.method,
        input.clientCanonical,
        input.hostCanonical,
        input.params,
        requestId,
        responseTimeoutMs,
        hostId,
        idempotencyKey,
      ),
  })) as ResponseOfMethod<Registry, Method>;
}

interface PreparedRequest<Payload> {
  readonly onWireVersion: SchemaVersion;
  readonly onWirePayload: Payload;
}

/**
 * Applies the asymmetric per-method transform on the request leg. When the
 * client is the older side the caller's canonical payload travels unchanged;
 * when the client is the newer side we downgrade via `downgradeRequestAcrossMajors`
 * (cross-major) or Zod-strip on the older minor's request schema (same-major).
 */
export function prepareRequestPayload<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  params: Payload,
  requestId: string,
  method: string,
): PreparedRequest<Payload> {
  if (clientCanonical.major === hostCanonical.major) {
    if (clientCanonical.minor <= hostCanonical.minor) {
      return {
        onWireVersion: clientCanonical,
        onWirePayload: params,
      };
    }
    const olderLine = methodRegistry[hostCanonical.major];
    const olderEntry = olderLine.versions[hostCanonical.minor];
    if (olderEntry === undefined) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: `No installed contract for method '${method}' ${hostCanonical.major}.${hostCanonical.minor}`,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    const strippedParse = olderEntry.contract.requestSchema.safeParse(params);
    if (!strippedParse.success) {
      // Same-major counterpart to the cross-major no-bridge case below: the
      // caller's request genuinely doesn't fit the older peer's schema (a
      // newer-minor-only capability, not an additive field the peer would
      // just ignore). `DOWNGRADE_UNSUPPORTED` - not the generic `RPC_ERROR`
      // transport/network code - lets a caller distinguish "this host is too
      // old for what I just asked" from a real connectivity failure.
      throw new HostRpcError({
        code: "DOWNGRADE_UNSUPPORTED",
        message: `Failed to project request params onto ${hostCanonical.major}.${hostCanonical.minor}: ${strippedParse.error.message}`,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    return {
      onWireVersion: hostCanonical,
      onWirePayload: strippedParse.data as Payload,
    };
  }

  if (clientCanonical.major < hostCanonical.major) {
    return {
      onWireVersion: clientCanonical,
      onWirePayload: params,
    };
  }

  const downgraded = downgradeRequestAcrossMajors(
    methodRegistry,
    clientCanonical.major,
    hostCanonical.major,
    params as never,
  );
  if (!downgraded.ok) {
    throw new HostRpcError({
      code: "DOWNGRADE_UNSUPPORTED",
      message: downgraded.error.message,
      requestId,
      method,
      fatalDetails: null,
    });
  }
  return {
    onWireVersion: hostCanonical,
    onWirePayload: downgraded.value as Payload,
  };
}

/**
 * Response counterpart to `prepareRequestPayload`. When the client is the older
 * side the frame payload already matches the caller's canonical and passes
 * through; when the client is the newer side we upgrade along the installed
 * chain via `upgradeResponseToVersion`.
 */
export function decodeResponsePayload<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
): Payload {
  return decodeResponsePayloadInternal(
    methodRegistry,
    clientCanonical,
    hostCanonical,
    result,
    requestId,
    method,
    null,
  );
}

export function decodeResponsePayloadWithContext<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
  onWireRequest: unknown,
  hostId: string,
): Payload {
  return decodeResponsePayloadInternal(
    methodRegistry,
    clientCanonical,
    hostCanonical,
    result,
    requestId,
    method,
    { request: onWireRequest, hostId },
  );
}

function decodeResponsePayloadInternal<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
  context: { readonly request: unknown; readonly hostId: string } | null,
): Payload {
  if (clientCanonical.major === hostCanonical.major) {
    if (clientCanonical.minor <= hostCanonical.minor) {
      return result as Payload;
    }
    return upgradeResponseAlongChain<Payload>(
      methodRegistry,
      hostCanonical,
      clientCanonical,
      result,
      requestId,
      method,
      context,
    );
  }
  if (clientCanonical.major < hostCanonical.major) {
    return result as Payload;
  }
  return upgradeResponseAlongChain<Payload>(
    methodRegistry,
    hostCanonical,
    clientCanonical,
    result,
    requestId,
    method,
    context,
  );
}

function upgradeResponseAlongChain<Payload>(
  methodRegistry: MethodVersionRegistry,
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
  context: { readonly request: unknown; readonly hostId: string } | null,
): Payload {
  try {
    // The host is the older side here, so `result` is raw wire data framed at
    // `fromVersion` - the one place old-host payloads enter the client. Parse
    // it through that version's response schema before upgrading so the
    // line's `.catch(...)` tolerances (fields added mid-line that old host
    // builds omit, e.g. `providers.list@3.0`'s `profiles`) actually apply -
    // otherwise the upgraded payload can violate the caller's canonical type
    // and blow up deep in app code instead of at this boundary. A version
    // absent from the registry falls through untouched and surfaces the
    // chain's own not-installed error below.
    const fromEntry =
      methodRegistry[fromVersion.major]?.versions[fromVersion.minor];
    let chainInput = result;
    if (fromEntry !== undefined) {
      const parsed = fromEntry.contract.responseSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(
          `response does not match the ${fromVersion.major}.${fromVersion.minor} response schema`,
        );
      }
      chainInput = parsed.data;
    }
    const upgraded =
      context === null
        ? upgradeResponseToVersion(
            methodRegistry,
            fromVersion,
            toVersion,
            chainInput as never,
          )
        : upgradeResponseToVersionWithContext(
            methodRegistry,
            fromVersion,
            toVersion,
            chainInput as never,
            { request: context.request as never, hostId: context.hostId },
          );
    return upgraded as Payload;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Failed to upgrade response from ${fromVersion.major}.${fromVersion.minor} to ${toVersion.major}.${toVersion.minor}: ${message}`,
      requestId,
      method,
      fatalDetails: null,
    });
  }
}

/**
 * Detects the cross-major no-bridge case where the client is the newer side
 * for the method being called. Returning a non-null string signals the caller
 * to surface `DOWNGRADE_UNSUPPORTED` instead of the broader `INCOMPATIBLE`
 * fatal-error path. Other incompatibilities (missing methods, same-major
 * breaks, or cross-major where host is newer) continue to flow through the
 * fatal-error emission.
 */
function classifyDowngradeFailure(
  details: FatalErrorDetails,
  method: string,
  clientCanonical: SchemaVersion | undefined,
  hostCanonical: SchemaVersion | undefined,
): string | null {
  if (details.incompatibleMethods === null) {
    return null;
  }
  if (clientCanonical === undefined || hostCanonical === undefined) {
    return null;
  }
  if (clientCanonical.major <= hostCanonical.major) {
    return null;
  }
  const methodFailure = details.incompatibleMethods.find(
    (entry: IncompatibleMethodDetails) => entry.method === method,
  );
  if (methodFailure === undefined) {
    return null;
  }
  if (methodFailure.blocking !== "no-bridge") {
    return null;
  }
  return `No direct downgrade path exists from major ${clientCanonical.major} to major ${hostCanonical.major}`;
}

export function hostFatalError(
  frame: HostFatalErrorFrame,
  requestId: string,
  method: string,
  phase: "beforeRequest" | "afterRequest",
): HostRpcError {
  const details = frame.details;
  // Before the request, every host-marked transient is safe to retry. After the
  // local send, retry only the post-open timeout: that fatal is host attestation
  // that it remained `awaitingRequest` and never dispatched the call. The legacy
  // reason match lets new clients recover against hosts through 1.1.9, which
  // mislabeled the timeout as UNAUTHORIZED and omitted `retryable`.
  if (
    (phase === "beforeRequest" && details.retryable === true) ||
    isRpcRequestTimeout(details)
  ) {
    return new RetryableTransportError({
      code: "RPC_ERROR",
      // BOTH arms above are no-dispatch, which is why this is `false` and not
      // a judgement call: one is `phase === "beforeRequest"`, the other is the
      // host's own attestation that it stayed `awaitingRequest`. Neither owes
      // the next attempt a key.
      replaySafetyFromKey: false,
      message: details.reason,
      requestId,
      method,
      fatalDetails: details,
    });
  }
  return new HostRpcError({
    code: isRpcErrorCode(details.code) ? details.code : "RPC_ERROR",
    message: details.reason,
    requestId,
    method,
    fatalDetails: details,
  });
}

/**
 * True for the one host fatal that attests the request was never dispatched:
 * the host's post-`openAck` deadline expired while it was still in
 * `awaitingRequest`. Matched in the typed `RPC_REQUEST_TIMEOUT` spelling and in
 * the exact legacy `UNAUTHORIZED` form emitted by hosts through 1.1.9.
 */
function isPostOpenTimeoutAttestation(frame: HostFrame): boolean {
  return frame.kind === "fatalError" && isRpcRequestTimeout(frame.details);
}

/**
 * True for the frame that answers the caller's own request: the host ran this
 * exact call and reported its outcome, error envelope included.
 *
 * Correlated on `requestId` HERE rather than left to `decodeResponseFrame`,
 * even though one session carries one request. A response for another id
 * proves nothing about this one, and resolving on it would replace an honest
 * "outcome unknown" with a definite correlation failure - the opposite of what
 * a caller that has to reconcile needs.
 */
function isResponseToRequest(frame: HostFrame, requestId: string): boolean {
  return frame.kind === "response" && frame.requestId === requestId;
}

function isRpcRequestTimeout(details: FatalErrorDetails): boolean {
  if (details.code === RPC_REQUEST_TIMEOUT_FATAL_CODE) {
    return true;
  }
  return (
    details.code === "UNAUTHORIZED" &&
    LEGACY_RPC_REQUEST_TIMEOUT_REASON.test(details.reason)
  );
}

/**
 * The two legs a post-send response timeout waits through before the call is
 * declared ambiguously failed. Splitting the grace is what makes it
 * resume-safe: the leg that finally gives up is always armed *after* the
 * previous timer callback actually ran, so an overdue client timer can never
 * end the call in the same wake batch that is about to deliver the host's
 * equally overdue no-dispatch fatal.
 */
interface AttestationGrace {
  /**
   * Share of `hostAttestationWindowMs` this call has not yet spent. `0` when
   * the caller's own deadline already consumed the window.
   */
  readonly windowMs: number;
  /** Delivery tail, armed once `windowMs` elapses (immediately when it is 0). */
  readonly deliveryMs: number;
}

interface SessionOptions {
  readonly socket: WebSocketLike;
  readonly dialTimeoutMs: number;
  /** See `WsRpcClientOptions.hostAttestationWindowMs`. */
  readonly hostAttestationWindowMs: number;
  readonly requestId: string;
  readonly method: string;
  /** The host this socket is dialing, for the selection authority's evidence. */
  readonly hostId: string;
  readonly evidence: TransportEvidenceReporter;
  /** Per-host connectivity bookkeeping shared across this client's sockets. */
  readonly liveness: LocalHostLiveness;
  /** The host process instance this socket is dialed to. */
  readonly owner: HostInstance;
  /** Whether `owner` is still the host's: every inbound frame is read against it. */
  readonly isCurrent: (owner: HostInstance) => boolean;
}

/**
 * The local transport's connectivity, as the selection authority needs to see
 * it (redesign P1.3, Q3 ruling (c)).
 *
 * A one-request socket opens and closes per call. A persistent session holds
 * one socket for the host, so a naive per-request announcement would still
 * flicker the authority's inventory on the one-request path, and would
 * over-count the persistent path. That is not merely noisy - a live session
 * is the authority's
 * strongest evidence class and suppresses death accumulation entirely, so
 * announcing and retracting it thousands of times a day would make death
 * suppression a race against RPC timing, at exactly the moments evidence
 * matters most.
 *
 * So sessions here track CONNECTIVITY, not requests: the client refcounts the
 * host's open sockets, announcing one logical session on the 0 -> 1 edge and
 * retracting it on 1 -> 0. Between those edges an idle gap of a few
 * milliseconds between two RPCs no longer reads as the host dying and coming
 * back. Dial ATTEMPTS stay per-socket - they are genuine per-attempt evidence,
 * and each carries the call's own request id.
 */
/**
 * Monotonic source for local RPC session ids, PROCESS-scoped (module state)
 * rather than per client instance - the same shape `WsStreamClient` uses for
 * `local-stream:s<n>`. The evidence kernel it reports into is renderer-
 * lifetime and keys sessions by id: when the host runtime is rebuilt while an
 * old instance's socket is still open, a per-instance counter restarting at
 * zero made the replacement announce the SAME `local-ws:s1`, the authority
 * deduplicated the second establishment, and the old socket's eventual `lost`
 * deleted and tombstoned the shared id - retracting the replacement's live
 * evidence and letting later refusals deaden or fail over from a host that
 * still had a live socket.
 */
let localRpcSessionSeq = 0;

class LocalHostLiveness {
  private readonly evidence: TransportEvidenceReporter;
  private readonly openSocketsByHost = new Map<string, number>();
  private readonly announcedByHost = new Map<string, string>();

  constructor(evidence: TransportEvidenceReporter) {
    this.evidence = evidence;
  }

  socketOpened(hostId: string): void {
    const next = (this.openSocketsByHost.get(hostId) ?? 0) + 1;
    this.openSocketsByHost.set(hostId, next);
    if (next > 1) return;
    localRpcSessionSeq += 1;
    // Scoped to the process-wide counter rather than to the request id, so
    // the id names the CONNECTIVITY episode it belongs to (not whichever RPC
    // happened to open the first socket of it) and is unique across every
    // client instance that ever reports into this renderer's kernel.
    const sessionId = `local-ws:s${localRpcSessionSeq}`;
    this.announcedByHost.set(hostId, sessionId);
    this.evidence.sessionEstablished(hostId, sessionId, "local-ws");
  }

  socketClosed(hostId: string): void {
    const current = this.openSocketsByHost.get(hostId);
    if (current === undefined) return;
    const next = current - 1;
    if (next > 0) {
      this.openSocketsByHost.set(hostId, next);
      return;
    }
    this.openSocketsByHost.delete(hostId);
    const sessionId = this.announcedByHost.get(hostId);
    if (sessionId === undefined) return;
    this.announcedByHost.delete(hostId);
    this.evidence.sessionLost(hostId, sessionId, "local-ws");
  }
}

interface Session {
  dial(): Promise<void>;
  /**
   * Waits up to `timeoutMs` for the next host frame. The budget is per wait,
   * not per session: the handshake (`openAck`) wait passes the transport's
   * default frame timeout, while the response wait may pass a caller-extended
   * budget for long-poll methods.
   *
   * `timeoutMs` bounds neither end of this wait exactly: it is when the wait
   * stops expecting an answer, after which a post-send timeout keeps the
   * socket open for the remainder of the host's attestation window (see
   * `attestationGraceFor`). Two frames arriving in that window still settle
   * the call, because both are the host speaking to this request: its
   * no-dispatch fatal, which the caller maps to a retryable failure, and the
   * response to this exact `requestId`, which resolves the wait - so a
   * success can land after `timeoutMs` as well as a rejection. Every other
   * frame keeps the recorded ambiguous timeout.
   */
  next(timeoutMs: number): Promise<HostFrame>;
  send(frame: ClientFrame): void;
  abort(): void;
  close(code: number, reason: string): void;
  /**
   * After `openAck` has been consumed, hand later frames to `handlers`
   * instead of the single-request `next` wait. The socket stays open.
   */
  adoptMultiplex(handlers: PersistentSocketHandlers): void;
  /** True once `onclose` has run. Adoption must not publish that socket. */
  isClosed(): boolean;
  /** Runs `ended` once this socket is torn down, by any path; at once if it already is. */
  whenEnded(ended: () => void): void;
  /**
   * The one terminal failure recorded for this socket, if any. Adoption
   * throws it instead of publishing. The first failure wins.
   */
  recordedFailure(): HostRpcError | null;
}

/**
 * Wires the per-request socket lifetime into promise-shaped accessors. All
 * timer/handler bookkeeping lives here so `WsRpcClient.request` reads as a
 * straight phase script and so failures from any source (dial timeout, frame
 * timeout, `onerror`, premature `onclose`) collapse into the same rejection
 * channel.
 */
function openSession(options: SessionOptions): Session {
  const {
    socket,
    dialTimeoutMs,
    hostAttestationWindowMs,
    requestId,
    method,
    hostId,
    evidence,
    liveness,
    owner,
    isCurrent,
  } = options;

  let opened = false;
  let closed = false;
  /**
   * Set by `onerror` when it fires before the socket ever opened. Under Blink
   * a pre-open `error` event is followed by the awaiting caller's `finally`
   * closing this session (setting `closed = true`) in the microtask
   * checkpoint, and only THEN does `close` fire - so by the time `onclose`
   * reads `closed` for `selfInitiated`, it is true even though the caller's
   * teardown was itself downstream of a genuine refusal, not the cause of it.
   * Without this flag that refusal is reported as `indeterminate` and
   * silently dropped from death detection.
   */
  let erroredBeforeOpen = false;
  /**
   * Exactly-once bookkeeping for the two evidence duties this socket owes the
   * selection authority. `livenessEnded` guards the refcount decrement, which
   * must pair with its increment no matter which of the three teardown paths
   * runs (`onclose`, the caller's `close()`, an authority `abort()`) - a
   * missed decrement pins a phantom live session that suppresses every later
   * death verdict for this host.
   */
  let livenessStarted = false;
  let livenessEnded = false;
  const endedCallbacks: Array<() => void> = [];

  const endLiveness = (): void => {
    for (const ended of endedCallbacks.splice(0)) ended();
    if (!livenessStarted || livenessEnded) return;
    livenessEnded = true;
    liveness.socketClosed(hostId);
  };

  /**
   * One dial outcome per socket, whichever event decides it first. The
   * authority deduplicates by attempt id anyway, but reporting once keeps the
   * call sites honest about what an ATTEMPT is: `onerror` is normally followed
   * by `onclose`, and both describe the same failed dial. A socket to a host
   * process that is no longer the host's reports nothing: its outcome says
   * nothing about the process that now answers for the host.
   */
  let dialOutcomeReported = false;
  const reportDialOutcome = (
    outcome: "success" | "refusal" | "timeout" | "indeterminate",
  ): void => {
    if (dialOutcomeReported) return;
    dialOutcomeReported = true;
    if (!isCurrent(owner)) return;
    if (outcome === "success") {
      evidence.reportDialSuccess(hostId, requestId, "local-ws");
      return;
    }
    if (outcome === "timeout") {
      evidence.reportDialTimeout(hostId, requestId, "local-ws");
      return;
    }
    // An attempt we abandoned ourselves. Inert by contract - it advances no
    // counter - but still reported, because the attempt did happen and one
    // attempt owes exactly one outcome. Staying silent would keep death
    // detection honest too, yet it would lose the diagnostic and quietly
    // invent a third convention next to the remote path, which already
    // classifies its own teardowns this way.
    if (outcome === "indeterminate") {
      evidence.reportDialIndeterminate(hostId, requestId, "local-ws");
      return;
    }
    // A close before the socket ever opened IS host-plane evidence: the
    // connection was refused, or something answered and hung up before the
    // handshake.
    evidence.reportDialRefusal(hostId, requestId, "local-ws");
  };
  // Flipped the instant the `request` frame is handed to `send`. Before this
  // point every transient failure is provably pre-send (the host never saw the
  // call), so it surfaces as a `RetryableTransportError`; after it, the same
  // failure shapes stay a non-retryable `HostTransportFailureError` because a
  // retry could re-execute a non-idempotent method. A negotiated idempotency
  // key is the other safe case: the host replays the original result instead
  // of dispatching twice. Without that negotiated key only the host itself can
  // lift the ambiguity, by attesting it never dispatched the request - which
  // is what the attestation grace below waits for.
  let requestSent = false;
  let requestReplaySafe = false;
  let failure: HostRpcError | null = null;
  // Non-null only for the duration of the attestation grace: the ambiguous
  // post-send response timeout that will be raised unless, within the
  // remainder of the host's post-`openAck` window, the host either attests
  // that it never dispatched the request or answers it. While it is set it is
  // the session's decided outcome - see the sticky rule in `failAll`.
  let ambiguousResponseTimeout: HostRpcError | null = null;

  /**
   * Builds the failure for a transient transport/timeout event (dial timeout,
   * handshake `onerror`/`onclose`, `openAck` frame timeout). It is retryable
   * only while the request frame has not yet been sent; a malformed frame or a
   * host-originated error never routes through here.
   */
  const transientFailure = (message: string): HostRpcError =>
    requestSent && !requestReplaySafe
      ? new HostTransportFailureError({
          code: "RPC_ERROR",
          message,
          requestId,
          method,
          fatalDetails: null,
        })
      : new RetryableTransportError({
          code: "RPC_ERROR",
          message,
          requestId,
          method,
          fatalDetails: null,
          // The ground for the retry, read straight off the branch that
          // granted it: reaching here with `requestSent` means the key is the
          // only thing making a replay safe, so the next attempt has to carry
          // one. Pre-send needs no key - the host never saw the call.
          replaySafetyFromKey: requestSent,
        });

  /**
   * The grace granted at the moment a frame wait times out, or `null` when
   * there is nothing to wait for: the request frame was never sent (that
   * failure is already provably no-dispatch and retryable on its own), or this
   * caller opted out with a zero window.
   *
   * The response timer is armed immediately after `openAck` is consumed, so
   * `waitTimeoutMs` is the share of the window this wait has nominally consumed
   * - no clock reading needed. It is nominal rather than measured: if the
   * response timer itself ran late (suspend/resume), more wall-clock has really
   * elapsed than the window models. That is precisely when an attestation is
   * about to arrive, which is why the remainder is floored at the delivery
   * slack instead of collapsing to "no grace". The total stays bounded by
   * `hostAttestationWindowMs` either way.
   */
  const attestationGraceFor = (
    waitTimeoutMs: number,
  ): AttestationGrace | null => {
    if (!requestSent || hostAttestationWindowMs <= 0) {
      return null;
    }
    const deliveryMs = Math.min(
      ATTESTATION_DELIVERY_SLACK_MS,
      hostAttestationWindowMs,
    );
    const totalMs = Math.max(
      hostAttestationWindowMs - waitTimeoutMs,
      deliveryMs,
    );
    return { windowMs: totalMs - deliveryMs, deliveryMs };
  };

  const buffer: HostFrame[] = [];
  let multiplex: PersistentSocketHandlers | null = null;
  let multiplexNotified = false;
  let closeNotice: { message: string; selfInitiated: boolean } | null = null;
  const notifyMultiplex = (message: string, selfInitiated: boolean): void => {
    if (multiplex === null || multiplexNotified) {
      return;
    }
    multiplexNotified = true;
    multiplex.onTransportClosed(message, selfInitiated);
  };
  const closeMultiplexSocket = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    endLiveness();
    try {
      socket.close(1000, "malformed");
    } catch (cause) {
      void cause;
    }
  };
  interface PendingDial {
    readonly resolve: () => void;
    readonly reject: (error: HostRpcError) => void;
    /** Null until the handshake starts. */
    timer: TimerHandle | null;
  }
  let dialResolver: PendingDial | null = null;
  let frameResolver: {
    readonly resolve: (frame: HostFrame) => void;
    readonly reject: (error: HostRpcError) => void;
    readonly timer: TimerHandle;
  } | null = null;

  /**
   * Single terminal transition for the session. Every failing event routes
   * here, which is also where the post-deadline outcome is made sticky:
   * once `ambiguousResponseTimeout` is recorded, that error *is* the call's
   * answer, because the request may already have been dispatched and only the
   * host speaking to this request - its no-dispatch attestation, or the
   * response to this exact `requestId`, both of which resolve the wait rather
   * than failing it - can change that. A close, a transport error, a malformed
   * frame, a frame that answers nothing of this request's, and grace expiry are
   * all downstream of a fate already decided, so none of them may substitute
   * its own error and make the reported failure race-dependent. An authority
   * abort is the one caller-owned cancellation that still overrides.
   */
  const failAll = (error: HostRpcError): void => {
    const ambiguous = ambiguousResponseTimeout;
    const settled =
      ambiguous !== null && !(error instanceof HostRequestAbortedError)
        ? ambiguous
        : error;
    ambiguousResponseTimeout = null;
    if (failure === null) {
      failure = settled;
    }
    if (dialResolver !== null) {
      const resolver = dialResolver;
      dialResolver = null;
      if (resolver.timer !== null) {
        clearTimeout(resolver.timer);
      }
      resolver.reject(settled);
    }
    if (frameResolver !== null) {
      const resolver = frameResolver;
      frameResolver = null;
      clearTimeout(resolver.timer);
      resolver.reject(settled);
    }
  };

  /**
   * Ends a wait that is already inside its attestation grace. The sticky rule
   * in `failAll` supplies the recorded timeout; this exists so the callers that
   * merely observe "the grace produced nothing usable" don't have to invent an
   * error the caller will never see.
   */
  const failWithAmbiguousTimeout = (): void => {
    const ambiguous = ambiguousResponseTimeout;
    if (ambiguous === null) {
      return;
    }
    failAll(ambiguous);
  };

  /**
   * Re-arms the pending response wait for one leg of the grace, keeping the
   * caller's resolvers attached so an attestation arriving in any leg still
   * settles the original `next()` promise. The window leg hands over to the
   * delivery leg instead of ending the call - see `ATTESTATION_DELIVERY_SLACK_MS`
   * for why the last word must belong to a freshly armed timer.
   */
  const armAttestationLeg = (grace: AttestationGrace): void => {
    const resolver = frameResolver;
    if (resolver === null) {
      return;
    }
    const armedAt = Date.now();
    frameResolver = {
      resolve: resolver.resolve,
      reject: resolver.reject,
      timer:
        grace.windowMs > 0
          ? setTimeout(() => {
              armAttestationLeg({ windowMs: 0, deliveryMs: grace.deliveryMs });
            }, grace.windowMs)
          : setTimeout(() => {
              settleDeliveryLeg(armedAt, grace);
            }, grace.deliveryMs),
    };
  };

  /**
   * The one place the attestation grace is allowed to end the call, and the
   * reason it is not simply `failWithAmbiguousTimeout`.
   *
   * Handing the window leg over to a freshly armed delivery leg only moves the
   * resume hazard: if the machine suspends *inside* that delivery leg, its
   * callback is overdue on wake too and would again beat the host's equally
   * overdue no-dispatch fatal. So the last leg reads the wall clock. Firing on
   * time means this process really was running for the whole leg and nothing
   * arrived - the honest end of the grace. Firing far late means the leg
   * measured a scheduling gap rather than host silence, so it is re-armed to
   * become the running delivery opportunity it was meant to be.
   *
   * There is deliberately no cap on how often that can happen. A cap would
   * write a count of sleeps into the transport contract, and the call would
   * eventually fail for the single reason this whole mechanism exists to rule
   * out: the client's timer callback won the wake. What bounds the grace is
   * *active* time - the first delivery leg that actually gets its full duration
   * of running time ends the call - not wall-clock time or how many scheduling
   * gaps preceded it. Time in which neither process could make progress is not
   * evidence about dispatch.
   */
  const settleDeliveryLeg = (
    armedAt: number,
    grace: AttestationGrace,
  ): void => {
    const overshootMs = Date.now() - armedAt - grace.deliveryMs;
    if (overshootMs > SUSPENSION_OVERSHOOT_TOLERANCE_MS) {
      armAttestationLeg({ windowMs: 0, deliveryMs: grace.deliveryMs });
      return;
    }
    failWithAmbiguousTimeout();
  };

  socket.onopen = () => {
    opened = true;
    if (!isCurrent(owner)) {
      // Opened to a host process that is no longer the host's: dropped as a
      // socket lost before the request, announcing no live session.
      const lost = transientFailure(
        `WebSocket closed before next frame (code=1000, reason='ok')`,
      );
      lostToReplacedProcess.add(lost);
      failAll(lost);
      return;
    }
    livenessStarted = true;
    // Success first, then the announcement: the success clears this host's
    // death streak, and the live session then makes later failures inert until
    // it is retracted.
    reportDialOutcome("success");
    liveness.socketOpened(hostId);
    if (dialResolver !== null) {
      const resolver = dialResolver;
      dialResolver = null;
      if (resolver.timer !== null) {
        clearTimeout(resolver.timer);
      }
      resolver.resolve();
    }
  };

  socket.onmessage = (event: WebSocketMessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch (cause) {
      void cause;
      const malformed = new HostRpcError({
        code: "RPC_ERROR",
        message: `Malformed host frame: ${truncate(event.data)}`,
        requestId,
        method,
        fatalDetails: null,
      });
      if (multiplex !== null) {
        notifyMultiplex(malformed.message, false);
        closeMultiplexSocket();
        return;
      }
      failAll(malformed);
      return;
    }
    const frameParse = hostFrameSchema.safeParse(parsed);
    if (!frameParse.success) {
      const malformed = new HostRpcError({
        code: "RPC_ERROR",
        message: `Malformed host frame: ${truncate(event.data)}`,
        requestId,
        method,
        fatalDetails: null,
      });
      if (multiplex !== null) {
        notifyMultiplex(malformed.message, false);
        closeMultiplexSocket();
        return;
      }
      failAll(malformed);
      return;
    }
    const frame = frameParse.data;
    // The one entry for every frame of this socket. A frame from a host
    // process that is no longer the host's is never handed on as an answer:
    // nothing that host refused, admitted or advertised reaches any caller.
    // Only a call's own answer that it ran there passes once its request was
    // written. Any other frame is the socket's loss, failed as a close before
    // the next frame is: a written request is as uncertain as that leaves it,
    // and only an unwritten one dials again.
    if (!isCurrent(owner)) {
      if (multiplex !== null) {
        multiplex.onReplacedProcessFrame(frame);
        return;
      }
      if (!(requestSent && answersWrittenRequest(frame, requestId))) {
        const lost = transientFailure(
          `WebSocket closed before next frame (code=1000, reason='ok')`,
        );
        if (!requestSent) lostToReplacedProcess.add(lost);
        failAll(lost);
        return;
      }
    }
    if (multiplex !== null) {
      multiplex.onFrame(frame);
      return;
    }
    if (frameResolver !== null) {
      // Once the caller's response deadline has elapsed, the call's fate is
      // decided unless the HOST itself speaks to this request. Exactly two
      // frames do, and both are handed to the caller:
      //   - its no-dispatch attestation, which lifts the ambiguity by proving
      //     nothing ran; the caller maps it to a `RetryableTransportError`;
      //   - this request's OWN response, which is the definitive answer. The
      //     host ran the call and said what happened, so failing the wait over
      //     it would report a transport failure the host has just contradicted
      //     - an `agent.sendMessage` whose message was delivered exited
      //     `E_HOST_UNREACHABLE` while its own success frame sat on this
      //     socket, and its callers resent the message.
      // Anything else keeps the recorded response-timeout failure: a close, a
      // malformed frame, an unrelated fatal, and a response correlated to some
      // other request, none of which says what became of this one.
      if (
        ambiguousResponseTimeout !== null &&
        !isPostOpenTimeoutAttestation(frame) &&
        !isResponseToRequest(frame, requestId)
      ) {
        failWithAmbiguousTimeout();
        return;
      }
      const resolver = frameResolver;
      frameResolver = null;
      ambiguousResponseTimeout = null;
      clearTimeout(resolver.timer);
      resolver.resolve(frame);
      return;
    }
    // openAck already resolved and adoption has not installed handlers.
    // A host fatal here is this discovery's outcome. Buffering it would
    // let adoption publish the socket and drop the error.
    if (frame.kind === "fatalError") {
      failAll(hostFatalError(frame, requestId, method, "beforeRequest"));
      return;
    }
    buffer.push(frame);
  };

  socket.onerror = (event: WebSocketErrorEvent) => {
    if (!opened) {
      erroredBeforeOpen = true;
    }
    if (multiplex !== null) {
      notifyMultiplex(`WebSocket transport error: ${event.message}`, false);
      return;
    }
    failAll(transientFailure(`WebSocket transport error: ${event.message}`));
  };

  socket.onclose = (event: WebSocketCloseEvent) => {
    // `closed` is the ONLY thing that distinguishes a close we initiated -
    // `abort()` and `close()` both set it before calling `socket.close()` -
    // from one the host delivered. It has to be read BEFORE the assignment
    // below overwrites it; that assignment used to be the first statement
    // here, which destroyed the discriminator one line above the code that
    // needs it. Reporting our own teardown as a refusal is not a cosmetic
    // mislabel: refusals feed the selection authority's death detection, and
    // a HEALTHY host was measured accumulating three suppressed refusals -
    // exactly the death threshold - so there is no headroom for manufactured
    // ones.
    //
    // This is the same defect the remote path already fixed and wrote down
    // ("a client's own teardown request is self-evidence", `remote-session.ts`),
    // where it let three app-driven reconnects reach the confirmed-death
    // streak on a host that never stopped answering. The local leg never got
    // the treatment; the classification below is deliberately the same one.
    //
    // `failAll` stays unconditional: the first failure wins and the resolvers
    // are already settled, so it is a no-op on the paths that reach here
    // having already failed, and this fix does not quietly change which error
    // a caller sees.
    const selfInitiated = closed;
    closed = true;
    endLiveness();
    if (multiplex !== null) {
      notifyMultiplex(
        `WebSocket closed (code=${event.code}, reason='${event.reason}')`,
        selfInitiated,
      );
      return;
    }
    if (!opened) {
      // `erroredBeforeOpen` overrides `selfInitiated`: an `error` event ahead
      // of `close` is itself the refusal, and the caller's `finally`-driven
      // `close()` that intervenes before this handler runs is a downstream
      // reaction to it, not an independent teardown - see the flag's comment
      // above the declaration.
      reportDialOutcome(
        erroredBeforeOpen || !selfInitiated ? "refusal" : "indeterminate",
      );
      failAll(
        transientFailure(
          `WebSocket closed before open (code=${event.code}, reason='${event.reason}')`,
        ),
      );
      return;
    }
    if (frameResolver !== null) {
      failAll(
        transientFailure(
          `WebSocket closed before next frame (code=${event.code}, reason='${event.reason}')`,
        ),
      );
      return;
    }
    const message = `WebSocket closed (code=${event.code}, reason='${event.reason}')`;
    // The ack was already delivered and adoption has not installed handlers.
    // Record the close as the terminal outcome (the first failure still
    // wins) and keep the notice so a later adopt cannot publish a socket
    // whose `send` would discard every later request.
    closeNotice = { message, selfInitiated };
    failAll(transientFailure(message));
  };

  return {
    dial(): Promise<void> {
      if (failure !== null) {
        return Promise.reject(failure);
      }
      if (opened) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const pending: PendingDial = { resolve, reject, timer: null };
        dialResolver = pending;
        // Time queued for a dial slot says nothing about the host.
        whenDialStarted(socket, () => {
          if (dialResolver !== pending) {
            return;
          }
          pending.timer = setTimeout(() => {
            reportDialOutcome("timeout");
            failAll(
              transientFailure(
                `WebSocket dial timed out after ${dialTimeoutMs}ms`,
              ),
            );
          }, dialTimeoutMs);
        });
      });
    },

    next(timeoutMs: number): Promise<HostFrame> {
      if (failure !== null) {
        return Promise.reject(failure);
      }
      const buffered = buffer.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }
      return new Promise<HostFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const ambiguous = transientFailure(
            `WebSocket frame timed out after ${timeoutMs}ms`,
          );
          const grace = attestationGraceFor(timeoutMs);
          if (grace === null || frameResolver === null) {
            failAll(ambiguous);
            return;
          }
          // The caller's deadline is up, but the host's post-`openAck` deadline
          // may not be - and if this callback itself ran late, neither peer's
          // timeline is where the numbers say it is. Closing here would discard
          // the one frame that can tell us whether the request was ever
          // dispatched, so hold the socket for the rest of the window plus its
          // delivery tail instead. Nothing is decided here: the wait still fails
          // with this same ambiguous, non-retryable timeout unless the host's
          // no-dispatch fatal or this request's own response lands first.
          ambiguousResponseTimeout = ambiguous;
          armAttestationLeg(grace);
        }, timeoutMs);
        frameResolver = { resolve, reject, timer };
      });
    },

    send(frame: ClientFrame): void {
      // Past this point a transient failure is safe to auto-retry only when
      // this exact connection negotiated a non-null idempotency key. A key an
      // older host stripped or never advertised never reaches this branch.
      if (frame.kind === "request") {
        requestSent = true;
        requestReplaySafe = typeof frame.idempotencyKey === "string";
      }
      socket.send(JSON.stringify(frame));
    },

    abort(): void {
      failAll(
        new HostRequestAbortedError({
          message:
            "Host request authority was aborted while the WebSocket was open",
          requestId,
          method,
          mayHaveDispatched: requestSent,
        }),
      );
      if (closed) {
        return;
      }
      closed = true;
      // Not left to `onclose`: a socket torn down this way may never deliver
      // one, and the refcount must fall for every socket that raised it.
      endLiveness();
      try {
        socket.close(1000, "authority-aborted");
      } catch (cause) {
        void cause;
      }
    },

    close(code: number, reason: string): void {
      if (closed) {
        return;
      }
      closed = true;
      endLiveness();
      try {
        socket.close(code, reason);
      } catch (cause) {
        void cause;
      }
    },

    adoptMultiplex(handlers: PersistentSocketHandlers): void {
      multiplex = handlers;
      const pending = buffer.splice(0, buffer.length);
      for (const frame of pending) {
        handlers.onFrame(frame);
      }
      if (closeNotice !== null) {
        notifyMultiplex(closeNotice.message, closeNotice.selfInitiated);
      }
    },

    isClosed(): boolean {
      return closed;
    },

    whenEnded(ended: () => void): void {
      if (closed) ended();
      else endedCallbacks.push(ended);
    },

    recordedFailure(): HostRpcError | null {
      return failure;
    },
  };
}

/**
 * The host rejected this discovery's own open-frame credential. That refusal
 * is not a property of the connection: another call on the same account can
 * hold a different lease and has to dial for itself. The `doorReason` says
 * which refusals those are; a host-wide one (`enrolment_broken`,
 * `host_claimed`, `clock_skew`) refuses every caller alike.
 */
function isCallerSpecificAuthRefusal(cause: unknown): cause is HostRpcError {
  return (
    cause instanceof HostRpcError &&
    !(cause instanceof RetryableTransportError) &&
    cause.fatalDetails !== null &&
    cause.fatalDetails.retryable !== true &&
    isCredentialRefusal(cause.fatalDetails)
  );
}

/**
 * A connection-wide discovery failure, restated for the waiter that is about
 * to throw it. The owner already throws the original. Each waiter gets its
 * own object, carrying its own request id and method.
 */
function readdressDiscoveryFailure(
  error: HostRpcError,
  requestId: string,
  method: string,
): HostRpcError {
  if (error instanceof RetryableTransportError) {
    return new RetryableTransportError({
      code: error.code,
      message: error.message,
      requestId,
      method,
      fatalDetails: error.fatalDetails,
      replaySafetyFromKey: error.replaySafetyFromKey,
    });
  }
  if (error instanceof HostTransportFailureError) {
    return new HostTransportFailureError({
      code: error.code,
      message: error.message,
      requestId,
      method,
      fatalDetails: error.fatalDetails,
    });
  }
  return new HostRpcError({
    code: error.code,
    message: error.message,
    requestId,
    method,
    fatalDetails: error.fatalDetails,
  });
}

function closedBeforeAdopt(
  requestId: string,
  method: string,
): RetryableTransportError {
  return new RetryableTransportError({
    code: "RPC_ERROR",
    message: "WebSocket closed before the persistent session was adopted",
    requestId,
    method,
    fatalDetails: null,
    replaySafetyFromKey: false,
  });
}

function truncate(raw: string): string {
  const limit = 120;
  if (raw.length <= limit) {
    return raw;
  }
  return `${raw.slice(0, limit)}...`;
}

/**
 * Thrown when a client-side host transport is asked to open a WebSocket
 * before the auth boundary has provided a usable bearer.
 */
export class MissingBearerTokenForOpenFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingBearerTokenForOpenFrameError";
  }
}

/**
 * Final-boundary bearer extraction for host WS open frames.
 *
 * The transport layer is the ONLY client-side host layer permitted to read a
 * bearer from the `OpenFrameBearerSource` (`source.getBearerToken()`); every
 * consumer above threads the source itself. A `null` source, released / aborted
 * lease, or empty bearer is a caller-side lifecycle violation: the transport
 * must fail before dialing instead of sending `open { token: "" }`.
 */
export function extractBearerForOpenFrame(
  source: OpenFrameBearerSource | null,
): string {
  if (source === null) {
    throw new MissingBearerTokenForOpenFrameError(
      "Cannot open host WebSocket without an authenticated bearer source",
    );
  }
  let token: string;
  try {
    token = source.getBearerToken();
  } catch (cause) {
    if (cause instanceof CredentialLeaseReleasedError) {
      throw new MissingBearerTokenForOpenFrameError(
        `Cannot open host WebSocket: ${cause.message}`,
      );
    }
    throw cause;
  }
  if (token.length === 0) {
    throw new MissingBearerTokenForOpenFrameError(
      "Cannot open host WebSocket with an empty bearer token",
    );
  }
  return token;
}

export function extractBearerOrThrowRpcError(
  source: OpenFrameBearerSource,
  requestId: string,
  method: string,
): string {
  try {
    return extractBearerForOpenFrame(source);
  } catch (cause) {
    if (cause instanceof MissingBearerTokenForOpenFrameError) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: cause.message,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    throw cause;
  }
}

function waitForSessionAdmission<T>(
  settled: Promise<T>,
  authority: HostRequestAuthority,
  requestId: string,
  method: string,
): Promise<T> {
  throwIfAuthorityAborted(authority, requestId, method);
  const signal = authority.abortSignal;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) {
        return;
      }
      done = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(
          new HostRequestAbortedError({
            message:
              "Host request authority was aborted before the WebSocket dial",
            requestId,
            method,
            mayHaveDispatched: false,
          }),
        );
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    settled.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error);
        });
      },
    );
  });
}

/** The host's answer to the written request `requestId` that says the call ran there. */
function answersWrittenRequest(frame: HostFrame, requestId: string): boolean {
  return (
    frame.kind === "response" &&
    frame.requestId === requestId &&
    answersAsRun(frame)
  );
}

function prepareDiscoveryOpen(
  authority: HostRequestAuthority,
  requestId: string,
  method: string,
  settleUnpublished: (cause: unknown) => void,
): { readonly websocketUrl: string } {
  try {
    throwIfAuthorityAborted(authority, requestId, method);
    const websocketUrl = authority.endpoint.websocketUrl;
    if (websocketUrl === null) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: `Host '${authority.endpoint.hostId}' does not expose a WebSocket endpoint`,
        requestId,
        method,
        fatalDetails: null,
      });
    }
    extractBearerOrThrowRpcError(authority.bearer, requestId, method);
    return { websocketUrl };
  } catch (cause) {
    settleUnpublished(cause);
    throw cause;
  }
}

function throwIfAuthorityAborted(
  authority: HostRequestAuthority,
  requestId: string,
  method: string,
): void {
  if (!authority.abortSignal.aborted) {
    return;
  }
  throw new HostRequestAbortedError({
    message: "Host request authority was aborted before the WebSocket dial",
    requestId,
    method,
    mayHaveDispatched: false,
  });
}

const ABORTED_WAIT: unique symbol = Symbol("aborted-wait");

/** `pending`, or `null` as soon as `signal` aborts; `pending` itself is never cancelled. */
async function untilAborted<T>(
  pending: Promise<T | null>,
  signal: AbortSignal,
): Promise<T | null> {
  if (signal.aborted) return null;
  let onAbort = (): void => undefined;
  const aborted = new Promise<typeof ABORTED_WAIT>((resolve) => {
    onAbort = () => resolve(ABORTED_WAIT);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const settled = await Promise.race([pending, aborted]);
    return settled === ABORTED_WAIT ? null : settled;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function noHostTokenError(requestId: string, method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message: "No host-only token is held for this host",
    requestId,
    method,
    fatalDetails: null,
  });
}
