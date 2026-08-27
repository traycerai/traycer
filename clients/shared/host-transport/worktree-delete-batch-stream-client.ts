import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import {
  worktreeDeleteBatchByPathServerFrameSchema,
  type WorktreeDeleteBatchByPathOpenRequest,
  type WorktreeDeleteBatchByPathServerFrame,
  type WorktreeDeleteBatchOutputChannel,
  type WorktreeDeleteBatchPhase,
  type WorktreeDeleteBatchTarget,
  type WorktreeDeletionSource,
} from "@traycer/protocol/host/worktree-delete-batch-stream";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export const WORKTREE_DELETE_BATCH_STREAM_METHOD = "worktree.deleteBatchByPath";

/**
 * Typed handlers for one `worktree.deleteBatchByPath@1.0` command. Frames flow
 * server → client only (apart from the transport heartbeat), so there is no
 * upstream application API on the wrapper.
 */
export interface WorktreeDeleteBatchStreamCallbacks {
  readonly onTargetStarted: (
    worktreePath: string,
    hasTeardown: boolean,
  ) => void;
  readonly onTargetPhase: (
    worktreePath: string,
    phase: WorktreeDeleteBatchPhase,
  ) => void;
  readonly onTargetOutput: (
    worktreePath: string,
    channel: WorktreeDeleteBatchOutputChannel,
    chunk: string,
  ) => void;
  /** Terminal for one target; `deleted` is its outcome. */
  readonly onTargetComplete: (worktreePath: string, deleted: boolean) => void;
  /** Terminal for one target; the host declined or the removal threw. */
  readonly onTargetFailed: (
    worktreePath: string,
    reason: string,
    holders: readonly WorktreeBusyHolder[] | undefined,
  ) => void;
  /** Terminal for the COMMAND, after every target settled. */
  readonly onCommandComplete: (counts: {
    readonly requestedCount: number;
    readonly deletedCount: number;
    readonly failedCount: number;
  }) => void;
  /** The host rejected the command before any target ran. */
  readonly onCommandFailed: (reason: string) => void;
  /**
   * The host does not implement this method at all - an older build.
   *
   * Delivered instead of a connection failure because the two demand opposite
   * responses: a failure means "the delete may have half-happened, tell the
   * user", while this means "nothing was attempted, run the older path". The
   * distinction is safe to act on because the compatibility check that
   * produces it runs on the openAck, BEFORE the subscribe frame - so the host
   * has not been asked to delete anything.
   */
  readonly onUnsupported: () => void;
  /**
   * Connection-status changes. `reason` is non-null only on the `closed`
   * transition. An unsupported-method close is reported through
   * `onUnsupported` instead and never reaches this handler.
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface WorktreeDeleteBatchStreamClientOptions {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  /** Client-minted UUID; identifies this command for single-flight reuse. */
  readonly commandId: string;
  readonly source: WorktreeDeletionSource;
  readonly targets: ReadonlyArray<WorktreeDeleteBatchTarget>;
  readonly callbacks: WorktreeDeleteBatchStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `worktree.deleteBatchByPath@1.0`.
 *
 * Subscribing opens ONE host-owned deletion command over every target. Unlike
 * the released single-target wrapper, closing this session does not stop the
 * work: the host keeps deleting and still writes the completion notification.
 * Closing means "stop telling me", which is what makes it safe to close a
 * Settings tab mid-bulk-delete.
 *
 * ## Why this wrapper owns a session SWAP
 *
 * `WsStreamClient` re-sends a session's original open request on every
 * reconnect, forever. For a destructive command that is not something the host
 * can fully defend against on its own: its single-flight map is process-local
 * and evicted a minute after completion, so a long outage or a host restart
 * would let an automatic re-subscribe execute the same command twice.
 *
 * So this wrapper never lets a `start` be the thing that gets replayed. It
 * subscribes once in `start` mode, and the moment that session drops AFTER
 * reaching the host, it closes it and opens a fresh session in `observe` mode
 * for the same `commandId`. Every subsequent reconnect - however many, however
 * long after - re-sends `observe`, which can attach to a live command but can
 * never create one.
 *
 * A drop BEFORE the session ever opened is left alone: the subscribe frame
 * never reached the host, so nothing was started and the transport's own
 * retry of `start` is both safe and the behaviour the user wants (a host that
 * was briefly unreachable still runs the delete they asked for).
 */
export class WorktreeDeleteBatchStreamClient {
  private session: IStreamSession;
  private readonly callbacks: WorktreeDeleteBatchStreamCallbacks;
  private readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  private readonly commandId: string;
  private mode: "start" | "observe";
  /**
   * True once a session reached `open`, which is the moment the subscribe
   * frame was handed to a live socket - i.e. the first instant the host may
   * have created the command.
   */
  private reachedHost: boolean;
  /** Suppresses the `closed` callback from a swap's own deliberate close. */
  private swapping: boolean;
  private closed: boolean;
  private reportedUnsupported: boolean;

  constructor(options: WorktreeDeleteBatchStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.wsStreamClient = options.wsStreamClient;
    this.commandId = options.commandId;
    this.mode = "start";
    this.reachedHost = false;
    this.swapping = false;
    this.closed = false;
    this.reportedUnsupported = false;

    this.session = this.openSession({
      mode: "start",
      commandId: options.commandId,
      source: options.source,
      targets: options.targets.map((target) => ({
        worktreePath: target.worktreePath,
        scripts: target.scripts,
      })),
    });
  }

  /** Tears down the underlying session. Idempotent. Detaches; never cancels. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.session.close();
  }

  private openSession(
    params: WorktreeDeleteBatchByPathOpenRequest,
  ): IStreamSession {
    const session = this.wsStreamClient.subscribe(
      "worktree.deleteBatchByPath",
      params,
    );
    session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    session.onStatusChange((status, reason) => {
      this.handleStatusChange(status, reason);
    });
    return session;
  }

  /**
   * Replaces the `start` session with an `observe` one for the same command.
   *
   * Runs inside the `reconnecting` transition, which `WsStreamClient` emits
   * BEFORE it arms the redial timer - so closing here cancels the pending
   * re-subscribe rather than racing it, and the `start` request can never go
   * out a second time.
   */
  private swapToObserve(): void {
    this.mode = "observe";
    this.swapping = true;
    this.session.close();
    this.swapping = false;
    this.session = this.openSession({
      mode: "observe",
      commandId: this.commandId,
    });
  }

  private handleStatusChange(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    if (this.closed) {
      return;
    }
    // Our own swap close, echoed back through the session we just closed.
    if (this.swapping) {
      return;
    }
    if (status === "open") {
      this.reachedHost = true;
      this.callbacks.onConnectionStatus(status, reason);
      return;
    }
    // `getMethodSupport` is set to `unsupported` by the handshake immediately
    // before it closes the session, so it is already authoritative here.
    // Read it rather than pattern-matching the fatal-error details: support is
    // the transport's own answer to "does this host have the method", while
    // the details string is a human-readable summary that may change.
    if (
      status === "closed" &&
      reason !== null &&
      this.wsStreamClient.getMethodSupport(
        WORKTREE_DELETE_BATCH_STREAM_METHOD,
      ) === "unsupported"
    ) {
      if (this.reportedUnsupported) return;
      this.reportedUnsupported = true;
      this.callbacks.onUnsupported();
      return;
    }
    if (
      status === "reconnecting" &&
      this.mode === "start" &&
      this.reachedHost
    ) {
      this.swapToObserve();
      // Still a reconnect from the consumer's point of view: the run stays
      // live and waits for the observe session to land.
      this.callbacks.onConnectionStatus(status, reason);
      return;
    }
    this.callbacks.onConnectionStatus(status, reason);
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    const parsed =
      worktreeDeleteBatchByPathServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: WorktreeDeleteBatchByPathServerFrame = parsed.data;
    switch (frame.kind) {
      case "target.started": {
        this.callbacks.onTargetStarted(frame.worktreePath, frame.hasTeardown);
        return;
      }
      case "target.phase": {
        this.callbacks.onTargetPhase(frame.worktreePath, frame.phase);
        return;
      }
      case "target.output": {
        this.callbacks.onTargetOutput(
          frame.worktreePath,
          frame.channel,
          frame.chunk,
        );
        return;
      }
      case "target.complete": {
        this.callbacks.onTargetComplete(frame.worktreePath, frame.deleted);
        return;
      }
      case "target.failed": {
        this.callbacks.onTargetFailed(
          frame.worktreePath,
          frame.reason,
          undefined,
        );
        return;
      }
      case "command.complete": {
        this.callbacks.onCommandComplete({
          requestedCount: frame.requestedCount,
          deletedCount: frame.deletedCount,
          failedCount: frame.failedCount,
        });
        return;
      }
      case "command.failed": {
        this.callbacks.onCommandFailed(frame.reason);
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
