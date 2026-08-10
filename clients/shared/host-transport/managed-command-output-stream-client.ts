import {
  managedCommandSubscribeOutputServerFrameSchema,
  type ManagedCommandLogLine,
  type ManagedCommandLogPosition,
  type ManagedCommandSubscribeOutputClientFrame,
  type ManagedCommandSubscribeOutputServerFrame,
} from "@traycer/protocol/host/managed-command/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export interface ManagedCommandOutputSnapshot {
  readonly command: ManagedCommand;
  readonly lines: readonly ManagedCommandLogLine[];
  readonly start: ManagedCommandLogPosition;
  readonly reachedStart: boolean;
}

export interface ManagedCommandOutputOlderWindow {
  readonly requestId: string;
  readonly lines: readonly ManagedCommandLogLine[];
  readonly start: ManagedCommandLogPosition;
  readonly reachedStart: boolean;
}

/**
 * Typed handlers for a `managedCommand.subscribeOutput@1.0` session - one
 * command's log as an interleaved timeline of output and lifecycle records.
 *
 * `onDeleted` does NOT end the session: the command's history is gone on the
 * host, but the window keeps the scrollback the viewer already has until the
 * human closes it.
 */
export interface ManagedCommandOutputStreamCallbacks {
  readonly onSnapshot: (snapshot: ManagedCommandOutputSnapshot) => void;
  readonly onOutput: (lines: readonly ManagedCommandLogLine[]) => void;
  readonly onOlder: (window: ManagedCommandOutputOlderWindow) => void;
  readonly onStatus: (command: ManagedCommand) => void;
  readonly onDeleted: () => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ManagedCommandOutputStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly commandId: string;
  readonly callbacks: ManagedCommandOutputStreamCallbacks;
}

/**
 * Typed wrapper over the host stream client for
 * `managedCommand.subscribeOutput@1.0`. The one upstream frame is `loadOlder`,
 * which pages backwards from a position the host itself minted.
 */
export class ManagedCommandOutputStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ManagedCommandOutputStreamCallbacks;
  private closed: boolean;

  constructor(options: ManagedCommandOutputStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe(
      "managedCommand.subscribeOutput",
      { epicId: options.epicId, commandId: options.commandId },
    );
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  loadOlder(frame: ManagedCommandSubscribeOutputClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    const parsed =
      managedCommandSubscribeOutputServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    const frame: ManagedCommandSubscribeOutputServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot({
          command: frame.command,
          lines: frame.lines,
          start: frame.start,
          reachedStart: frame.reachedStart,
        });
        return;
      }
      case "output": {
        this.callbacks.onOutput(frame.lines);
        return;
      }
      case "older": {
        this.callbacks.onOlder({
          requestId: frame.requestId,
          lines: frame.lines,
          start: frame.start,
          reachedStart: frame.reachedStart,
        });
        return;
      }
      case "status": {
        this.callbacks.onStatus(frame.command);
        return;
      }
      case "deleted": {
        this.callbacks.onDeleted();
        return;
      }
      case "pong": {
        // The stream client handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
