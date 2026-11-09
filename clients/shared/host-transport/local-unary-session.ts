import type {
  ConnectionManifest,
  MethodVersionRegistry,
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES,
  LOCAL_UNARY_SESSION_MAX_IN_FLIGHT,
  LOCAL_UNARY_SESSION_MAX_QUEUED,
  type ClientFrame,
  type HostFatalErrorFrame,
  type HostFrame,
} from "@traycer/protocol/framework/index";
import { markMayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
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

const paramsEncoder = new TextEncoder();

function paramsByteLength(params: unknown): number {
  const encoded = JSON.stringify(params);
  if (encoded === undefined) {
    return 0;
  }
  return paramsEncoder.encode(encoded).length;
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

export type ReplacementDialResult =
  | { readonly kind: "persistent"; readonly attached: AttachedPersistentSocket }
  | { readonly kind: "legacy" };

export interface LocalUnarySessionOptions<
  Registry extends VersionedRpcRegistry,
> {
  readonly key: string;
  readonly registry: Registry;
  readonly hostId: string;
  readonly directory: LocalUnarySessionDirectory<Registry>;
  readonly dialReplacement: (
    authority: HostRequestAuthority,
    method: string,
  ) => Promise<ReplacementDialResult>;
}

interface QueuedCall<Registry extends VersionedRpcRegistry> {
  readonly requestId: string;
  readonly method: string;
  readonly methodRegistry: MethodVersionRegistry;
  readonly params: unknown;
  readonly responseTimeoutMs: number;
  readonly options: HostRequestOptions;
  readonly bytes: number;
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
  readonly bytes: number;
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
 * A call sits in the queue until a slot is free, then is sent once. A sent
 * call is never written again: a close or a response timeout settles it as
 * uncertain. A call still in the queue is written on the replacement socket
 * only when it carries an idempotency key; an unkeyed one fails before send
 * so the caller can issue a first send. Aborting a queued call sends nothing.
 * Aborting a sent call writes one `cancel` for that request id and leaves
 * every other call on the socket alone.
 */
export class LocalUnarySession<Registry extends VersionedRpcRegistry> {
  readonly handlers: PersistentSocketHandlers;

  private readonly key: string;
  private readonly registry: Registry;
  private readonly hostId: string;
  private readonly directory: LocalUnarySessionDirectory<Registry>;
  private readonly dialReplacement: (
    authority: HostRequestAuthority,
    method: string,
  ) => Promise<ReplacementDialResult>;

  private connection: MultiplexSocket | null = null;
  private clientManifest: ConnectionManifest | null = null;
  private hostManifest: ConnectionManifest | null = null;
  private idempotency = false;
  private readonly queue: QueuedCall<Registry>[] = [];
  private queuedBytes = 0;
  private readonly inFlight = new Map<string, InFlightCall>();
  private inFlightBytes = 0;
  private redialing = false;
  private retired = false;
  /** Set around a close this session initiated, so that close is not a peer drop. */
  private suppressClose = false;

  constructor(options: LocalUnarySessionOptions<Registry>) {
    this.key = options.key;
    this.registry = options.registry;
    this.hostId = options.hostId;
    this.directory = options.directory;
    this.dialReplacement = options.dialReplacement;
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
    const bytes = paramsByteLength(input.params);
    if (bytes > LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES) {
      return Promise.reject(
        preSendRetryable(
          input.requestId,
          input.method,
          "Persistent session refused a call whose params exceed the byte cap",
        ),
      );
    }
    if (
      this.queue.length >= LOCAL_UNARY_SESSION_MAX_QUEUED ||
      this.queuedBytes + bytes > LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES
    ) {
      return Promise.reject(
        preSendRetryable(
          input.requestId,
          input.method,
          "Persistent session queue is full",
        ),
      );
    }
    const methodRegistry = this.registry[input.method];
    return new Promise((resolve, reject) => {
      const queued: QueuedCall<Registry> = {
        requestId: input.requestId,
        method: input.method,
        methodRegistry,
        params: input.params,
        responseTimeoutMs: input.responseTimeoutMs,
        options: input.options,
        bytes,
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
      this.queuedBytes += bytes;
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
    while (
      this.inFlight.size < LOCAL_UNARY_SESSION_MAX_IN_FLIGHT &&
      this.queue.length > 0
    ) {
      const next = this.queue[0];
      if (next === undefined) {
        return;
      }
      if (
        this.inFlightBytes + next.bytes >
        LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES
      ) {
        return;
      }
      this.queue.shift();
      this.queuedBytes -= next.bytes;
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
        new HostTransportFailureError({
          code: "RPC_ERROR",
          message: `Host '${this.hostId}' cannot honour the idempotency key a replay of '${call.method}' requires`,
          requestId: call.requestId,
          method: call.method,
          fatalDetails: null,
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
        bytes: call.bytes,
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
      this.inFlightBytes += call.bytes;
      call.options.authority.abortSignal.addEventListener(
        "abort",
        abortListener,
        { once: true },
      );
      if (call.options.authority.abortSignal.aborted) {
        this.cancelSent(call.requestId);
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
      this.queuedBytes = 0;
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
      const first = queued[0];
      this.directory.fail(
        this.key,
        this,
        hostFatalError(
          frame,
          first === undefined ? "session" : first.requestId,
          first === undefined ? "session" : first.method,
          "beforeRequest",
        ),
      );
    } else {
      this.failQueued(null);
    }
    this.closeSocket();
    this.retireIfIdle();
  }

  private onTransportClosed(message: string, selfInitiated: boolean): void {
    if (this.suppressClose) {
      return;
    }
    this.onPeerLoss(message, selfInitiated);
  }

  /**
   * The socket is gone. Sent calls are uncertain and stay that way. Keyed
   * calls still in the queue are the only ones written on a replacement.
   */
  private onPeerLoss(message: string, selfInitiated: boolean): void {
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
    if (selfInitiated) {
      this.failQueued(null);
      this.retireIfIdle();
      return;
    }
    this.failUnkeyedQueued(message);
    if (this.queue.length === 0) {
      this.retireIfIdle();
      return;
    }
    void this.redial();
  }

  private async redial(): Promise<void> {
    if (this.redialing || this.retired) {
      return;
    }
    this.redialing = true;
    const attempts = this.queue.length;
    for (let index = 0; index < attempts; index += 1) {
      const opener = this.queue[0];
      if (opener === undefined) {
        break;
      }
      try {
        const dialed = await this.dialReplacement(
          opener.options.authority,
          opener.method,
        );
        if (dialed.kind === "legacy") {
          this.directory.markLegacy(this.key, this);
          this.failQueued(null);
          this.redialing = false;
          this.retireIfIdle();
          return;
        }
        this.attach(dialed.attached);
        this.redialing = false;
        this.pump();
        return;
      } catch (cause) {
        if (cause instanceof RetryableTransportError) {
          this.failQueued(null);
          this.redialing = false;
          this.retireIfIdle();
          return;
        }
        if (isIncompatibleHandshake(cause)) {
          this.directory.fail(this.key, this, cause);
          this.failQueued(cause);
          this.redialing = false;
          this.retireIfIdle();
          return;
        }
        this.queue.shift();
        this.queuedBytes -= opener.bytes;
        this.clearAbortListener(opener);
        opener.fail(
          cause instanceof Error
            ? cause
            : preSendRetryable(
                opener.requestId,
                opener.method,
                "Persistent session handshake failed",
              ),
        );
        continue;
      }
    }
    this.redialing = false;
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
  }

  private rejectInFlight(entry: InFlightCall, error: unknown): void {
    if (!this.releaseInFlight(entry)) {
      return;
    }
    entry.reject(error);
    this.pump();
  }

  private releaseInFlight(entry: InFlightCall): boolean {
    if (this.inFlight.get(entry.requestId) !== entry) {
      return false;
    }
    this.inFlight.delete(entry.requestId);
    this.inFlightBytes -= entry.bytes;
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
    this.queuedBytes -= removed.bytes;
    this.clearAbortListener(removed);
    return true;
  }

  private failUnkeyedQueued(message: string): void {
    const kept: QueuedCall<Registry>[] = [];
    let keptBytes = 0;
    for (const call of this.queue) {
      if (call.options.idempotencyKey === null) {
        this.clearAbortListener(call);
        call.fail(preSendRetryable(call.requestId, call.method, message));
        continue;
      }
      kept.push(call);
      keptBytes += call.bytes;
    }
    this.queue.length = 0;
    for (const call of kept) {
      this.queue.push(call);
    }
    this.queuedBytes = keptBytes;
  }

  /** `error` null means each call fails as a pre-send retry, because it was never written. */
  private failQueued(error: HostRpcError | null): void {
    const pending = this.queue.splice(0, this.queue.length);
    this.queuedBytes = 0;
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

  private retireIfIdle(): void {
    if (this.retired) {
      return;
    }
    if (this.queue.length > 0 || this.inFlight.size > 0 || this.redialing) {
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
  | { readonly kind: "failed"; readonly error: HostRpcError }
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
  phase: "dialing" | "ready" | "legacy" | "failed";
  session: LocalUnarySession<Registry> | null;
  error: HostRpcError | null;
  waiters: Array<(result: SessionGateResult<Registry>) => void>;
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
    if (existing.phase === "legacy") {
      return { kind: "legacy" };
    }
    if (existing.phase === "failed" && existing.error !== null) {
      return { kind: "failed", error: existing.error };
    }
    if (existing.phase === "failed") {
      this.slots.delete(key);
      return this.beginDial(key);
    }
    return {
      kind: "wait",
      settled: new Promise((resolve) => {
        existing.waiters.push(resolve);
      }),
    };
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

  markLegacy(key: string, session: LocalUnarySession<Registry>): void {
    const slot = this.slots.get(key);
    if (slot === undefined || slot.session !== session) {
      return;
    }
    slot.phase = "legacy";
    slot.session = null;
  }

  fail(
    key: string,
    session: LocalUnarySession<Registry>,
    error: HostRpcError,
  ): void {
    const slot = this.slots.get(key);
    if (slot === undefined || slot.session !== session) {
      return;
    }
    slot.phase = "failed";
    slot.session = null;
    slot.error = error;
  }

  private beginDial(key: string): SessionAdmission<Registry> {
    const slot: SessionSlot<Registry> = {
      phase: "dialing",
      session: null,
      error: null,
      waiters: [],
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
        slot.phase = "failed";
        slot.error = error;
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

function isIncompatibleHandshake(error: unknown): error is HostRpcError {
  return (
    error instanceof HostRpcError &&
    error.code === "INCOMPATIBLE" &&
    error.fatalDetails !== null
  );
}

function readBearer(
  authority: HostRequestAuthority,
  requestId: string,
  method: string,
): string {
  return extractBearerOrThrowRpcError(authority.bearer, requestId, method);
}
