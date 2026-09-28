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
import type { TimerHandle } from "./timer-handle";

export type WorktreeChangedStreamCallbacks = {
  /** True only after the active consumer has accepted the invalidation. */
  readonly onChanged: (scope: WorktreeChangedScope) => boolean;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
    negotiatedVersion: SchemaVersion | null,
  ) => void;
};

/**
 * The cursor of the last `changed` frame accepted by the active consumer,
 * held for one host by the
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

// The mount can be torn down by a capability notification rather than by a
// failed socket. That path bypasses the transport's reconnect backoff. Pace
// replacements sharing one host cursor so an effect feedback loop cannot dial
// sockets at renderer speed. A healthy session resets the ladder on close.
const RAPID_REOPEN_WINDOW_MS = 1_000;
const INITIAL_REOPEN_DELAY_MS = 250;
const MAX_REOPEN_DELAY_MS = 5_000;
type ReopenPacer = {
  lastClosedAtMs: number | null;
  nextDelayMs: number;
};
const reopenPacers = new WeakMap<WorktreeChangedCursorStore, ReopenPacer>();

export class WorktreeChangedStreamClient {
  private session: IStreamSession | null = null;
  private admissionTimer: TimerHandle | null = null;
  private openedAtMs: number | null = null;
  private readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  private readonly callbacks: WorktreeChangedStreamCallbacks;
  private readonly cursor: WorktreeChangedCursorStore;
  private readonly pacer: ReopenPacer;
  private closed = false;

  constructor(options: WorktreeChangedStreamClientOptions) {
    this.wsStreamClient = options.wsStreamClient;
    this.callbacks = options.callbacks;
    this.cursor = options.cursor;
    let pacer = reopenPacers.get(this.cursor);
    if (pacer === undefined) {
      pacer = { lastClosedAtMs: null, nextDelayMs: INITIAL_REOPEN_DELAY_MS };
      reopenPacers.set(this.cursor, pacer);
    }
    this.pacer = pacer;
    const elapsedSinceClose =
      pacer.lastClosedAtMs === null ? null : Date.now() - pacer.lastClosedAtMs;
    if (
      elapsedSinceClose === null ||
      elapsedSinceClose < 0 ||
      elapsedSinceClose >= RAPID_REOPEN_WINDOW_MS
    ) {
      pacer.nextDelayMs = INITIAL_REOPEN_DELAY_MS;
      this.startSession();
      return;
    }
    const delayMs = pacer.nextDelayMs;
    pacer.nextDelayMs = Math.min(MAX_REOPEN_DELAY_MS, delayMs * 2);
    this.admissionTimer = setTimeout(() => {
      this.admissionTimer = null;
      if (!this.closed) this.startSession();
    }, delayMs);
  }

  private startSession(): void {
    if (this.closed) return;
    // Re-read before every wire subscribe, reconnects included: the cursor
    // worth offering is the one from the frame received just before the drop,
    // not whatever was current when this client was built.
    const session = this.wsStreamClient.subscribeWithParamsProvider(
      "worktree.changed",
      (onWireVersion): WorktreeChangedOpenRequest => {
        const resume = this.cursor.current;
        return resume === null || !lineReadsResume(onWireVersion)
          ? {}
          : { resume };
      },
    );
    this.session = session;
    session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    session.onStatusChange((status, reason) => {
      if (status === "open") this.openedAtMs = Date.now();
      this.callbacks.onConnectionStatus(
        status,
        reason,
        session.getNegotiatedSchemaVersion(),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.admissionTimer !== null) {
      clearTimeout(this.admissionTimer);
      this.admissionTimer = null;
    }
    if (
      this.openedAtMs !== null &&
      Date.now() - this.openedAtMs >= RAPID_REOPEN_WINDOW_MS
    ) {
      this.pacer.nextDelayMs = INITIAL_REOPEN_DELAY_MS;
    }
    this.pacer.lastClosedAtMs = Date.now();
    this.session?.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    if (this.closed || binaryPayload !== null) return;
    const parsed = worktreeChangedServerFrameSchema.safeParse(envelope);
    if (parsed.success) {
      if (parsed.data.kind !== "changed") return;
      // A retired client can still hand over a buffered frame. Its callback
      // must reject it, leaving the cursor behind so reconnect replays it.
      if (this.callbacks.onChanged(parsed.data.scope)) {
        this.cursor.current = parsed.data.cursor;
      }
      return;
    }
    // A `@1.0` host sends no cursor, and always sends the catch-up.
    const legacy = worktreeChangedServerFrameSchemaV10.safeParse(envelope);
    if (!legacy.success || legacy.data.kind !== "changed") return;
    this.callbacks.onChanged(legacy.data.scope);
  }
}
