import {
  worktreeChangedServerFrameSchema,
  type WorktreeChangedScope,
} from "@traycer/protocol/host/worktree-changed-stream";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export type WorktreeChangedStreamCallbacks = {
  readonly onChanged: (scope: WorktreeChangedScope) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
};

export type WorktreeChangedStreamClientOptions = {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: WorktreeChangedStreamCallbacks;
};

export class WorktreeChangedStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: WorktreeChangedStreamCallbacks;
  private closed = false;

  constructor(options: WorktreeChangedStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.session = options.wsStreamClient.subscribe("worktree.changed", {});
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (binaryPayload !== null) return;
    const parsed = worktreeChangedServerFrameSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.kind !== "changed") return;
    this.callbacks.onChanged(parsed.data.scope);
  }
}
