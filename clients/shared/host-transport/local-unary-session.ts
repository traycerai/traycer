import {
  isRpcErrorCode,
  type ClientFrame,
  type ConnectionManifest,
  type FatalErrorDetails,
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
  readonly usesSessionGrant?: boolean;
}

export interface LocalUnarySessionOptions<
  Registry extends VersionedRpcRegistry,
> {
  readonly key: string;
  readonly registry: Registry;
  readonly hostId: string;
  readonly directory: LocalUnarySessionDirectory<Registry>;
}

interface QueuedCall {
  readonly requestId: string;
  readonly method: string;
  readonly methodRegistry: MethodVersionRegistry;
  readonly params: unknown;
  readonly responseTimeoutMs: number;
  readonly options: HostRequestOptions;
  /** Set by `settle` before the caller is resumed, so a second completion is a no-op. */
  settled: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Removes the pre-send abort listener. Null once the call has left the queue. */
  abortListener: (() => void) | null;
}

type CallOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

type PreparedSend =
  | { readonly accepted: false; readonly error: unknown }
  | { readonly accepted: true; readonly done: Promise<unknown> };

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
 *
 * Every completion goes through `settle`: it drops the call, retires a
 * released session once nothing is queued, nothing is in flight, and no
 * dial hold remains, and only then resolves or rejects the caller.
 * `releaseIfIdle` uses that same predicate. A peer loss or a host fatal
 * retires even while a dial hold is outstanding, because the socket is
 * already gone. A discovery retry keeps its slot while a caller holds the
 * handoff it can act on. That caller converts the slot and reads the
 * release. Leaving without claiming passes the handoff on, or drops the
 * slot when nobody remains to dial it. A dial hold does not keep the slot.
 * A claim of a live ready session returns it. A claim of a dial still in
 * progress waits. A claim of a retry that still has a holder waits. A claim
 * that finds no holder dials that slot when waiters are still registered,
 * and otherwise starts a fresh dial that does not copy the release.
 * A connection-wide failure is deleted once nothing is waiting and no dial
 * hold remains. A later claim of a failed slot that still has a hold
 * removes it anyway: the failure was already delivered, and waiting would
 * deadlock. Callers already waiting at publish hold the dial, so this
 * settlement cannot close the socket before they enter.
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
  private readonly queue: QueuedCall[] = [];
  private readonly inFlight = new Map<string, InFlightCall>();
  private retired = false;
  /**
   * A release arrived. A call that claims this session after publish clears
   * it. A call admitted on the dial leaves it set. The flag stays on the
   * dial slot while a caller holds that slot's handoff. A claim of a live
   * ready slot returns that session. A claim of a dial that is still in
   * progress waits. A claim of a retry that still has a holder waits. A
   * claim that finds no holder dials that slot when waiters are still
   * registered, and otherwise starts a fresh dial that does not read this
   * flag. The socket closes once the admitted calls settle and every dial
   * hold has been released. A peer loss or a host fatal closes even while
   * a hold is still outstanding.
   */
  private closeWhenIdle = false;
  /** True while `pump` is dispatching, so `settle` cannot re-enter the loop. */
  private pumping = false;
  private usesSessionGrant = false;
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
    this.usesSessionGrant = attached.usesSessionGrant === true;
    this.suppressClose = false;
  }

  call<Method extends keyof Registry & string>(input: {
    readonly requestId: string;
    readonly method: Method;
    readonly params: RequestOfMethod<Registry, Method>;
    readonly responseTimeoutMs: number;
    readonly options: HostRequestOptions;
    /**
     * True for the discovering call and for a caller already waiting when
     * publish runs. Those calls keep a dial-time release. A call that
     * claims the session after publish passes false and clears it.
     */
    readonly boundToDialRelease: boolean;
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
    if (!input.boundToDialRelease) {
      this.closeWhenIdle = false;
    }
    const methodRegistry = this.registry[input.method];
    return new Promise((resolve, reject) => {
      const queued: QueuedCall = {
        requestId: input.requestId,
        method: input.method,
        methodRegistry,
        params: input.params,
        responseTimeoutMs: input.responseTimeoutMs,
        options: input.options,
        settled: false,
        resolve: (value) => {
          resolve(value as ResponseOfMethod<Registry, Method>);
        },
        reject,
        abortListener: null,
      };
      const onAbort = (): void => {
        this.settle(queued, { ok: false, error: abortedCall(queued, false) });
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
    if (this.pumping) {
      return;
    }
    const manifest = this.hostManifest;
    const connection = this.connection;
    if (manifest === null || connection === null) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (next === undefined) {
          return;
        }
        this.queue.shift();
        this.clearAbortListener(next);
        if (next.options.authority.abortSignal.aborted) {
          this.settle(next, { ok: false, error: abortedCall(next, false) });
          continue;
        }
        this.dispatch(next, connection, manifest);
      }
    } finally {
      this.pumping = false;
    }
  }

  private dispatch(
    call: QueuedCall,
    connection: MultiplexSocket,
    hostManifest: ConnectionManifest,
  ): void {
    const clientManifest = this.clientManifest;
    if (clientManifest === null) {
      this.settle(call, {
        ok: false,
        error: preSendRetryable(
          call.requestId,
          call.method,
          "Persistent session has no negotiated manifest",
        ),
      });
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
      this.settle(call, {
        ok: false,
        error: new HostMethodVersionUnsatisfiedError({
          requirement,
          negotiated: hostManifest[requirement.method],
          requestId: call.requestId,
          method: call.method,
          hostId: this.hostId,
        }),
      });
      return;
    }
    const clientCanonical = clientManifest[call.method];
    const hostCanonical = hostManifest[call.method];
    if (clientCanonical === undefined || hostCanonical === undefined) {
      void this.degrade(call, clientManifest, hostManifest, clientCanonical);
      return;
    }
    const sent = this.sendPrepared(
      call,
      connection,
      call.method,
      call.methodRegistry,
      clientCanonical,
      hostCanonical,
      call.params,
    );
    this.completeDirectSend(call, sent);
  }

  /** Completes a direct send. A degrade settles itself after adapting. */
  private completeDirectSend(call: QueuedCall, sent: PreparedSend): void {
    if (!sent.accepted) {
      this.settle(call, { ok: false, error: sent.error });
      return;
    }
    void sent.done.then(
      (value) => {
        this.settle(call, { ok: true, value });
      },
      (error: unknown) => {
        this.settle(call, { ok: false, error });
      },
    );
  }

  private async degrade(
    call: QueuedCall,
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
          this.sendForDegrade(
            call,
            input.method,
            input.methodRegistry,
            input.clientCanonical,
            input.hostCanonical,
            input.params,
          ),
      });
      this.settle(call, { ok: true, value });
    } catch (cause) {
      this.settle(call, { ok: false, error: cause });
    }
  }

  /**
   * The degrade helper awaits this and is the call's only completion, so the
   * caller observes the adapted value. The wire promise is not settled here.
   */
  private sendForDegrade(
    call: QueuedCall,
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
    const sent = this.sendPrepared(
      call,
      connection,
      wireMethod,
      methodRegistry,
      clientCanonical,
      hostCanonical,
      params,
    );
    if (!sent.accepted) {
      return Promise.reject(sent.error);
    }
    return sent.done;
  }

  /**
   * Writes the request once and returns the promise the response settles.
   * The call is in flight before the write, so a close that races the write
   * still settles it as uncertain rather than as a second send.
   */
  private sendPrepared(
    call: QueuedCall,
    connection: MultiplexSocket,
    wireMethod: string,
    methodRegistry: MethodVersionRegistry,
    clientCanonical: SchemaVersion,
    hostCanonical: SchemaVersion,
    params: unknown,
  ): PreparedSend {
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
      return { accepted: false, error: cause };
    }
    const wireKey =
      call.options.idempotencyKey !== null && this.idempotency
        ? call.options.idempotencyKey
        : null;
    if (call.options.replayMustBeKeyed && wireKey === null) {
      return {
        accepted: false,
        error: transportFailureBeforeSend({
          message: `Host '${this.hostId}' cannot honour the idempotency key a replay of '${call.method}' requires`,
          requestId: call.requestId,
          method: call.method,
        }),
      };
    }
    let token: string | undefined;
    try {
      // A team socket already spent its grant at OPEN. Its admitted context
      // serves every request; neither a replayed grant nor a user bearer belongs here.
      token = this.usesSessionGrant
        ? undefined
        : readBearer(call.options.authority, call.requestId, call.method);
    } catch (cause) {
      return { accepted: false, error: cause };
    }
    if (this.inFlight.has(call.requestId)) {
      return {
        accepted: false,
        error: new HostRpcError({
          code: "RPC_ERROR",
          message: `Duplicate request id '${call.requestId}' on the persistent session`,
          requestId: call.requestId,
          method: call.method,
          fatalDetails: null,
        }),
      };
    }
    const abortListener = (): void => {
      this.cancelSent(call.requestId);
    };
    return {
      accepted: true,
      done: new Promise((resolve, reject) => {
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
            ...(token === undefined ? {} : { token }),
            cloudAuthorized: call.options.authority.cloudAuthorized?.(),
          });
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          this.rejectInFlight(
            entry,
            preSendRetryable(
              call.requestId,
              call.method,
              `Persistent session failed before the request was sent: ${message}`,
            ),
          );
        }
      }),
    };
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
        const doorReason = frame.error.doorReason;
        // The host's own code and reason: `keys_unavailable` keeps its state.
        const refusal: FatalErrorDetails = {
          code: frame.error.code,
          reason: frame.error.message,
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
          ...(doorReason === undefined ? {} : { doorReason }),
        };
        this.rejectInFlight(
          entry,
          new RetryableTransportError({
            code,
            message: frame.error.message,
            requestId: entry.requestId,
            method: entry.method,
            fatalDetails: refusal,
            doorRefusal: doorReason === undefined ? null : refusal,
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
        this.settle(queuedCall, {
          ok: false,
          error: hostFatalError(
            frame,
            queuedCall.requestId,
            queuedCall.method,
            "beforeRequest",
          ),
        });
      }
      this.directory.fail(this.key, this);
    } else {
      this.failQueued(null);
    }
    this.retireIfUnoccupied(true);
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
    this.retireIfUnoccupied(true);
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

  /**
   * One completion for `call`. Drops it if it is still queued, then retires
   * a released session when nothing remains, and only then resumes the caller
   * so an awaited result observes the closed socket.
   */
  private settle(call: QueuedCall, outcome: CallOutcome): void {
    if (call.settled) {
      return;
    }
    call.settled = true;
    this.dropQueued(call.requestId);
    this.pump();
    this.retireIfReleased();
    if (outcome.ok) {
      call.resolve(outcome.value);
    } else {
      call.reject(outcome.error);
    }
  }

  /** `error` null means each call fails as a pre-send retry, because it was never written. */
  private failQueued(error: HostRpcError | null): void {
    const pending = this.queue.splice(0, this.queue.length);
    for (const call of pending) {
      this.clearAbortListener(call);
      this.settle(call, {
        ok: false,
        error:
          error ??
          preSendRetryable(
            call.requestId,
            call.method,
            "Persistent session closed before the request was sent",
          ),
      });
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

  /**
   * Records a release that arrived before publish. The discovering call
   * is queued immediately after this, so the session stays up until the
   * calls admitted on this dial settle and their dial holds drop.
   */
  retainDialRelease(): void {
    this.closeWhenIdle = true;
  }

  releaseIfIdle(): void {
    this.closeWhenIdle = true;
    this.retireIfUnoccupied(false);
  }

  /** A waiter admitted before publish released its hold. */
  onDialHoldReleased(): void {
    this.retireIfReleased();
  }

  private retireIfReleased(): void {
    if (!this.closeWhenIdle) {
      return;
    }
    this.retireIfUnoccupied(false);
  }

  /**
   * Queue empty, nothing in flight, and — unless `terminal` — no dial hold.
   * `terminal` is a peer loss or a host fatal: the socket is already gone,
   * so a hold must not keep the session published.
   */
  private retireIfUnoccupied(terminal: boolean): void {
    if (this.retired) {
      return;
    }
    if (this.queue.length > 0 || this.inFlight.size > 0) {
      return;
    }
    if (!terminal && this.directory.dialHoldCount(this.key) > 0) {
      return;
    }
    this.retired = true;
    this.closeSocket();
    this.directory.release(this.key, this);
  }

  private clearAbortListener(call: QueuedCall): void {
    const listener = call.abortListener;
    if (listener === null) {
      return;
    }
    call.abortListener = null;
    call.options.authority.abortSignal.removeEventListener("abort", listener);
  }
}

/** The slot a discovery retry handed to the waiter that resumes it. */
export interface SessionHandoff {
  readonly identity: object;
}

export type SessionGateResult<Registry extends VersionedRpcRegistry> =
  | { readonly kind: "ready"; readonly session: LocalUnarySession<Registry> }
  | { readonly kind: "legacy" }
  | { readonly kind: "failed"; readonly error: HostRpcError }
  | { readonly kind: "retry"; readonly handoff: SessionHandoff };

/** Releases one dial hold. A second call does nothing. */
export interface DialHold {
  release(): void;
}

export type SessionAdmission<Registry extends VersionedRpcRegistry> =
  | { readonly kind: "ready"; readonly session: LocalUnarySession<Registry> }
  | { readonly kind: "legacy" }
  | {
      readonly kind: "wait";
      readonly settled: Promise<SessionGateResult<Registry>>;
      /** Drops this waiter. An abort calls this, so a dead resolver is not drained. */
      leave(): void;
      /**
       * Drops a handoff this waiter was given and did not claim. An abort
       * calls this before `leave`. The last such holder passes the handoff
       * to a waiter that has none, or drops the slot when nobody remains.
       */
      relinquish(): void;
    }
  | { readonly kind: "owner"; readonly publish: SessionPublisher<Registry> };

export interface SessionPublisher<Registry extends VersionedRpcRegistry> {
  ready(session: LocalUnarySession<Registry>): void;
  legacy(): void;
  failed(error: HostRpcError): void;
  retry(): void;
}

interface SessionSlot<Registry extends VersionedRpcRegistry> {
  phase: "dialing" | "ready" | "legacy" | "retry" | "failed";
  session: LocalUnarySession<Registry> | null;
  waiters: Array<(result: SessionGateResult<Registry>) => void>;
  /** Stable for this object. A handed retry matches it; a later slot does not. */
  readonly identity: object;
  /**
   * Set when `releaseIdle` runs while this slot has no session. The object
   * stays while a caller holds its handoff. That caller reads the flag
   * here. A claim that finds no holder, and the claim that drops a failed
   * slot, start a fresh dial and do not copy it.
   */
  releaseBeforeReady: boolean;
  /**
   * Outstanding dial holds. They keep a published session from retiring,
   * and a failed dial until the last one releases. They do not keep a
   * retry slot.
   */
  dialHolds: number;
  /**
   * Callers that were handed this slot's retry and have not claimed or
   * left. A dial hold is not one of these. The slot stays while this is
   * non-zero.
   */
  handoffHolders: number;
}

/**
 * Binds a caller to the session for its host and identity synchronously.
 * The first caller in a tick owns the dial; everyone else waits on that
 * dial instead of opening a second socket.
 *
 * A discovery retry keeps its slot while a caller holds the handoff it can
 * act on. Delivery writes that handoff onto the waiter before a later
 * continuation can observe an abort. That waiter converts the slot when it
 * claims. If it leaves without claiming, it passes the handoff to a waiter
 * that has none, or drops the slot when nobody remains to dial it. A dial
 * hold does not keep the slot. A claim of a live ready session returns it.
 * A claim of a dial still in progress waits. A claim of a retry that still
 * has a holder waits. A claim that finds no holder dials this slot when
 * waiters are still registered, and otherwise starts a fresh dial that does
 * not copy the release. A connection-wide failure is deleted once nothing
 * is waiting and no dial hold remains. A later claim of a failed slot that
 * still has a hold removes it anyway: the failure was already delivered,
 * and waiting would deadlock.
 */
export class LocalUnarySessionDirectory<Registry extends VersionedRpcRegistry> {
  private readonly slots = new Map<string, SessionSlot<Registry>>();

  claim(
    key: string,
    handoff: SessionHandoff | null,
  ): SessionAdmission<Registry> {
    const existing = this.slots.get(key);
    if (existing === undefined) {
      return this.beginDial(key);
    }
    if (
      handoff !== null &&
      handoff.identity === existing.identity &&
      existing.handoffHolders > 0
    ) {
      existing.handoffHolders -= 1;
    }
    if (
      existing.phase === "ready" &&
      existing.session !== null &&
      !existing.session.isRetired
    ) {
      return { kind: "ready", session: existing.session };
    }
    if (existing.phase === "ready" || existing.phase === "failed") {
      if (existing.phase === "failed") {
        existing.releaseBeforeReady = false;
      }
      this.deleteIfUnoccupied(key, existing);
      if (this.slots.get(key) === existing) {
        // The failure was already delivered, and nobody republishes it.
        // Waiting here would deadlock the next caller. The flag is cleared
        // above, so this fresh dial is not armed. Holds still close over
        // the detached object and cannot remove the replacement.
        this.slots.delete(key);
      }
      return this.beginDial(key);
    }
    // openAck carries no host version and no instance id, so a host whose
    // ack omitted the session stays one socket per call for this process.
    // A later upgrade under the same URL is not on an ack we already hold.
    if (existing.phase === "legacy") {
      return { kind: "legacy" };
    }
    if (existing.phase === "retry") {
      if (handoff !== null && handoff.identity === existing.identity) {
        existing.phase = "dialing";
        existing.session = null;
        return { kind: "owner", publish: this.publisher(key, existing) };
      }
      if (existing.handoffHolders > 0) {
        return this.wait(key, existing);
      }
      if (existing.waiters.length > 0) {
        existing.phase = "dialing";
        existing.session = null;
        return { kind: "owner", publish: this.publisher(key, existing) };
      }
      this.slots.delete(key);
      return this.beginDial(key);
    }
    return this.wait(key, existing);
  }

  releaseIdle(): void {
    for (const slot of this.slots.values()) {
      if (slot.session !== null) {
        slot.session.releaseIfIdle();
        continue;
      }
      if (
        slot.phase === "dialing" ||
        slot.phase === "retry" ||
        slot.phase === "failed"
      ) {
        slot.releaseBeforeReady = true;
      }
    }
  }

  /**
   * Arms the dial a caller now owns with a release that ran before that
   * caller could claim: it was still looking up its host-only token. The
   * release then applies at publish, as it would had the claim come first.
   */
  armReleaseBeforeReady(key: string): void {
    const slot = this.slots.get(key);
    if (slot !== undefined && slot.session === null) {
      slot.releaseBeforeReady = true;
    }
  }

  /**
   * Takes the dial-time release for `session`, once, at publish. False
   * when this slot was not released, or when `session` is no longer the
   * one it published.
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

  /** Callers already waiting on `key`. Zero when that slot is gone. */
  dialHoldCount(key: string): number {
    return this.slots.get(key)?.dialHolds ?? 0;
  }

  /**
   * Holds `key` until `release`. The hold is on this slot object. A retry
   * keeps the object and does not zero the count, so a second waiter's
   * release still decrements this dial. The waiter releases the hold
   * before it claims the replacement, while `session` is still null, so
   * that release does not retire the replacement.
   */
  acquireDialHold(key: string): DialHold {
    const slot = this.slots.get(key);
    if (slot === undefined) {
      return { release: () => {} };
    }
    slot.dialHolds += 1;
    let open = true;
    return {
      release: () => {
        if (!open) {
          return;
        }
        open = false;
        slot.dialHolds -= 1;
        if (slot.session !== null) {
          slot.session.onDialHoldReleased();
          return;
        }
        // A hold does not keep a retry slot. The caller that was handed
        // the slot claims it, or passes the handoff on when it leaves.
        // A failed slot has nothing to hand on, so the last release
        // removes it once nobody is waiting.
        if (slot.phase === "failed") {
          this.deleteIfUnoccupied(key, slot);
        }
      },
    };
  }

  /** No waiter is still registered, and no dial hold is still outstanding. */
  private deleteIfUnoccupied(
    key: string,
    slot: SessionSlot<Registry>,
  ): boolean {
    if (slot.waiters.length > 0 || slot.dialHolds > 0) {
      return false;
    }
    if (this.slots.get(key) !== slot) {
      return false;
    }
    this.slots.delete(key);
    return true;
  }

  private wait(
    key: string,
    slot: SessionSlot<Registry>,
  ): SessionAdmission<Registry> {
    let resolveWait: (result: SessionGateResult<Registry>) => void = () => {};
    const settled = new Promise<SessionGateResult<Registry>>((resolve) => {
      resolveWait = resolve;
    });
    let held = false;
    const resolver = (result: SessionGateResult<Registry>): void => {
      if (result.kind === "retry") {
        held = true;
        slot.handoffHolders += 1;
      }
      resolveWait(result);
    };
    slot.waiters.push(resolver);
    return {
      kind: "wait",
      settled,
      leave: () => {
        const index = slot.waiters.indexOf(resolver);
        if (index < 0) {
          return;
        }
        slot.waiters.splice(index, 1);
      },
      relinquish: () => {
        if (!held) {
          return;
        }
        held = false;
        if (slot.handoffHolders > 0) {
          slot.handoffHolders -= 1;
        }
        this.settleUnheldRetry(key, slot);
      },
    };
  }

  /**
   * The last holder of a retry left without claiming. Wake a waiter that
   * has no handoff, or drop the slot when nobody remains to dial it.
   */
  private settleUnheldRetry(key: string, slot: SessionSlot<Registry>): void {
    if (this.slots.get(key) !== slot || slot.phase !== "retry") {
      return;
    }
    if (slot.handoffHolders > 0) {
      return;
    }
    if (slot.waiters.length > 0) {
      this.deliverRetry(slot);
      return;
    }
    this.slots.delete(key);
  }

  private deliverRetry(slot: SessionSlot<Registry>): void {
    const handoff: SessionHandoff = { identity: slot.identity };
    const waiters = slot.waiters.splice(0, slot.waiters.length);
    for (const waiter of waiters) {
      waiter({ kind: "retry", handoff });
    }
  }

  private beginDial(key: string): SessionAdmission<Registry> {
    const slot: SessionSlot<Registry> = {
      phase: "dialing",
      session: null,
      waiters: [],
      identity: {},
      releaseBeforeReady: false,
      dialHolds: 0,
      handoffHolders: 0,
    };
    this.slots.set(key, slot);
    return { kind: "owner", publish: this.publisher(key, slot) };
  }

  private publisher(
    key: string,
    slot: SessionSlot<Registry>,
  ): SessionPublisher<Registry> {
    let sealed = false;
    const finish = (result: SessionGateResult<Registry>): void => {
      const waiters = slot.waiters.splice(0, slot.waiters.length);
      for (const waiter of waiters) {
        waiter(result);
      }
    };
    const accept = (): boolean => {
      if (sealed || slot.phase !== "dialing") {
        return false;
      }
      sealed = true;
      return true;
    };
    return {
      ready: (session) => {
        if (!accept()) {
          return;
        }
        slot.phase = "ready";
        slot.session = session;
        finish({ kind: "ready", session });
      },
      legacy: () => {
        if (!accept()) {
          return;
        }
        slot.phase = "legacy";
        finish({ kind: "legacy" });
      },
      failed: (error) => {
        if (!accept()) {
          return;
        }
        slot.phase = "failed";
        slot.session = null;
        finish({ kind: "failed", error });
        // The failure was delivered. Nothing converts this slot. Drop it
        // once no hold remains; a hold still on it deletes the slot when
        // that hold releases.
        if (slot.dialHolds === 0 && this.slots.get(key) === slot) {
          this.slots.delete(key);
        }
      },
      retry: () => {
        if (!accept()) {
          return;
        }
        slot.session = null;
        // A hold is not a holder. Delivery writes the handoff onto each
        // waiter before this returns, so an empty waiter list still keeps
        // the slot while one of those records remains. No holder and no
        // waiter means nobody can dial this object.
        if (slot.waiters.length === 0 && slot.handoffHolders === 0) {
          if (this.slots.get(key) === slot) {
            this.slots.delete(key);
          }
          return;
        }
        slot.phase = "retry";
        finish({ kind: "retry", handoff: { identity: slot.identity } });
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
