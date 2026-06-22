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
import type { WsStreamClient } from "./ws-stream-client";

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

/**
 * Typed handlers for a `migration.run@1.0` session.
 *
 * Symmetric to `NotificationsStreamCallbacks` - frames flow server → client
 * only (apart from the heartbeat handled by `WsStreamClient`), so there is
 * no upstream API on the wrapper.
 */
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
  readonly wsStreamClient: WsStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: MigrationStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `migration.run@1.0`.
 *
 * Subscribing kicks off the host-side migration run. The wrapper Zod-
 * parses each inbound envelope and dispatches to the typed callback for
 * its `kind`. There are no upstream application frames; closing the
 * underlying session aborts the host-side run via the connection-scoped
 * `RequestContext` abort, leaving any unmigrated entities retryable.
 */
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
