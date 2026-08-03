import {
  managedCommandSubscribeListServerFrameSchema,
  type ManagedCommandSubscribeListServerFrame,
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

/**
 * Typed handlers for a `managedCommand.subscribeList@1.0` session - the
 * directory behind the "Monitors & Shells" section.
 *
 * The stream IS the list: `onSnapshot` replaces the view wholesale, then every
 * later frame is an upsert (`onChanged`) or a drop (`onRemoved`). Nothing is
 * persisted client-side, so a reconnect's fresh snapshot is the whole recovery
 * story.
 */
export interface ManagedCommandListStreamCallbacks {
  readonly onSnapshot: (commands: readonly ManagedCommand[]) => void;
  readonly onChanged: (command: ManagedCommand) => void;
  readonly onRemoved: (commandId: string) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface ManagedCommandListStreamClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly callbacks: ManagedCommandListStreamCallbacks;
}

/**
 * Typed wrapper over the host stream client for `managedCommand.subscribeList@1.0`.
 *
 * Opens one epic-scoped session on construction and dispatches each parsed
 * frame to its callback. There are no upstream application frames beyond the
 * transport's own heartbeat, so the surface is receive-plus-`close`.
 */
export class ManagedCommandListStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: ManagedCommandListStreamCallbacks;
  private closed: boolean;

  constructor(options: ManagedCommandListStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe(
      "managedCommand.subscribeList",
      { epicId: options.epicId },
    );
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Tears down the underlying session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    const parsed =
      managedCommandSubscribeListServerFrameSchema.safeParse(envelope);
    if (!parsed.success) return;
    const frame: ManagedCommandSubscribeListServerFrame = parsed.data;
    switch (frame.kind) {
      case "snapshot": {
        this.callbacks.onSnapshot(frame.commands);
        return;
      }
      case "changed": {
        this.callbacks.onChanged(frame.command);
        return;
      }
      case "removed": {
        this.callbacks.onRemoved(frame.commandId);
        return;
      }
      case "pong": {
        // The stream client handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
