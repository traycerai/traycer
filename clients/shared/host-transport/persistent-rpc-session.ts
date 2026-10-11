import {
  hostFrameSchema,
  PERSISTENT_RPC_IDLE_TIMEOUT_MS,
  PERSISTENT_RPC_MAX_RUNNING_REQUESTS,
  type FatalErrorDetails,
  type HostFrame,
} from "@traycer/protocol/framework/index";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "./host-messenger";
import type { WebSocketLike } from "./ws-factory";
import type { TimerHandle } from "./timer-handle";
import type { Session } from "./ws-rpc-client";

type PendingRequest = {
  readonly requestId: string;
  method: string;
  readonly resolve: (frame: HostFrame) => void;
  readonly reject: (error: HostRpcError) => void;
  sent: boolean;
  settled: boolean;
  canCancel: boolean;
  timer: TimerHandle | null;
};

/** Owns an already negotiated socket. A request's close only releases its waiter. */
export class PersistentRpcSession {
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;
  private retired = false;
  private closed = false;
  private idleTimer: TimerHandle | null = null;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly closeSocket: () => void,
    private readonly onClosed: () => void,
  ) {
    socket.onmessage = (event) => {
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        this.fail("Malformed persistent RPC frame", null);
        return;
      }
      const parsed = hostFrameSchema.safeParse(value);
      if (!parsed.success) {
        this.fail("Malformed persistent RPC frame", null);
        return;
      }
      this.receive(parsed.data);
    };
    socket.onclose = () => this.fail("Persistent RPC socket closed", null);
    socket.onerror = () => this.fail("Persistent RPC transport error", null);
    this.armIdleTimer();
  }

  get accepting(): boolean {
    return !this.retired && !this.closed;
  }

  retire(): void {
    this.retired = true;
    if (this.pending.size === 0)
      this.fail("Persistent RPC session retired", null);
  }

  receive(frame: HostFrame): void {
    if (this.closed) return;
    if (frame.kind === "fatalError") {
      this.fail(frame.details.reason, frame.details);
      return;
    }
    if (frame.kind !== "response") {
      this.fail("Unexpected handshake on persistent RPC session", null);
      return;
    }
    const pending = this.pending.get(frame.requestId);
    if (
      pending === undefined ||
      !pending.sent ||
      frame.method !== pending.method
    ) {
      this.fail("Uncorrelated persistent RPC response", null);
      return;
    }
    this.pending.delete(frame.requestId);
    this.settle(pending, frame, null);
    this.armIdleTimer();
  }

  request(
    requestId: string,
    method: string,
    canCancelAfterDispatch: (method: string) => boolean,
    beforeSend: () => void,
  ): Session {
    if (
      !this.accepting ||
      this.pending.size >= PERSISTENT_RPC_MAX_RUNNING_REQUESTS
    ) {
      throw new RetryableTransportError({
        code: "RPC_ERROR",
        message:
          "Persistent RPC session is unavailable or at its request limit",
        requestId,
        method,
        fatalDetails: null,
        replaySafetyFromKey: false,
      });
    }
    if (this.pending.has(requestId)) {
      throw new HostRpcError({
        code: "RPC_ERROR",
        message: "Duplicate RPC request ID",
        requestId,
        method,
        fatalDetails: null,
      });
    }
    this.clearIdleTimer();
    const response = new Promise<HostFrame>((resolve, reject) => {
      const pending: PendingRequest = {
        requestId,
        method,
        resolve,
        reject,
        sent: false,
        settled: false,
        canCancel: false,
        timer: null,
      };
      this.pending.set(requestId, pending);
    });
    // Abort/send can fail before the caller reaches next().
    void response.catch(() => {});
    const entry = this.pending.get(requestId);
    if (entry === undefined) throw new Error("RPC request was not registered");
    const cancel = (): void => {
      if (entry.sent && entry.canCancel && !this.closed) {
        try {
          this.socket.send(JSON.stringify({ kind: "cancel", requestId }));
        } catch {
          this.fail("Persistent RPC cancel send failed", null);
        }
      }
    };
    return {
      send: (frame) => {
        if (entry.settled) return;
        if (frame.kind !== "request" || entry.sent || !this.accepting) {
          this.settle(
            entry,
            null,
            this.failureFor(
              entry,
              "Persistent RPC request cannot be sent",
              null,
            ),
          );
          return;
        }
        beforeSend();
        entry.sent = true;
        entry.canCancel = canCancelAfterDispatch(frame.method);
        // Degrade dispatch can select a different wire method.
        entry.method = frame.method;
        this.sequence += 1;
        try {
          this.socket.send(
            JSON.stringify({ ...frame, sequence: this.sequence }),
          );
        } catch {
          this.fail("Persistent RPC request send failed", null);
        }
      },
      next: (timeoutMs) => {
        if (!entry.settled && entry.timer === null) {
          entry.timer = setTimeout(() => {
            this.settle(
              entry,
              null,
              new HostTransportFailureError({
                code: "RPC_ERROR",
                message: `WebSocket frame timed out after ${timeoutMs}ms`,
                requestId,
                method,
                fatalDetails: null,
              }),
            );
            cancel();
          }, timeoutMs);
        }
        return response;
      },
      abort: () => {
        if (entry.settled || (entry.sent && !entry.canCancel)) return;
        this.settle(
          entry,
          null,
          new HostRequestAbortedError({
            message: "Host request authority was aborted",
            requestId,
            method,
          }),
        );
        cancel();
      },
      close: () => {
        // Sent requests remain counted until the host's terminal receipt,
        // even if cancellation or a deadline already ended the caller's wait.
        if (!entry.sent) {
          this.pending.delete(requestId);
          this.armIdleTimer();
        }
      },
    };
  }

  private settle(
    pending: PendingRequest,
    frame: HostFrame | null,
    error: HostRpcError | null,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    if (error !== null) pending.reject(error);
    else if (frame !== null) pending.resolve(frame);
  }

  private failureFor(
    pending: PendingRequest,
    message: string,
    details: FatalErrorDetails | null,
  ): HostRpcError {
    // Session-wide failure cannot attest that any particular sent command
    // was never dispatched. Never promote it to an auth or keyed replay.
    if (pending.sent)
      return new HostTransportFailureError({
        code: "RPC_ERROR",
        message,
        requestId: pending.requestId,
        method: pending.method,
        fatalDetails: details,
      });
    return new RetryableTransportError({
      code: "RPC_ERROR",
      message,
      requestId: pending.requestId,
      method: pending.method,
      fatalDetails: details,
      replaySafetyFromKey: false,
    });
  }

  private fail(message: string, details: FatalErrorDetails | null): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    for (const pending of this.pending.values()) {
      this.settle(pending, null, this.failureFor(pending, message, details));
    }
    this.pending.clear();
    this.closeSocket();
    this.onClosed();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed || this.pending.size > 0) return;
    if (this.retired) {
      this.fail("Persistent RPC session drained", null);
      return;
    }
    this.idleTimer = setTimeout(
      () => this.retire(),
      PERSISTENT_RPC_IDLE_TIMEOUT_MS,
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
