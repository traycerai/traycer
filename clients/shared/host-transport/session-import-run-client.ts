import {
  sessionImportRunServerFrameSchema,
  type SessionImportRunCounts,
  type SessionImportRunServerFrame,
  type SessionImportOutcome,
} from "@traycer/protocol/host/session-import/run";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamContinuity,
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
  /**
   * The run this client started ended while the connection was down, and its
   * own `complete` never arrived: the reconnect found the host idle, or busy
   * with a different run. Nothing more will arrive for it.
   */
  readonly onRunEndedUnseen: (runId: string | null) => void;
  /** `reason` is non-null only on the `closed` transition. */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface SessionImportRunClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly selections: ReadonlyArray<SessionImportSelection>;
  /** The mode every imported chat continues under - the client's new-chat default. */
  readonly permissionMode: PermissionMode;
  readonly callbacks: SessionImportRunCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `sessionImport.run@1.0`.
 *
 * Closing this does NOT abort the host-side run - that is the contract's whole
 * point, since the user is told to walk away while the tour continues. Closing
 * only stops this client hearing about it, which is why the run's progress is
 * folded into a module-level store rather than a component's state.
 *
 * ## Why this wrapper swaps its session after the first open
 *
 * `WsStreamClient` re-sends a session's original open request on every
 * reconnect. The host answers a subscribe that carries selections by starting
 * a run when none is going, so a replay after the run ended - its `complete`
 * sent but not yet handled, a renderer too busy to answer the heartbeat - is
 * a whole new import of the same selections. Each one streams a progress
 * frame per session to a client that is already behind, which drops it again.
 *
 * So the selections are sent once. The moment a session that reached the host
 * drops, it is closed and replaced by one with `selections: []`, which the
 * host treats as attach-only: it replays a run in flight, or answers an empty
 * run. Every later reconnect re-sends that. A drop before the host was ever
 * reached keeps the original request, which is the import the user asked for.
 */
export class SessionImportRunClient {
  private session: IStreamSession;
  private readonly callbacks: SessionImportRunCallbacks;
  private readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  private readonly permissionMode: PermissionMode;
  private mode: "start" | "attach";
  /** True once a session reached `open`: the host may have started the run. */
  private reachedHost: boolean;
  /** The run this client follows, from its first `started` frame. */
  private runId: string | null;
  /** Whether that run's own `complete` arrived. */
  private completed: boolean;
  /** Set once a reconnect showed the run is gone; nothing more is delivered. */
  private ended: boolean;
  /** Suppresses the status echo of a swap's own deliberate close. */
  private swapping: boolean;
  private closed: boolean;

  constructor(options: SessionImportRunClientOptions) {
    this.callbacks = options.callbacks;
    this.wsStreamClient = options.wsStreamClient;
    this.permissionMode = options.permissionMode;
    this.mode = "start";
    this.reachedHost = false;
    this.runId = null;
    this.completed = false;
    this.ended = false;
    this.swapping = false;
    this.closed = false;
    this.session = this.openSession(options.selections);
  }

  /** Detaches from the run. The host keeps importing. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  private openSession(
    selections: ReadonlyArray<SessionImportSelection>,
  ): IStreamSession {
    const session = this.wsStreamClient.subscribe("sessionImport.run", {
      selections: [...selections],
      permissionMode: this.permissionMode,
    });
    session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    session.onStatusChange((status, reason, _retryCause, continuity) => {
      this.handleStatusChange(status, reason, continuity);
    });
    return session;
  }

  /**
   * Runs inside the `reconnecting` transition, which `WsStreamClient` emits
   * before it arms the redial - so closing here cancels the pending replay of
   * the selections rather than racing it.
   */
  private swapToAttach(): void {
    this.mode = "attach";
    this.swapping = true;
    this.session.close();
    this.swapping = false;
    this.session = this.openSession([]);
  }

  private handleStatusChange(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
    continuity: StreamContinuity,
  ): void {
    if (this.closed || this.swapping) {
      return;
    }
    if (status === "open") {
      this.reachedHost = true;
    }
    if (
      status === "reconnecting" &&
      continuity !== "held" &&
      this.mode === "start" &&
      this.reachedHost
    ) {
      this.swapToAttach();
    }
    this.callbacks.onConnectionStatus(status, reason);
  }

  /**
   * An attach-only answer that is not this client's run: an empty run (the
   * host is idle) or a different one. After this run's own `complete` there
   * is nothing to tell; before it, the run ended unseen.
   */
  private answeredWithAnotherRun(runId: string, attached: boolean): boolean {
    if (this.mode !== "attach") return false;
    if (attached && (this.runId === null || runId === this.runId)) {
      return false;
    }
    if (!this.completed && !this.ended) {
      this.ended = true;
      this.callbacks.onRunEndedUnseen(this.runId);
    }
    return true;
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
    if (frame.kind !== "pong" && frame.kind !== "started") {
      // Frames of a run this client does not follow: the empty run's
      // `complete`, or another run's progress.
      if (this.ended || (this.runId !== null && frame.runId !== this.runId)) {
        return;
      }
    }
    switch (frame.kind) {
      case "started": {
        if (this.ended) return;
        if (this.answeredWithAnotherRun(frame.runId, frame.attached)) return;
        this.runId = frame.runId;
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
        this.completed = true;
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
