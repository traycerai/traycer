import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import {
  worktreeDeleteByPathServerFrameSchemaV12,
  type WorktreeDeleteByPathServerFrameV12,
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
import type { IStreamClient } from "./i-stream-client";

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
  readonly onFailed: (
    reason: string,
    holders: readonly WorktreeBusyHolder[] | undefined,
    code: "WORKTREE_BUSY" | "WORKTREE_HOLDERS_CHANGED" | undefined,
  ) => void;
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
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly worktreePath: string;
  readonly scripts: WorktreeEntryScripts | null;
  /** `worktree.deleteByPath@1.1`. */
  readonly stopOwners: boolean;
  readonly callbacks: WorktreeDeleteStreamCallbacks;
}

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
      ...(options.stopOwners ? { stopOwners: true } : {}),
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
    const parsed = worktreeDeleteByPathServerFrameSchemaV12.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: WorktreeDeleteByPathServerFrameV12 = parsed.data;
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
        this.callbacks.onFailed(frame.reason, frame.holders, frame.code);
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
