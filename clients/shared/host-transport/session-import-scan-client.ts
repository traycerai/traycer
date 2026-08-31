import {
  sessionImportScanServerFrameSchema,
  type SessionImportScanServerFrame,
  type SessionImportScanTotals,
} from "@traycer/protocol/host/session-import/scan";
import type {
  SessionImportFailureReason,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IStreamClient } from "./i-stream-client";

export interface SessionImportProviderFailure {
  readonly harness: GuiHarnessId;
  readonly reason: SessionImportFailureReason;
  readonly detail: string;
}

/**
 * Typed handlers for a `sessionImport.scan@1.0` session. Frames flow
 * server → client only (apart from the heartbeat `WsStreamClient` owns), so
 * there is no upstream API on the wrapper.
 */
export interface SessionImportScanCallbacks {
  readonly onStarted: (providers: ReadonlyArray<GuiHarnessId>) => void;
  readonly onGroup: (group: SessionImportGroup) => void;
  readonly onProviderFailed: (failure: SessionImportProviderFailure) => void;
  readonly onComplete: (totals: SessionImportScanTotals) => void;
  /** `reason` is non-null only on the `closed` transition. */
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface SessionImportScanClientOptions {
  readonly wsStreamClient: IStreamClient<HostStreamRpcRegistry>;
  /** `null` scans every provider the host has a reader for. */
  readonly providers: ReadonlyArray<GuiHarnessId> | null;
  /** Epoch ms; sessions last active before this are not scanned. `null` scans everything. */
  readonly updatedAfter: number | null;
  readonly callbacks: SessionImportScanCallbacks;
}

/**
 * Typed wrapper over `WsStreamClient` for `sessionImport.scan@1.0`.
 *
 * Subscribing is what makes the host read the vendors' session directories -
 * there is no background scanning - so the wizard opens one of these when it
 * opens and closes it when it closes. Unlike the import run, a scan is
 * connection-scoped: nothing is lost by dropping it.
 */
export class SessionImportScanClient {
  private readonly session: IStreamSession;
  private readonly callbacks: SessionImportScanCallbacks;
  private closed: boolean;

  constructor(options: SessionImportScanClientOptions) {
    this.callbacks = options.callbacks;
    this.closed = false;

    this.session = options.wsStreamClient.subscribe("sessionImport.scan", {
      providers: options.providers === null ? null : [...options.providers],
      updatedAfter: options.updatedAfter,
    });
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  /** Tears down the underlying session. Idempotent. */
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
    const parsed = sessionImportScanServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      return;
    }
    const frame: SessionImportScanServerFrame = parsed.data;
    switch (frame.kind) {
      case "started": {
        this.callbacks.onStarted(frame.providers);
        return;
      }
      case "group": {
        this.callbacks.onGroup(frame.group);
        return;
      }
      case "providerFailed": {
        this.callbacks.onProviderFailed({
          harness: frame.harness,
          reason: frame.reason,
          detail: frame.detail,
        });
        return;
      }
      case "complete": {
        this.callbacks.onComplete(frame.totals);
        return;
      }
      case "pong": {
        // WsStreamClient handles pong internally for heartbeat bookkeeping.
        return;
      }
    }
  }
}
