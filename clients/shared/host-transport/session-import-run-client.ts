import {
  sessionImportRunServerFrameSchema,
  type SessionImportRunCounts,
  type SessionImportRunServerFrame,
  type SessionImportOutcome,
} from "@traycer/protocol/host/session-import/run";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export interface SessionImportRunStartedPayload {
  readonly runId: string;
  readonly total: number;
  /** True when this subscription attached to a run already in flight. */
  readonly attached: boolean;
}

export interface SessionImportRunProgressPayload {
  readonly runId: string;
  readonly index: number;
  readonly total: number;
  readonly harness: GuiHarnessId;
  readonly nativeSessionId: string;
  readonly outcome: SessionImportOutcome;
}

export interface SessionImportRunCompletePayload {
  readonly runId: string;
  readonly counts: SessionImportRunCounts;
}

/** Typed handlers for a `sessionImport.run@1.0` session. */
export interface SessionImportRunCallbacks {
  readonly onStarted: (payload: SessionImportRunStartedPayload) => void;
  readonly onProgress: (payload: SessionImportRunProgressPayload) => void;
  readonly onComplete: (payload: SessionImportRunCompletePayload) => void;
  /** `reason` is non-null only on the `closed` transition. */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface SessionImportRunClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly selections: ReadonlyArray<SessionImportSelection>;
  readonly callbacks: SessionImportRunCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `sessionImport.run@1.0`.
 *
 * Closing this does NOT abort the host-side run - that is the contract's whole
 * point, since the user is told to walk away while the tour continues. Closing
 * only stops this client hearing about it, which is why the run's progress is
 * folded into a module-level store rather than a component's state.
 */
export class SessionImportRunClient {
  private readonly session: IStreamSession;
  private readonly callbacks: SessionImportRunCallbacks;
  private closed: boolean;

  constructor(options: SessionImportRunClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe("sessionImport.run", {
      selections: [...options.selections],
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Detaches from the run. The host keeps importing. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    const parsed = sessionImportRunServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: SessionImportRunServerFrame = parsed.data;
    switch (frame.kind) {
      case "started": {
        this.callbacks.onStarted({
          runId: frame.runId,
          total: frame.total,
          attached: frame.attached,
        });
        return;
      }
      case "progress": {
        this.callbacks.onProgress({
          runId: frame.runId,
          index: frame.index,
          total: frame.total,
          harness: frame.harness,
          nativeSessionId: frame.nativeSessionId,
          outcome: frame.outcome,
        });
        return;
      }
      case "complete": {
        this.callbacks.onComplete({
          runId: frame.runId,
          counts: frame.counts,
        });
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
