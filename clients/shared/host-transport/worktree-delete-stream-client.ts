import {
  worktreeDeleteByPathServerFrameSchema,
  type WorktreeDeleteByPathServerFrame,
  type WorktreeDeleteOutputChannel,
  type WorktreeDeletePhase,
} from "@traycer/protocol/host/worktree-delete-stream";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { WsStreamClient } from "./ws-stream-client";

/**
 * Typed handlers for a `worktree.deleteByPath@1.0` session. Frames flow
 * server → client only (apart from the heartbeat handled by `WsStreamClient`),
 * so there is no upstream application API on the wrapper.
 */
export interface WorktreeDeleteStreamCallbacks {
  /** First frame; `hasTeardown` says whether a teardown step will run. */
  readonly onStarted: (hasTeardown: boolean) => void;
  readonly onPhase: (phase: WorktreeDeletePhase) => void;
  readonly onOutput: (
    channel: WorktreeDeleteOutputChannel,
    chunk: string,
  ) => void;
  /** Terminal: the pipeline ran; `deleted` is the final outcome. */
  readonly onComplete: (deleted: boolean) => void;
  /** Terminal: the host declined (busy / unexpected error). */
  readonly onFailed: (reason: string) => void;
  /**
   * Connection-status changes. `reason` is non-null only on the `closed`
   * transition (e.g. an unreachable host, or a fatal handshake error).
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface WorktreeDeleteStreamClientOptions {
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly worktreePath: string;
  readonly scripts: WorktreeEntryScripts | null;
  readonly callbacks: WorktreeDeleteStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `worktree.deleteByPath@1.0`.
 *
 * Subscribing kicks off the host-side delete pipeline for `worktreePath`.
 * The wrapper Zod-parses each inbound envelope and dispatches to the typed
 * callback for its `kind`. There are no upstream application frames; closing
 * the session aborts the host-side run via the connection-scoped
 * `RequestContext` abort.
 */
export class WorktreeDeleteStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: WorktreeDeleteStreamCallbacks;
  private closed: boolean;

  constructor(options: WorktreeDeleteStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe("worktree.deleteByPath", {
      worktreePath: options.worktreePath,
      scripts: options.scripts,
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /**
   * Tears down the underlying session. Idempotent.
   */
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
    const parsed = worktreeDeleteByPathServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: WorktreeDeleteByPathServerFrame = parsed.data;
    switch (frame.kind) {
      case "started": {
        this.callbacks.onStarted(frame.hasTeardown);
        return;
      }
      case "phase": {
        this.callbacks.onPhase(frame.phase);
        return;
      }
      case "output": {
        this.callbacks.onOutput(frame.channel, frame.chunk);
        return;
      }
      case "complete": {
        this.callbacks.onComplete(frame.deleted);
        return;
      }
      case "failed": {
        this.callbacks.onFailed(frame.reason);
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
