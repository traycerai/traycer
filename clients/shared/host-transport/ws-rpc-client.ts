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
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import type { TransportEvidenceReporter } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type HostTransportEndpoint,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import { dialPriorityForMethod } from "./dial-priority";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
} from "./ws-factory";
import {
  CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1,
  checkCompatibility,
  hostFrameSchema,
  toClientHandshakeIdentity,
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
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

export type { HostTransportEndpoint } from "./host-messenger";

/**
 * The complete reason emitted by hosts through 1.1.9 for the post-open timeout, anchored at both ends so only the host's timeout value may vary.
 */
const LEGACY_RPC_REQUEST_TIMEOUT_REASON =
  /^Timed out waiting for 'request' frame after openAck \(\d+ms\)$/;

export const HOST_POST_OPEN_ATTESTATION_WINDOW_MS = 50_000;

const ATTESTATION_DELIVERY_SLACK_MS = 5_000;

/**
 * Overshoot past a delivery leg's own duration that means the process was not *running* for most of it, rather than merely busy.
 * A second cleanly separates ordinary jitter - which must still let the grace end - from a scheduling gap that froze this process, and with it the host's ability to emit and deliver its attestation.
 */
const SUSPENSION_OVERSHOOT_TOLERANCE_MS = 1_000;

/**
 * Injectable source of the host endpoint the client should target.
 * Returning `null` means "no host currently bound" - the client rejects requests with a `HostRpcError` rather than dialing.
 */
export type HostEndpointProvider = () => HostTransportEndpoint | null;

export type RequestIdProvider = () => string;

export interface WsRpcClientOptions<Registry extends VersionedRpcRegistry> {
  readonly registry: Registry;
  readonly requestId: RequestIdProvider;
  readonly webSocketFactory: IWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly frameTimeoutMs: number;
  /**
   * See {@link LocalHostLiveness} for why sessions here are refcounted connectivity episodes rather than one per RPC.
   */
  readonly evidence: TransportEvidenceReporter;
  /**
   * How long after `openAck` this deployment's hosts are still expected to be sitting in `awaitingRequest`, and therefore still able to emit their no-dispatch attestation.
   * When the client's own response deadline expires first, the response wait is held open for whatever is left of this window instead of closing the socket over an ambiguous in-flight request - see `openSession`.
   */
  readonly hostAttestationWindowMs: number;
  /**
   * Who this client IS, sent on every `open` frame this transport writes.
   * It is a process constant (kind, epoch, and build version are all fixed for the life of the process - updating the app restarts it), which is why it is a construction dependency rather than something resolved per call.
   */
  readonly clientIdentity: FirstPartyClientIdentity;
}

/**
 * Concrete `IHostMessenger` that runs a single unary RPC over a freshly dialed WebSocket connection per call.
 * A missing direct downgrade bridge on the client surfaces as `DOWNGRADE_UNSUPPORTED` before the request frame is sent.
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
   * Serialized once at construction, not per request: every member is a process constant, so re-projecting it on each of this transport's per-request sockets would allocate an identical object per RPC.
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
    const { idempotencyKey, authority } = options;
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
      socket: this.webSocketFactory.create(
        selected.websocketUrl,
        // See `dial-priority.ts`.
        dialPriorityForMethod(method),
      ),
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
        capabilities: [CLIENT_CAPABILITY_EPIC_WRITE_PATH_V1],
        clientIdentity: this.clientIdentity,
      });

      // Handshake stays on the transport default even when the caller extended the response wait - a host that can't complete `openAck` quickly is unreachable, and long-poll patience must not mask that.
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
      // Publish what this host advertised so UI layers can gate an optional (non-floor) affordance without calling the method to find out.
      // Recorded before the compatibility check: an incompatible pairing still tells us truthfully which methods the host has, and the gate wants that fact even when this particular call is about to fail.
      recordNegotiatedHostManifest(selected.hostId, mergedHostManifest);
      const clientCanonical = mergedClientManifest[method];
      const hostCanonical = mergedHostManifest[method];
      const wireIdempotencyKey =
        idempotencyKey !== null &&
        ackFrame.capabilities?.includes(UNARY_CAPABILITY_IDEMPOTENCY_KEY) ===
          true
          ? idempotencyKey
          : null;
      // A replay may not go out unkeyed.
      // Stripping is right on a first attempt against a host that predates the capability - nothing was dispatched, so an unkeyed send is a first send - but this connection is not the one that earned the retry.
      if (options.replayMustBeKeyed && wireIdempotencyKey === null) {
        throw new HostTransportFailureError({
          code: "RPC_ERROR",
          message: `Host '${selected.hostId}' cannot honour the idempotency key a replay of '${method}' requires`,
          requestId,
          method,
          fatalDetails: null,
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
    } finally {
      authority.abortSignal.removeEventListener("abort", onAbort);
      session.close(1000, "ok");
    }
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
  idempotencyKey: string | null,
): Promise<ResponseOfMethod<Registry, Method>> {
  // Degrade policy is shared with the remote mux transport (see
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
      // Same-major counterpart to the cross-major no-bridge case below: the caller's request genuinely doesn't fit the older peer's schema (a newer-minor-only capability, not an additive field the peer would just ignore).
      // `DOWNGRADE_UNSUPPORTED` - not the generic `RPC_ERROR` transport/network code - lets a caller distinguish "this host is too old for what I just asked" from a real connectivity failure.
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
    // The host is the older side here, so `result` is raw wire data framed at `fromVersion` - the one place old-host payloads enter the client.
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
 * Detects the cross-major no-bridge case where the client is the newer side for the method being called.
 * Returning a non-null string signals the caller to surface `DOWNGRADE_UNSUPPORTED` instead of the broader `incompatible` fatal-error path.
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
  // Before the request, every host-marked transient is safe to retry.
  // After the local send, retry only the post-open timeout: that fatal is host attestation that it remained `awaitingRequest` and never dispatched the call.
  if (
    (phase === "beforeRequest" && details.retryable === true) ||
    isRpcRequestTimeout(details)
  ) {
    return new RetryableTransportError({
      code: "RPC_ERROR",
      // Both arms above are no-dispatch, which is why this is `false` and not a judgement call: one is `phase === "beforeRequest"`, the other is the host's own attestation that it stayed `awaitingRequest`.
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
 * True for the one host fatal that attests the request was never dispatched: the host's post-`openAck` deadline expired while it was still in `awaitingRequest`.
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
    throw HostRpcError.fromWireEnvelope(frame.error, requestId, method);
  }

  return frame.result;
}

/**
 * The two legs a post-send response timeout waits through before the call is declared ambiguously failed.
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
 * This transport opens a fresh socket per RPC, so a naive per-socket announcement would make the authority's session inventory flicker once per request.
 */
/**
 * Monotonic source for local RPC session ids, process-scoped (module state) rather than per client instance - the same shape `WsStreamClient` uses for `local-stream:s<n>`.
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
   * Waits up to `timeoutMs` for the next host frame.
   * A frame that arrives in that window can no longer complete the call - only the host's no-dispatch fatal is surfaced, and every other frame keeps the timeout.
   */
  next(timeoutMs: number): Promise<HostFrame>;
  send(frame: ClientFrame): void;
  abort(): void;
  close(code: number, reason: string): void;
}

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
   * Set by `onerror` when it fires before the socket ever opened.
   * Without this flag that refusal is reported as `indeterminate` and silently dropped from death detection.
   */
  let erroredBeforeOpen = false;
  let livenessStarted = false;
  let livenessEnded = false;

  const endLiveness = (): void => {
    if (!livenessStarted || livenessEnded) return;
    livenessEnded = true;
    liveness.socketClosed(hostId);
  };

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
    // An attempt we abandoned ourselves.
    if (outcome === "indeterminate") {
      evidence.reportDialIndeterminate(hostId, requestId, "local-ws");
      return;
    }
    // A close before the socket ever opened IS host-plane evidence: the connection was refused, or something answered and hung up before the handshake.
    // `refusalDetail` is null - `plan-restricted` is a remote entitlement verdict with a single provenance and cannot arise here.
    evidence.reportDialRefusal(hostId, requestId, "local-ws", null);
  };
  // Flipped the instant the `request` frame is handed to `send`.
  // A negotiated idempotency key is the other safe case: the host replays the original result instead of dispatching twice.
  let requestSent = false;
  let requestReplaySafe = false;
  let failure: HostRpcError | null = null;
  // While it is set it is the session's decided outcome - see the sticky rule in `failAll`.
  let ambiguousResponseTimeout: HostRpcError | null = null;

  /**
   * Builds the failure for a transient transport/timeout event (dial timeout, handshake `onerror`/`onclose`, `openAck` frame timeout).
   * It is retryable only while the request frame has not yet been sent; a malformed frame or a host-originated error never routes through here.
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
          // The ground for the retry, read straight off the branch that granted it: reaching here with `requestSent` means the key is the only thing making a replay safe, so the next attempt has to carry one.
          // Pre-send needs no key - the host never saw the call.
          replaySafetyFromKey: requestSent,
        });

  /**
   * The response timer is armed immediately after `openAck` is consumed, so `waitTimeoutMs` is the share of the window this wait has nominally consumed - no clock reading needed.
   * That is precisely when an attestation is about to arrive, which is why the remainder is floored at the delivery slack instead of collapsing to "no grace".
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
   * Ends a wait that is already inside its attestation grace.
   * The sticky rule in `failAll` supplies the recorded timeout; this exists so the callers that merely observe "the grace produced nothing usable" don't have to invent an error the caller will never see.
   */
  const failWithAmbiguousTimeout = (): void => {
    const ambiguous = ambiguousResponseTimeout;
    if (ambiguous === null) {
      return;
    }
    failAll(ambiguous);
  };

  /**
   * Re-arms the pending response wait for one leg of the grace, keeping the caller's resolvers attached so an attestation arriving in any leg still settles the original `next()` promise.
   * The window leg hands over to the delivery leg instead of ending the call - see `ATTESTATION_DELIVERY_SLACK_MS` for why the last word must belong to a freshly armed timer.
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
   * The one place the attestation grace is allowed to end the call, and the reason it is not simply `failWithAmbiguousTimeout`.
   * Firing far late means the leg measured a scheduling gap rather than host silence, so it is re-armed to become the running delivery opportunity it was meant to be.
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
    // Success first, then the announcement: the success clears this host's death streak, and the live session then makes later failures inert until it is retracted.
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
      // Once the caller's response deadline has elapsed no frame can still satisfy this call.
      // Only the host's no-dispatch attestation changes the outcome - it is handed to the caller, which maps it to a `RetryableTransportError`.
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
    // `closed` is the only thing that distinguishes a close we initiated - `abort()` and `close()` both set it before calling `socket.close()` - from one the host delivered.
    // It has to be read before the assignment below overwrites it; that assignment used to be the first statement here, which destroyed the discriminator one line above the code that needs it.
    const selfInitiated = closed;
    closed = true;
    endLiveness();
    if (!opened) {
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
          // The caller's deadline is up, but the host's post-`openAck` deadline may not be - and if this callback itself ran late, neither peer's timeline is where the numbers say it is.
          ambiguousResponseTimeout = ambiguous;
          armAttestationLeg(grace);
        }, timeoutMs);
        frameResolver = { resolve, reject, timer };
      });
    },

    send(frame: ClientFrame): void {
      // Past this point a transient failure is safe to auto-retry only when this exact connection negotiated a non-null idempotency key.
      // A key an older host stripped or never advertised never reaches this branch.
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
 * The transport layer is the only client-side host layer permitted to read a bearer from the `OpenFrameBearerSource` (`source.getBearerToken()`); every consumer above threads the source itself.
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
