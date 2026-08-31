import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { HOLDERS_REVISION_DIGEST_PATTERN } from "@traycer/protocol/host/worktree-schemas";
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

/**
 * Typed handlers for a `worktree.deleteByPath` session. Frames flow
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
  /**
   * Terminal: the host declined (busy / unexpected error). `holders` is the
   * T2 inventory on a 1.1+ busy `failed` frame; `undefined` when the host
   * omitted it (old host / non-busy failure). `code` is the @1.2 refusal
   * (`WORKTREE_BUSY` / `WORKTREE_HOLDERS_CHANGED`); `undefined` on 1.1.
   * `holdersRevision` is the host digest on a 1.2 frame; `undefined` when
   * omitted.
   */
  readonly onFailed: (
    reason: string,
    holders: readonly WorktreeBusyHolder[] | undefined,
    code: "WORKTREE_BUSY" | "WORKTREE_HOLDERS_CHANGED" | undefined,
    holdersRevision: string | undefined,
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
  /**
   * `worktree.deleteByPath@1.1`. `true` asks the host to stop enumerated
   * holders, then delete. Omitted/`false` is today's refuse-on-busy (a 1.0
   * host strips the field).
   */
  readonly stopOwners: boolean;
  /**
   * `worktree.deleteByPath@1.2` v2 consent. Present with `stopOwners:
   * true` is a digest compare against the fresh inventory before
   * teardown. Absent reproduces @1.1 (a 1.1 host strips the field).
   */
  readonly expectedHoldersRevision: string | undefined;
  readonly callbacks: WorktreeDeleteStreamCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `worktree.deleteByPath@1.2`.
 *
 * Subscribing kicks off the host-side delete pipeline for `worktreePath`.
 * The wrapper Zod-parses each inbound envelope and dispatches to the typed
 * callback for its `kind`. There are no upstream application frames; closing
 * the session aborts the host-side run via the connection-scoped
 * `RequestContext` abort. `stopOwners: false` is omitted from the open
 * request so a 1.0 subscribe stays byte-identical to today's payload.
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
      ...(options.stopOwners ? { stopOwners: true } : {}),
      ...(options.stopOwners &&
      options.expectedHoldersRevision !== undefined &&
      HOLDERS_REVISION_DIGEST_PATTERN.test(options.expectedHoldersRevision)
        ? { expectedHoldersRevision: options.expectedHoldersRevision }
        : {}),
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
        this.callbacks.onFailed(
          frame.reason,
          frame.holders,
          frame.code,
          frame.holdersRevision,
        );
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
