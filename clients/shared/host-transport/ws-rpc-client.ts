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
  splitConnectionManifest,
  upgradeResponseToVersion,
  upgradeResponseToVersionWithContext,
} from "@traycer/protocol/framework/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostTransportEndpoint,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
} from "./ws-factory";
import {
  checkCompatibility,
  hostFrameSchema,
  toClientHandshakeIdentity,
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
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
}

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
 *     and once it has been recorded every other non-abort terminal event
 *     reports it rather than its own error.
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
 * `WsRpcClient` deliberately holds no socket state across requests. Every call
 * to `request()` creates a fresh `WebSocketLike` through `webSocketFactory`
 * and discards it on completion - so cross-request leaks are impossible by
 * construction.
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

  constructor(options: WsRpcClientOptions<Registry>) {
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

  async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.requestWithResponseTimeout(
      method,
      params,
      this.frameTimeoutMs,
      authority,
    );
  }

  async requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
    authority: HostRequestAuthority,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const requestId = this.requestIdProvider();
    const selected = authority.endpoint;

    throwIfAuthorityAborted(authority, requestId, method);

    if (selected.websocketUrl === null) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: `Host '${selected.hostId}' does not expose a WebSocket endpoint`,
        requestId,
        method,
        fatalDetails: null,
      });
    }

    const clientManifest = this.buildManifest();
    const token = extractBearerOrThrowRpcError(
      authority.bearer,
      requestId,
      method,
    );

    const session = openSession({
      socket: this.webSocketFactory.create(selected.websocketUrl),
      dialTimeoutMs: this.dialTimeoutMs,
      hostAttestationWindowMs: this.hostAttestationWindowMs,
      requestId,
      method,
      hostId: selected.hostId,
      evidence: this.evidence,
      liveness: this.liveness,
    });
    const onAbort = (): void => {
      session.abort();
    };
    authority.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (authority.abortSignal.aborted) {
      onAbort();
    }

    try {
      await session.dial();

      session.send({
        kind: "open",
        token,
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
        clientIdentity: this.clientIdentity,
      });

      // Handshake stays on the transport default even when the caller
      // extended the response wait - a host that can't complete `openAck`
      // quickly is unreachable, and long-poll patience must not mask that.
      const ackFrame = await session.next(this.frameTimeoutMs);

      if (ackFrame.kind === "fatalError") {
        throw hostFatalError(ackFrame, requestId, method, "beforeRequest");
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
      const clientCanonical = mergedClientManifest[method];
      const hostCanonical = mergedHostManifest[method];

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
      );
    } finally {
      authority.abortSignal.removeEventListener("abort", onAbort);
      session.close(1000, "ok");
    }
  }

  private buildManifest(): SplitConnectionManifest {
    return splitConnectionManifest(this.registry, RELEASED_FLOOR_METHOD_NAMES);
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
  });

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

  const decodedResult = decodeResponseFrame(responseFrame, requestId, method);

  return decodeResponsePayloadWithContext<Response>(
    methodRegistry,
    clientCanonical,
    hostCanonical,
    decodedResult,
    requestId,
    method,
    preparedRequest.onWirePayload,
    hostId,
  );
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

function hostFatalError(
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

function isRpcRequestTimeout(details: FatalErrorDetails): boolean {
  if (details.code === RPC_REQUEST_TIMEOUT_FATAL_CODE) {
    return true;
  }
  return (
    details.code === "UNAUTHORIZED" &&
    LEGACY_RPC_REQUEST_TIMEOUT_REASON.test(details.reason)
  );
}

function decodeResponseFrame(
  frame: HostResponseFrame,
  requestId: string,
  method: string,
): unknown {
  if (frame.requestId !== requestId) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Response requestId '${frame.requestId}' does not match request '${requestId}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  if (frame.method !== method) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Response method '${frame.method}' does not match request method '${method}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  if (frame.error !== null) {
    throw new HostRpcError({
      code: isRpcErrorCode(frame.error.code) ? frame.error.code : "RPC_ERROR",
      message: frame.error.message,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  return frame.result;
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
}

/**
 * The local transport's connectivity, as the selection authority needs to see
 * it (redesign P1.3, Q3 ruling (c)).
 *
 * This transport opens a FRESH socket per RPC, so a naive per-socket
 * announcement would make the authority's session inventory flicker once per
 * request. That is not merely noisy - a live session is the authority's
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
   * `timeoutMs` bounds when this wait can *succeed*, not always when it
   * rejects: a post-send timeout keeps the socket open for the remainder of the
   * host's attestation window (see `attestationGraceFor`). A frame that arrives
   * in that window can no longer complete the call - only the host's
   * no-dispatch fatal is surfaced, and every other frame keeps the timeout.
   */
  next(timeoutMs: number): Promise<HostFrame>;
  send(frame: ClientFrame): void;
  abort(): void;
  close(code: number, reason: string): void;
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

  const endLiveness = (): void => {
    if (!livenessStarted || livenessEnded) return;
    livenessEnded = true;
    liveness.socketClosed(hostId);
  };

  /**
   * One dial outcome per socket, whichever event decides it first. The
   * authority deduplicates by attempt id anyway, but reporting once keeps the
   * call sites honest about what an ATTEMPT is: `onerror` is normally followed
   * by `onclose`, and both describe the same failed dial.
   */
  let dialOutcomeReported = false;
  const reportDialOutcome = (
    outcome: "success" | "refusal" | "timeout" | "indeterminate",
  ): void => {
    if (dialOutcomeReported) return;
    dialOutcomeReported = true;
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
    // handshake. `refusalDetail` is null - `plan-restricted` is a remote
    // entitlement verdict with a single provenance and cannot arise here.
    evidence.reportDialRefusal(hostId, requestId, "local-ws", null);
  };
  // Flipped the instant the `request` frame is handed to `send`. Before this
  // point every transient failure is provably pre-send (the host never saw the
  // call), so it surfaces as a `RetryableTransportError`; after it, the same
  // failure shapes stay a non-retryable `HostTransportFailureError` because a
  // retry could re-execute a non-idempotent method. Only the host itself can
  // lift that ambiguity, by attesting it never dispatched the request - which
  // is what the attestation grace below waits for.
  let requestSent = false;
  let failure: HostRpcError | null = null;
  // Non-null only for the duration of the attestation grace: the ambiguous
  // post-send response timeout that will be raised unless the host attests,
  // within the remainder of its post-`openAck` window, that it never dispatched
  // the request. While it is set it is the session's decided outcome - see the
  // sticky rule in `failAll`.
  let ambiguousResponseTimeout: HostRpcError | null = null;

  /**
   * Builds the failure for a transient transport/timeout event (dial timeout,
   * handshake `onerror`/`onclose`, `openAck` frame timeout). It is retryable
   * only while the request frame has not yet been sent; a malformed frame or a
   * host-originated error never routes through here.
   */
  const transientFailure = (message: string): HostRpcError =>
    requestSent
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
  let dialResolver: {
    readonly resolve: () => void;
    readonly reject: (error: HostRpcError) => void;
    readonly timer: TimerHandle;
  } | null = null;
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
   * host's no-dispatch attestation - which resolves the wait rather than
   * failing it - can change that. A close, a transport error, a malformed
   * frame, a late/unrelated frame, and grace expiry are all downstream of a
   * fate already decided, so none of them may substitute its own error and make
   * the reported failure race-dependent. An authority abort is the one
   * caller-owned cancellation that still overrides.
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
      clearTimeout(resolver.timer);
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
    livenessStarted = true;
    // Success first, then the announcement: the success clears this host's
    // death streak, and the live session then makes later failures inert until
    // it is retracted.
    reportDialOutcome("success");
    liveness.socketOpened(hostId);
    if (dialResolver !== null) {
      const resolver = dialResolver;
      dialResolver = null;
      clearTimeout(resolver.timer);
      resolver.resolve();
    }
  };

  socket.onmessage = (event: WebSocketMessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch (cause) {
      void cause;
      failAll(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Malformed host frame: ${truncate(event.data)}`,
          requestId,
          method,
          fatalDetails: null,
        }),
      );
      return;
    }
    const frameParse = hostFrameSchema.safeParse(parsed);
    if (!frameParse.success) {
      failAll(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Malformed host frame: ${truncate(event.data)}`,
          requestId,
          method,
          fatalDetails: null,
        }),
      );
      return;
    }
    const frame = frameParse.data;
    if (frameResolver !== null) {
      // Once the caller's response deadline has elapsed no frame can still
      // satisfy this call. Only the host's no-dispatch attestation changes the
      // outcome - it is handed to the caller, which maps it to a
      // `RetryableTransportError`. Anything else, including a `response` that
      // merely arrived late, keeps the recorded response-timeout failure.
      if (
        ambiguousResponseTimeout !== null &&
        !isPostOpenTimeoutAttestation(frame)
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
    buffer.push(frame);
  };

  socket.onerror = (event: WebSocketErrorEvent) => {
    if (!opened) {
      erroredBeforeOpen = true;
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
    }
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
        const timer = setTimeout(() => {
          reportDialOutcome("timeout");
          failAll(
            transientFailure(
              `WebSocket dial timed out after ${dialTimeoutMs}ms`,
            ),
          );
        }, dialTimeoutMs);
        dialResolver = { resolve, reject, timer };
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
          // no-dispatch fatal lands first.
          ambiguousResponseTimeout = ambiguous;
          armAttestationLeg(grace);
        }, timeoutMs);
        frameResolver = { resolve, reject, timer };
      });
    },

    send(frame: ClientFrame): void {
      // Past this point a transient failure is no longer safe to auto-retry for
      // non-idempotent methods - the host may have already begun applying it.
      if (frame.kind === "request") {
        requestSent = true;
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
  };
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
      `Cannot open host WebSocket with an empty bearer token for user '${source.identity.userId}'`,
    );
  }
  return token;
}

function extractBearerOrThrowRpcError(
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
  });
}
