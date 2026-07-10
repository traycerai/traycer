import type {
  MethodDegradeDeclaration,
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
} from "@traycer/protocol/framework/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { CredentialLeaseReleasedError } from "@traycer/protocol/auth/request-context";
import type {
  BearerSourceProvider,
  OpenFrameBearerSource,
} from "@traycer-clients/shared/auth/bearer-source";
import {
  HostRpcError,
  RetryableTransportError,
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
  type ClientFrame,
  type ConnectionManifest,
  type HostFrame,
  type HostResponseFrame,
  type HostFatalErrorFrame,
  type IncompatibleMethodDetails,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import type { TimerHandle } from "./timer-handle";

/**
 * Minimal endpoint shape the transport layer needs to dial a host. The
 * app-facing `HostDirectoryEntry` is a structural superset so existing
 * callers keep passing their directory entries unchanged - this narrow type
 * exists purely to keep `host-transport` free of any dependency on the
 * app-runtime host-directory module.
 */
export interface HostTransportEndpoint {
  readonly hostId: string;
  readonly websocketUrl: string | null;
}

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
  readonly endpoint: HostEndpointProvider;
  /**
   * Source of the bearer for the WS `open` frame. The transport is the ONLY
   * client-side layer permitted to read it (`source.getBearerToken()`); every
   * consumer above threads the bearer source itself. `null` → no bearer → the
   * transport fails before dialing.
   */
  readonly bearer: BearerSourceProvider;
  readonly requestId: RequestIdProvider;
  readonly webSocketFactory: IWebSocketFactory;
  readonly dialTimeoutMs: number;
  readonly frameTimeoutMs: number;
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
 *     host's minor up to the client's canonical.
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
 *     → `HostRpcError(code: "RPC_ERROR")`
 *   - missing / released bearer before dial → `HostRpcError(code: "RPC_ERROR")`
 *   - host `fatalError { code }` (`INCOMPATIBLE`, `UNAUTHORIZED`, or a
 *     domain-specific code) → known RPC codes are preserved on
 *     `HostRpcError.code`; domain-specific codes become `RPC_ERROR` while
 *     the original code stays in `fatalDetails`.
 *   - client mirror compat failure (other than cross-major no-bridge on the
 *     called method) → emits a `fatalError` frame at the client, then
 *     surfaces the same details back as a thrown
 *     `HostRpcError(code: "INCOMPATIBLE")`.
 *   - cross-major no-bridge on the called method → no `fatalError` frame
 *     is emitted; surfaces as
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
  private readonly endpoint: HostEndpointProvider;
  private readonly bearer: BearerSourceProvider;
  private readonly requestIdProvider: RequestIdProvider;
  private readonly webSocketFactory: IWebSocketFactory;
  private readonly dialTimeoutMs: number;
  private readonly frameTimeoutMs: number;

  constructor(options: WsRpcClientOptions<Registry>) {
    this.registry = options.registry;
    this.endpoint = options.endpoint;
    this.bearer = options.bearer;
    this.requestIdProvider = options.requestId;
    this.webSocketFactory = options.webSocketFactory;
    this.dialTimeoutMs = options.dialTimeoutMs;
    this.frameTimeoutMs = options.frameTimeoutMs;
  }

  async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const requestId = this.requestIdProvider();
    const selected = this.endpoint();

    if (selected === null) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "No host is currently bound to the client",
        requestId,
        method,
        fatalDetails: null,
      });
    }

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
      this.bearer(),
      requestId,
      method,
    );

    const session = openSession({
      socket: this.webSocketFactory.create(selected.websocketUrl),
      dialTimeoutMs: this.dialTimeoutMs,
      frameTimeoutMs: this.frameTimeoutMs,
      requestId,
      method,
    });

    try {
      await session.dial();

      session.send({
        kind: "open",
        token,
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      });

      const ackFrame = await session.next();

      if (ackFrame.kind === "fatalError") {
        throw hostFatalError(ackFrame, requestId, method);
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
      );
    } finally {
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

  const responseFrame = await session.next();

  if (responseFrame.kind === "fatalError") {
    throw hostFatalError(responseFrame, requestId, method);
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

  return decodeResponsePayload<Response>(
    methodRegistry,
    clientCanonical,
    hostCanonical,
    decodedResult,
    requestId,
    method,
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
): Promise<ResponseOfMethod<Registry, Method>> {
  if (clientCanonical === undefined) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Client registry has no canonical manifest entry for method '${method}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  const degrade = methodRegistry.degrade;
  if (degrade === undefined) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Host does not advertise method '${method}', and the client registry declares no degrade strategy`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  if (degrade.kind === "unsupported") {
    throw unsupportedHostMethodError(method, requestId);
  }

  return executeFallbackMethodDegrade(
    registry,
    session,
    method,
    degrade,
    clientManifest,
    hostManifest,
    params,
    requestId,
  );
}

async function executeFallbackMethodDegrade<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
>(
  registry: Registry,
  session: Session,
  method: Method,
  degrade: MethodDegradeDeclaration,
  clientManifest: ConnectionManifest,
  hostManifest: ConnectionManifest,
  params: RequestOfMethod<Registry, Method>,
  requestId: string,
): Promise<ResponseOfMethod<Registry, Method>> {
  if (degrade.kind !== "fallback") {
    throw unsupportedHostMethodError(method, requestId);
  }

  const targetMethod = degrade.to.method;
  if (!hasRegistryMethod(registry, targetMethod)) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Fallback for method '${method}' targets unknown method '${targetMethod}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  const targetClientCanonical = {
    major: degrade.to.major,
    minor: degrade.to.minor,
  };
  const targetHostCanonical = hostManifest[targetMethod];
  if (
    clientManifest[targetMethod] === undefined ||
    targetHostCanonical === undefined
  ) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Fallback for method '${method}' targets unavailable floor method '${targetMethod}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  const fallbackParams = degrade.adaptRequest(params);
  const fallbackResult = await executeAvailableMethodRequest<unknown, unknown>(
    session,
    registry[targetMethod] as MethodVersionRegistry,
    targetMethod,
    targetClientCanonical,
    targetHostCanonical,
    fallbackParams,
    requestId,
  );
  return degrade.adaptResponse(fallbackResult) as ResponseOfMethod<
    Registry,
    Method
  >;
}

function unsupportedHostMethodError(
  method: string,
  requestId: string,
): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: `This host does not support '${method}'. Upgrade the host to use this feature.`,
    requestId,
    method,
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason: `This host does not support '${method}'. Upgrade the host to use this feature.`,
      incompatibleMethods: null,
      upgradeGuidance: {
        clientShouldUpgrade: false,
        hostShouldUpgrade: true,
      },
    },
  });
}

function hasRegistryMethod<Registry extends VersionedRpcRegistry>(
  registry: Registry,
  method: string,
): method is keyof Registry & string {
  return Object.prototype.hasOwnProperty.call(registry, method);
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
function prepareRequestPayload<Payload>(
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
      throw new HostRpcError({
        code: "RPC_ERROR",
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
function decodeResponsePayload<Payload>(
  methodRegistry: MethodVersionRegistry,
  clientCanonical: SchemaVersion,
  hostCanonical: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
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
  );
}

function upgradeResponseAlongChain<Payload>(
  methodRegistry: MethodVersionRegistry,
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion,
  result: unknown,
  requestId: string,
  method: string,
): Payload {
  try {
    const upgraded = upgradeResponseToVersion(
      methodRegistry,
      fromVersion,
      toVersion,
      result as never,
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
): HostRpcError {
  const details = frame.details;
  return new HostRpcError({
    code: isRpcErrorCode(details.code) ? details.code : "RPC_ERROR",
    message: details.reason,
    requestId,
    method,
    fatalDetails: details,
  });
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

interface SessionOptions {
  readonly socket: WebSocketLike;
  readonly dialTimeoutMs: number;
  readonly frameTimeoutMs: number;
  readonly requestId: string;
  readonly method: string;
}

interface Session {
  dial(): Promise<void>;
  next(): Promise<HostFrame>;
  send(frame: ClientFrame): void;
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
  const { socket, dialTimeoutMs, frameTimeoutMs, requestId, method } = options;

  let opened = false;
  let closed = false;
  // Flipped the instant the `request` frame is handed to `send`. Before this
  // point every transient failure is provably pre-send (the host never saw the
  // call), so it surfaces as a `RetryableTransportError`; after it, the same
  // failure shapes stay a plain `HostRpcError` because a retry could
  // re-execute a non-idempotent method.
  let requestSent = false;
  let failure: HostRpcError | null = null;

  /**
   * Builds the failure for a transient transport/timeout event (dial timeout,
   * handshake `onerror`/`onclose`, `openAck` frame timeout). It is retryable
   * only while the request frame has not yet been sent; a malformed frame or a
   * host-originated error never routes through here.
   */
  const transientFailure = (message: string): HostRpcError =>
    requestSent
      ? new HostRpcError({
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
    if (failure === null) {
      failure = error;
    }
    if (dialResolver !== null) {
      const resolver = dialResolver;
      dialResolver = null;
      clearTimeout(resolver.timer);
      resolver.reject(error);
    }
    if (frameResolver !== null) {
      const resolver = frameResolver;
      frameResolver = null;
      clearTimeout(resolver.timer);
      resolver.reject(error);
    }
  };

  socket.onopen = () => {
    opened = true;
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
      const resolver = frameResolver;
      frameResolver = null;
      clearTimeout(resolver.timer);
      resolver.resolve(frame);
      return;
    }
    buffer.push(frame);
  };

  socket.onerror = (event: WebSocketErrorEvent) => {
    failAll(transientFailure(`WebSocket transport error: ${event.message}`));
  };

  socket.onclose = (event: WebSocketCloseEvent) => {
    closed = true;
    if (!opened) {
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
          failAll(
            transientFailure(
              `WebSocket dial timed out after ${dialTimeoutMs}ms`,
            ),
          );
        }, dialTimeoutMs);
        dialResolver = { resolve, reject, timer };
      });
    },

    next(): Promise<HostFrame> {
      if (failure !== null) {
        return Promise.reject(failure);
      }
      const buffered = buffer.shift();
      if (buffered !== undefined) {
        return Promise.resolve(buffered);
      }
      return new Promise<HostFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          failAll(
            transientFailure(
              `WebSocket frame timed out after ${frameTimeoutMs}ms`,
            ),
          );
        }, frameTimeoutMs);
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

    close(code: number, reason: string): void {
      if (closed) {
        return;
      }
      closed = true;
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
  source: OpenFrameBearerSource | null,
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
