import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  worktreeChangedServerFrameSchema,
  worktreeChangedServerFrameSchemaV10,
  type WorktreeChangedCursor,
  type WorktreeChangedOpenRequest,
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

/**
 * The cursor of the last `changed` frame received from one host, held by the
 * caller so it outlives a rebuilt client: a terminal close replaces the client,
 * and the replacement's first subscribe is exactly the reconnect the cursor is
 * for. Scope it to ONE host - another host's cursor proves nothing here, and
 * its epoch will not match anyway.
 */
export type WorktreeChangedCursorStore = {
  current: WorktreeChangedCursor | null;
};

export type WorktreeChangedStreamClientOptions = {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: WorktreeChangedStreamCallbacks;
  readonly cursor: WorktreeChangedCursorStore;
};

/** `@1.1` is the first line that reads `resume`; `null` is the newest line. */
function lineReadsResume(onWireVersion: SchemaVersion | null): boolean {
  if (onWireVersion === null) return true;
  return onWireVersion.major > 1 || onWireVersion.minor >= 1;
}

export class WorktreeChangedStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: WorktreeChangedStreamCallbacks;
  private readonly cursor: WorktreeChangedCursorStore;
  private closed = false;

  constructor(options: WorktreeChangedStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.cursor = options.cursor;
    // Re-read before every wire subscribe, reconnects included: the cursor
    // worth offering is the one from the frame received just before the drop,
    // not whatever was current when this client was built.
    this.session = options.wsStreamClient.subscribeWithParamsProvider(
      "worktree.changed",
      (onWireVersion): WorktreeChangedOpenRequest => {
        const resume = this.cursor.current;
        return resume === null || !lineReadsResume(onWireVersion)
          ? {}
          : { resume };
      },
    );
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
    if (parsed.success) {
      if (parsed.data.kind !== "changed") return;
      // Recorded before the callback: the frame is received, and whatever it
      // invalidates is scheduled here, before any later drop can lose it.
      this.cursor.current = parsed.data.cursor;
      this.callbacks.onChanged(parsed.data.scope);
      return;
    }
    // A `@1.0` host sends no cursor, and always sends the catch-up.
    const legacy = worktreeChangedServerFrameSchemaV10.safeParse(envelope);
    if (!legacy.success || legacy.data.kind !== "changed") return;
    this.callbacks.onChanged(legacy.data.scope);
  }
}
