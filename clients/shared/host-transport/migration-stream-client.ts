import {
  migrationRunServerFrameSchema,
  type MigrationCompleteCounts,
  type MigrationRunServerFrame,
} from "@traycer/protocol/host/migration/run";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export type TaskChainProgressOutcome = "complete" | "skipped" | "failed";
export type EpicProgressOutcome = "complete" | "failed";
export type ReplayEntityKind = "chain" | "epic";

export interface MigrationStartedPayload {
  readonly totalTaskChains: number;
  readonly totalLocalEpics: number;
}

export interface TaskChainProgressPayload {
  readonly chainId: string;
  readonly index: number;
  readonly total: number;
  readonly outcome: TaskChainProgressOutcome;
}

export interface EpicProgressPayload {
  readonly epicId: string;
  readonly index: number;
  readonly total: number;
  readonly outcome: EpicProgressOutcome;
}

export interface ReplayProgressPayload {
  readonly entityId: string;
  readonly entityKind: ReplayEntityKind;
  readonly required: boolean;
  readonly completed: boolean;
}

export interface MigrationCompletePayload {
  readonly success: boolean;
  readonly counts: MigrationCompleteCounts;
}

export interface MigrationStreamCallbacks {
  readonly onStarted: (payload: MigrationStartedPayload) => void;
  readonly onTaskChainProgress: (payload: TaskChainProgressPayload) => void;
  readonly onEpicProgress: (payload: EpicProgressPayload) => void;
  readonly onReplayProgress: (payload: ReplayProgressPayload) => void;
  readonly onComplete: (payload: MigrationCompletePayload) => void;
  /**
   * Connection-status changes. `reason` is non-null only on the
   * `closed` transition.
   */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface MigrationStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: MigrationStreamCallbacks;
}

export class MigrationStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: MigrationStreamCallbacks;
  private closed: boolean;

  constructor(options: MigrationStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe("migration.run", {});
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
    const parsed = migrationRunServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: MigrationRunServerFrame = parsed.data;
    switch (frame.kind) {
      case "started": {
        this.callbacks.onStarted({
          totalTaskChains: frame.totalTaskChains,
          totalLocalEpics: frame.totalLocalEpics,
        });
        return;
      }
      case "taskChainProgress": {
        this.callbacks.onTaskChainProgress({
          chainId: frame.chainId,
          index: frame.index,
          total: frame.total,
          outcome: frame.outcome,
        });
        return;
      }
      case "epicProgress": {
        this.callbacks.onEpicProgress({
          epicId: frame.epicId,
          index: frame.index,
          total: frame.total,
          outcome: frame.outcome,
        });
        return;
      }
      case "replayProgress": {
        this.callbacks.onReplayProgress({
          entityId: frame.entityId,
          entityKind: frame.entityKind,
          required: frame.required,
          completed: frame.completed,
        });
        return;
      }
      case "complete": {
        this.callbacks.onComplete({
          success: frame.success,
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
