import {
  isRpcErrorCode,
  type ClientFrame,
  type ConnectionManifest,
  type HostFatalErrorFrame,
  type HostFrame,
  type MethodVersionRegistry,
  type SchemaVersion,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  markMayHaveReachedHost,
  transportFailureBeforeSend,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { resolveUnavailableMethodDegrade } from "./unavailable-method-degrade";
import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  negotiatedVersionMeetsRequirement,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "./host-messenger";
import type { TimerHandle } from "./timer-handle";
import {
  decodeResponsePayloadWithContext,
  extractBearerOrThrowRpcError,
  hostFatalError,
  prepareRequestPayload,
} from "./ws-rpc-client";

/**
 * One local unary session for a host, a signed-in identity, and the URL that
 * reaches that host. Status is not part of the key: a status change must not
 * rotate the session.
 *
 * The socket used to be one per call so a later call could not observe the
 * earlier call's context. That guarantee is now the contract below, held by
 * the host giving every request its own context and by this session never
 * handing one call's bearer, abort, or bytes to another.
 */
export function localUnarySessionKey(
  hostId: string,
  userId: string,
  websocketUrl: string,
): string {
  return `${hostId}\u0000${userId}\u0000${websocketUrl}`;
}

export interface PersistentSocketHandlers {
  onFrame(frame: HostFrame): void;
  onTransportClosed(message: string, selfInitiated: boolean): void;
}

/** The live socket a session sends on. Closing it is the session's own teardown. */
export interface MultiplexSocket {
  send(frame: ClientFrame): void;
  close(code: number, reason: string): void;
}

export interface AttachedPersistentSocket {
  readonly socket: MultiplexSocket;
  readonly clientManifest: ConnectionManifest;
  readonly hostManifest: ConnectionManifest;
  readonly idempotency: boolean;
}

export interface LocalUnarySessionOptions<
  Registry extends VersionedRpcRegistry,
> {
  readonly key: string;
  readonly registry: Registry;
  readonly hostId: string;
  readonly directory: LocalUnarySessionDirectory<Registry>;
}

interface QueuedCall<Registry extends VersionedRpcRegistry> {
  readonly requestId: string;
  readonly method: string;
  readonly methodRegistry: MethodVersionRegistry;
  readonly params: unknown;
  readonly responseTimeoutMs: number;
  readonly options: HostRequestOptions;
  readonly succeed: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
  /** Removes the pre-send abort listener. Null once the call has left the queue. */
  abortListener: (() => void) | null;
}

interface InFlightCall {
  readonly requestId: string;
  readonly method: string;
  readonly wireMethod: string;
  readonly methodRegistry: MethodVersionRegistry;
  readonly clientCanonical: SchemaVersion;
  readonly hostCanonical: SchemaVersion;
  readonly onWirePayload: unknown;
  readonly responseTimeoutMs: number;
  readonly timer: TimerHandle;
  readonly abortListener: () => void;
  readonly abortSignal: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Multiplexed local unary calls on one socket.
 *
 * No count or byte cap. The remote unary session leaves `pendingUnary`
 * unbounded, and the owner's ruling is that this session does not invent
 * one. The real limit is the one trusted local client: each request runs
 * in its own context, and nothing of it is retained after the response.
 *
 * A call is sent once the socket is up. A sent call is never written
 * again. A close settles it as uncertain. A response timeout settles it
 * as uncertain after one best-effort `cancel` for that request id. A call
 * still queued when the socket dies was never written, so it fails before
 * send and is not written on another socket; the next public call
 * discovers a new session. Aborting a queued call sends nothing. Aborting
 * a sent call writes one `cancel` for that request id and leaves every
 * other call on the socket alone.
 */
export class LocalUnarySession<Registry extends VersionedRpcRegistry> {
  readonly handlers: PersistentSocketHandlers;

  private readonly key: string;
  private readonly registry: Registry;
  private readonly hostId: string;
  private readonly directory: LocalUnarySessionDirectory<Registry>;

  private connection: MultiplexSocket | null = null;
  private clientManifest: ConnectionManifest | null = null;
  private hostManifest: ConnectionManifest | null = null;
  private idempotency = false;
  private readonly queue: QueuedCall<Registry>[] = [];
  private readonly inFlight = new Map<string, InFlightCall>();
  private retired = false;
  /** Set by `releaseIfIdle`. A later call clears it; otherwise the socket closes once it is idle. */
  private closeWhenIdle = false;
  /** Set around a close this session initiated, so that close is not a peer drop. */
  private suppressClose = false;
  /** A fatal delivered before any call was queued. The adopter throws this instead of publishing. */
  private admissionFatal: HostFatalErrorFrame | null = null;

  constructor(options: LocalUnarySessionOptions<Registry>) {
    this.key = options.key;
    this.registry = options.registry;
    this.hostId = options.hostId;
    this.directory = options.directory;
    this.handlers = {
      onFrame: (frame) => {
        this.onFrame(frame);
      },
      onTransportClosed: (message, selfInitiated) => {
        this.onTransportClosed(message, selfInitiated);
      },
    };
  }

  /** Whether this object still accepts calls. A retired session is dropped from the directory. */
  get isRetired(): boolean {
    return this.retired;
  }

  /** The host fatal that arrived before a call was queued, if adoption delivered one. */
  get admissionFatalFrame(): HostFatalErrorFrame | null {
    return this.admissionFatal;
  }

  attach(attached: AttachedPersistentSocket): void {
    this.connection = attached.socket;
    this.clientManifest = attached.clientManifest;
    this.hostManifest = attached.hostManifest;
    this.idempotency = attached.idempotency;
    this.suppressClose = false;
  }

  call<Method extends keyof Registry & string>(input: {
    readonly requestId: string;
    readonly method: Method;
    readonly params: RequestOfMethod<Registry, Method>;
    readonly responseTimeoutMs: number;
    readonly options: HostRequestOptions;
  }): Promise<ResponseOfMethod<Registry, Method>> {
    if (this.retired) {
      return Promise.reject(
        preSendRetryable(
          input.requestId,
          input.method,
          "Persistent session has closed",
        ),
      );
    }
    this.closeWhenIdle = false;
    const methodRegistry = this.registry[input.method];
    return new Promise((resolve, reject) => {
      const queued: QueuedCall<Registry> = {
        requestId: input.requestId,
        method: input.method,
        methodRegistry,
        params: input.params,
        responseTimeoutMs: input.responseTimeoutMs,
        options: input.options,
        succeed: (value) => {
          resolve(value as ResponseOfMethod<Registry, Method>);
        },
        fail: reject,
        abortListener: null,
      };
      const onAbort = (): void => {
        if (!this.dropQueued(queued.requestId)) {
          return;
        }
        queued.fail(abortedCall(queued, false));
      };
      queued.abortListener = onAbort;
      input.options.authority.abortSignal.addEventListener("abort", onAbort, {
        once: true,
      });
      this.queue.push(queued);
      if (input.options.authority.abortSignal.aborted) {
        onAbort();
        return;
      }
      this.pump();
    });
  }

  private pump(): void {
    const manifest = this.hostManifest;
    const connection = this.connection;
    if (manifest === null || connection === null) {
      return;
    }
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next === undefined) {
        return;
      }
      this.queue.shift();
      this.clearAbortListener(next);
      if (next.options.authority.abortSignal.aborted) {
        next.fail(abortedCall(next, false));
        continue;
      }
      this.dispatch(next, connection, manifest);
    }
  }

  private dispatch(
    call: QueuedCall<Registry>,
    connection: MultiplexSocket,
    hostManifest: ConnectionManifest,
  ): void {
    const clientManifest = this.clientManifest;
    if (clientManifest === null) {
      call.fail(
        preSendRetryable(
          call.requestId,
          call.method,
          "Persistent session has no negotiated manifest",
        ),
      );
      return;
    }
    const requirement = call.options.requiredHostMethodVersion;
    if (
      requirement !== null &&
      !negotiatedVersionMeetsRequirement(
        hostManifest[requirement.method],
        requirement,
      )
    ) {
      call.fail(
        new HostMethodVersionUnsatisfiedError({
          requirement,
          negotiated: hostManifest[requirement.method],
          requestId: call.requestId,
          method: call.method,
          hostId: this.hostId,
        }),
      );
      return;
    }
    const clientCanonical = clientManifest[call.method];
    const hostCanonical = hostManifest[call.method];
    if (clientCanonical === undefined || hostCanonical === undefined) {
      void this.degrade(call, clientManifest, hostManifest, clientCanonical);
      return;
    }
    void this.sendPrepared(
      call,
      connection,
      call.method,
      call.methodRegistry,
      clientCanonical,
      hostCanonical,
      call.params,
    ).then(
      (value) => {
        call.succeed(value);
      },
      (error: unknown) => {
        call.fail(error);
      },
    );
  }

  private async degrade(
    call: QueuedCall<Registry>,
    clientManifest: ConnectionManifest,
    hostManifest: ConnectionManifest,
    clientCanonical: SchemaVersion | undefined,
  ): Promise<void> {
    try {
      const value = await resolveUnavailableMethodDegrade({
        registry: this.registry,
        method: call.method,
        methodRegistry: call.methodRegistry,
        clientCanonical,
        clientManifest,
        hostManifest,
        params: call.params,
        requestId: call.requestId,
        execute: (input) =>
          this.sendPreparedAsync(
            call,
            input.method,
            input.methodRegistry,
            input.clientCanonical,
            input.hostCanonical,
            input.params,
          ),
      });
      call.succeed(value);
    } catch (cause) {
      call.fail(cause);
    }
  }

  private sendPreparedAsync(
    call: QueuedCall<Registry>,
    wireMethod: string,
    methodRegistry: MethodVersionRegistry,
    clientCanonical: SchemaVersion,
    hostCanonical: SchemaVersion,
    params: unknown,
  ): Promise<unknown> {
    const connection = this.connection;
    if (connection === null) {
      return Promise.reject(
        preSendRetryable(
          call.requestId,
          call.method,
          "Persistent session socket closed before the request was sent",
        ),
      );
    }
    return this.sendPrepared(
      call,
      connection,
      wireMethod,
      methodRegistry,
      clientCanonical,
      hostCanonical,
      params,
    );
  }

  /**
   * Writes the request once and returns the promise the response settles.
   * The call is in flight before the write, so a close that races the write
   * still settles it as uncertain rather than as a second send.
   */
  private sendPrepared(
    call: QueuedCall<Registry>,
    connection: MultiplexSocket,
    wireMethod: string,
    methodRegistry: MethodVersionRegistry,
    clientCanonical: SchemaVersion,
    hostCanonical: SchemaVersion,
    params: unknown,
  ): Promise<unknown> {
    let prepared: { onWireVersion: SchemaVersion; onWirePayload: unknown };
    try {
      prepared = prepareRequestPayload(
        methodRegistry,
        clientCanonical,
        hostCanonical,
        params,
        call.requestId,
        wireMethod,
      );
    } catch (cause) {
      return Promise.reject(cause);
    }
    const wireKey =
      call.options.idempotencyKey !== null && this.idempotency
        ? call.options.idempotencyKey
        : null;
    if (call.options.replayMustBeKeyed && wireKey === null) {
      return Promise.reject(
        transportFailureBeforeSend({
          message: `Host '${this.hostId}' cannot honour the idempotency key a replay of '${call.method}' requires`,
          requestId: call.requestId,
          method: call.method,
        }),
      );
    }
    let token: string;
    try {
      token = readBearer(call.options.authority, call.requestId, call.method);
    } catch (cause) {
      return Promise.reject(cause);
    }
    if (this.inFlight.has(call.requestId)) {
      return Promise.reject(
        new HostRpcError({
          code: "RPC_ERROR",
          message: `Duplicate request id '${call.requestId}' on the persistent session`,
          requestId: call.requestId,
          method: call.method,
          fatalDetails: null,
        }),
      );
    }
    const abortListener = (): void => {
      this.cancelSent(call.requestId);
    };
    return new Promise((resolve, reject) => {
      const entry: InFlightCall = {
        requestId: call.requestId,
        method: call.method,
        wireMethod,
        methodRegistry,
        clientCanonical,
        hostCanonical,
        onWirePayload: prepared.onWirePayload,
        responseTimeoutMs: call.responseTimeoutMs,
        timer: setTimeout(() => {
          this.timeoutSent(call.requestId);
        }, call.responseTimeoutMs),
        abortListener,
        abortSignal: call.options.authority.abortSignal,
        resolve,
        reject,
      };
      this.inFlight.set(call.requestId, entry);
      call.options.authority.abortSignal.addEventListener(
        "abort",
        abortListener,
        { once: true },
      );
      if (call.options.authority.abortSignal.aborted) {
        this.rejectInFlight(entry, abortedCall(call, false));
        return;
      }
      try {
        connection.send({
          kind: "request",
          requestId: call.requestId,
          method: wireMethod,
          schemaVersion: prepared.onWireVersion,
          params: prepared.onWirePayload,
          idempotencyKey: wireKey,
          token,
          cloudAuthorized: call.options.authority.cloudAuthorized?.(),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.rejectInFlight(
          entry,
          preSendRetryable(
            call.requestId,
            call.method,
            `Persistent session failed before the request was sent: ${message}`,
          ),
        );
      }
    });
  }

  private onFrame(frame: HostFrame): void {
    if (frame.kind === "fatalError") {
      this.onFatal(frame);
      return;
    }
    if (frame.kind !== "response") {
      this.onPeerLoss(
        `Unexpected host frame '${frame.kind}' on the persistent session`,
        false,
      );
      return;
    }
    const entry = this.inFlight.get(frame.requestId);
    if (entry === undefined) {
      return;
    }
    if (frame.method !== entry.wireMethod) {
      const error = new HostRpcError({
        code: "RPC_ERROR",
        message: `Response method '${frame.method}' does not match request method '${entry.wireMethod}'`,
        requestId: entry.requestId,
        method: entry.method,
        fatalDetails: null,
      });
      markMayHaveReachedHost(error);
      this.rejectInFlight(entry, error);
      return;
    }
    if (frame.error !== null) {
      // A transient bearer check is this call's no-dispatch attestation.
      // It must not read as a host answer that might have run, and it must
      // not send the caller through credential recovery.
      if (frame.error.retryable === true) {
        const code = isRpcErrorCode(frame.error.code)
          ? frame.error.code
          : "RPC_ERROR";
        this.rejectInFlight(
          entry,
          new RetryableTransportError({
            code,
            message: frame.error.message,
            requestId: entry.requestId,
            method: entry.method,
            fatalDetails: {
              code: "UNAUTHORIZED",
              reason: frame.error.message,
              incompatibleMethods: null,
              upgradeGuidance: null,
              retryable: true,
            },
            replaySafetyFromKey: false,
          }),
        );
        return;
      }
      this.rejectInFlight(
        entry,
        HostRpcError.fromWireEnvelope(
          frame.error,
          entry.requestId,
          entry.method,
        ),
      );
      return;
    }
    try {
      const value = decodeResponsePayloadWithContext(
        entry.methodRegistry,
        entry.clientCanonical,
        entry.hostCanonical,
        frame.result,
        entry.requestId,
        entry.wireMethod,
        entry.onWirePayload,
        this.hostId,
      );
      this.resolveInFlight(entry, value);
    } catch (cause) {
      if (
        cause instanceof HostRpcError &&
        !(cause instanceof HostTransportFailureError)
      ) {
        markMayHaveReachedHost(cause);
      }
      this.rejectInFlight(entry, cause);
    }
  }

  private onFatal(frame: HostFatalErrorFrame): void {
    // rejectInFlight pumps the queue. Drop the socket first so that pump
    // cannot write another request after the fatal frame.
    if (this.inFlight.size === 0 && this.queue.length === 0) {
      this.admissionFatal = frame;
    }
    this.closeSocket();
    const pending = Array.from(this.inFlight.values());
    for (const entry of pending) {
      const error = hostFatalError(
        frame,
        entry.requestId,
        entry.method,
        "afterRequest",
      );
      if (!(error instanceof RetryableTransportError)) {
        markMayHaveReachedHost(error);
      }
      this.rejectInFlight(entry, error);
    }
    const incompatible = frame.details.code === "INCOMPATIBLE";
    if (incompatible) {
      const queued = this.queue.splice(0, this.queue.length);
      for (const queuedCall of queued) {
        this.clearAbortListener(queuedCall);
        queuedCall.fail(
          hostFatalError(
            frame,
            queuedCall.requestId,
            queuedCall.method,
            "beforeRequest",
          ),
        );
      }
      this.directory.fail(this.key, this);
    } else {
      this.failQueued(null);
    }
    this.retireIfIdle();
  }

  private onTransportClosed(message: string, selfInitiated: boolean): void {
    if (this.suppressClose) {
      return;
    }
    this.onPeerLoss(message, selfInitiated);
  }

  /**
   * The socket is gone. Sent calls are uncertain and stay that way. Anything
   * still queued was never written, so it fails before send. The session
   * retires; the next public call discovers a new one.
   */
  private onPeerLoss(message: string, selfInitiated: boolean): void {
    void selfInitiated;
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      this.suppressClose = true;
      try {
        connection.close(1000, "session-closed");
      } catch (cause) {
        void cause;
      }
    }
    const sent = Array.from(this.inFlight.values());
    for (const entry of sent) {
      const error = new HostTransportFailureError({
        code: "RPC_ERROR",
        message,
        requestId: entry.requestId,
        method: entry.method,
        fatalDetails: null,
      });
      markMayHaveReachedHost(error);
      this.rejectInFlight(entry, error);
    }
    this.failQueued(null);
    this.retireIfIdle();
  }

  private cancelSent(requestId: string): void {
    const entry = this.inFlight.get(requestId);
    if (entry === undefined) {
      return;
    }
    const connection = this.connection;
    if (connection !== null) {
      try {
        connection.send({ kind: "cancel", requestId });
      } catch (cause) {
        void cause;
      }
    }
    this.rejectInFlight(
      entry,
      new HostRequestAbortedError({
        message:
          "Host request authority was aborted while the request was in flight",
        requestId: entry.requestId,
        method: entry.method,
        mayHaveDispatched: true,
      }),
    );
  }

  private timeoutSent(requestId: string): void {
    const entry = this.inFlight.get(requestId);
    if (entry === undefined) {
      return;
    }
    const connection = this.connection;
    if (connection !== null) {
      try {
        connection.send({ kind: "cancel", requestId });
      } catch (cause) {
        void cause;
      }
    }
    const error = new HostTransportFailureError({
      code: "RPC_ERROR",
      message: `WebSocket frame timed out after ${entry.responseTimeoutMs}ms`,
      requestId: entry.requestId,
      method: entry.method,
      fatalDetails: null,
    });
    markMayHaveReachedHost(error);
    this.rejectInFlight(entry, error);
  }

  private resolveInFlight(entry: InFlightCall, value: unknown): void {
    if (!this.releaseInFlight(entry)) {
      return;
    }
    entry.resolve(value);
    this.pump();
    this.retireIfReleased();
  }

  private rejectInFlight(entry: InFlightCall, error: unknown): void {
    if (!this.releaseInFlight(entry)) {
      return;
    }
    entry.reject(error);
    this.pump();
    this.retireIfReleased();
  }

  private releaseInFlight(entry: InFlightCall): boolean {
    if (this.inFlight.get(entry.requestId) !== entry) {
      return false;
    }
    this.inFlight.delete(entry.requestId);
    clearTimeout(entry.timer);
    entry.abortSignal.removeEventListener("abort", entry.abortListener);
    return true;
  }

  private dropQueued(requestId: string): boolean {
    const index = this.queue.findIndex((call) => call.requestId === requestId);
    if (index < 0) {
      return false;
    }
    const [removed] = this.queue.splice(index, 1);
    if (removed === undefined) {
      return false;
    }
    this.clearAbortListener(removed);
    return true;
  }

  /** `error` null means each call fails as a pre-send retry, because it was never written. */
  private failQueued(error: HostRpcError | null): void {
    const pending = this.queue.splice(0, this.queue.length);
    for (const call of pending) {
      this.clearAbortListener(call);
      call.fail(
        error ??
          preSendRetryable(
            call.requestId,
            call.method,
            "Persistent session closed before the request was sent",
          ),
      );
    }
  }

  private closeSocket(): void {
    const connection = this.connection;
    this.connection = null;
    if (connection === null) {
      return;
    }
    this.suppressClose = true;
    try {
      connection.close(1000, "session-closed");
    } catch (cause) {
      void cause;
    }
  }

  releaseIfIdle(): void {
    this.closeWhenIdle = true;
    this.retireIfIdle();
  }

  private retireIfReleased(): void {
    if (this.closeWhenIdle) {
      this.retireIfIdle();
    }
  }

  private retireIfIdle(): void {
    if (this.retired) {
      return;
    }
    if (this.queue.length > 0 || this.inFlight.size > 0) {
      return;
    }
    this.retired = true;
    this.closeSocket();
    this.directory.release(this.key, this);
  }

  private clearAbortListener(call: QueuedCall<Registry>): void {
    const listener = call.abortListener;
    if (listener === null) {
      return;
    }
    call.abortListener = null;
    call.options.authority.abortSignal.removeEventListener("abort", listener);
  }
}

export type SessionGateResult<Registry extends VersionedRpcRegistry> =
  | { readonly kind: "ready"; readonly session: LocalUnarySession<Registry> }
  | { readonly kind: "legacy" }
  | { readonly kind: "failed"; readonly error: HostRpcError }
  | { readonly kind: "retry" };

export type SessionAdmission<Registry extends VersionedRpcRegistry> =
  | { readonly kind: "ready"; readonly session: LocalUnarySession<Registry> }
  | { readonly kind: "legacy" }
  | {
      readonly kind: "wait";
      readonly settled: Promise<SessionGateResult<Registry>>;
    }
  | { readonly kind: "owner"; readonly publish: SessionPublisher<Registry> };

export interface SessionPublisher<Registry extends VersionedRpcRegistry> {
  ready(session: LocalUnarySession<Registry>): void;
  legacy(): void;
  failed(error: HostRpcError): void;
  retry(): void;
}

interface SessionSlot<Registry extends VersionedRpcRegistry> {
  phase: "dialing" | "ready" | "legacy";
  session: LocalUnarySession<Registry> | null;
  waiters: Array<(result: SessionGateResult<Registry>) => void>;
  /**
   * Set when `releaseIdle` runs while this slot is still dialing. Consumed
   * after the discovering call has queued, so that call closes the socket
   * once it settles.
   */
  releaseBeforeReady: boolean;
}

/**
 * Binds a caller to the session for its host and identity synchronously.
 * The first caller in a tick owns the dial; everyone else waits on that
 * dial instead of opening a second socket.
 */
export class LocalUnarySessionDirectory<Registry extends VersionedRpcRegistry> {
  private readonly slots = new Map<string, SessionSlot<Registry>>();

  claim(key: string): SessionAdmission<Registry> {
    const existing = this.slots.get(key);
    if (existing === undefined) {
      return this.beginDial(key);
    }
    if (
      existing.phase === "ready" &&
      existing.session !== null &&
      !existing.session.isRetired
    ) {
      return { kind: "ready", session: existing.session };
    }
    if (existing.phase === "ready") {
      this.slots.delete(key);
      return this.beginDial(key);
    }
    // openAck carries no host version and no instance id, so a host whose
    // ack omitted the session stays one socket per call for this process.
    // A later upgrade under the same URL is not on an ack we already hold.
    if (existing.phase === "legacy") {
      return { kind: "legacy" };
    }
    return {
      kind: "wait",
      settled: new Promise((resolve) => {
        existing.waiters.push(resolve);
      }),
    };
  }

  releaseIdle(): void {
    for (const slot of this.slots.values()) {
      if (slot.session !== null) {
        slot.session.releaseIfIdle();
        continue;
      }
      if (slot.phase === "dialing") {
        slot.releaseBeforeReady = true;
      }
    }
  }

  /**
   * Takes the dial-time release for `session`, once. False when this slot
   * was not released, or when `session` is no longer the one it published.
   */
  consumeReleaseBeforeReady(
    key: string,
    session: LocalUnarySession<Registry>,
  ): boolean {
    const slot = this.slots.get(key);
    if (
      slot === undefined ||
      slot.session !== session ||
      !slot.releaseBeforeReady
    ) {
      return false;
    }
    slot.releaseBeforeReady = false;
    return true;
  }

  release(key: string, session: LocalUnarySession<Registry>): void {
    const slot = this.slots.get(key);
    if (slot === undefined || slot.session !== session) {
      return;
    }
    if (slot.phase !== "ready") {
      return;
    }
    this.slots.delete(key);
  }

  fail(key: string, session: LocalUnarySession<Registry>): void {
    const slot = this.slots.get(key);
    if (slot === undefined || slot.session !== session) {
      return;
    }
    this.slots.delete(key);
  }

  private beginDial(key: string): SessionAdmission<Registry> {
    const slot: SessionSlot<Registry> = {
      phase: "dialing",
      session: null,
      waiters: [],
      releaseBeforeReady: false,
    };
    this.slots.set(key, slot);
    return { kind: "owner", publish: this.publisher(key, slot) };
  }

  private publisher(
    key: string,
    slot: SessionSlot<Registry>,
  ): SessionPublisher<Registry> {
    const finish = (result: SessionGateResult<Registry>): void => {
      const waiters = slot.waiters.splice(0, slot.waiters.length);
      for (const waiter of waiters) {
        waiter(result);
      }
    };
    return {
      ready: (session) => {
        if (slot.phase !== "dialing") {
          return;
        }
        slot.phase = "ready";
        slot.session = session;
        finish({ kind: "ready", session });
      },
      legacy: () => {
        if (slot.phase !== "dialing") {
          return;
        }
        slot.phase = "legacy";
        finish({ kind: "legacy" });
      },
      failed: (error) => {
        if (slot.phase !== "dialing") {
          return;
        }
        if (this.slots.get(key) === slot) {
          this.slots.delete(key);
        }
        finish({ kind: "failed", error });
      },
      retry: () => {
        if (slot.phase !== "dialing") {
          return;
        }
        if (this.slots.get(key) === slot) {
          this.slots.delete(key);
        }
        finish({ kind: "retry" });
      },
    };
  }
}

function abortedCall(
  call: { readonly requestId: string; readonly method: string },
  mayHaveDispatched: boolean,
): HostRequestAbortedError {
  return new HostRequestAbortedError({
    message: mayHaveDispatched
      ? "Host request authority was aborted while the request was in flight"
      : "Host request authority was aborted before the request was sent",
    requestId: call.requestId,
    method: call.method,
    mayHaveDispatched,
  });
}

function preSendRetryable(
  requestId: string,
  method: string,
  message: string,
): RetryableTransportError {
  return new RetryableTransportError({
    code: "RPC_ERROR",
    message,
    requestId,
    method,
    fatalDetails: null,
    replaySafetyFromKey: false,
  });
}

function readBearer(
  authority: HostRequestAuthority,
  requestId: string,
  method: string,
): string {
  return extractBearerOrThrowRpcError(authority.bearer, requestId, method);
}
