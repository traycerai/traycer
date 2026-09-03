import {
  browserSessionsServerFrameSchema,
  type BrowserSessionsClientFrame,
  type BrowserSessionsOpenRequest,
  type BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface BrowserSessionsStreamCallbacks {
  /**
   * One validated `browser.sessions` server frame. Handed over whole rather
   * than as a per-kind callback set: the stream's 15 kinds are consumed by a
   * single coordinator reducer, not by 15 independent listeners.
   */
  readonly onServerFrame: (frame: BrowserSessionsServerFrame) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export type BrowserSessionsStreamClientOptions = BrowserSessionsOpenRequest & {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly callbacks: BrowserSessionsStreamCallbacks;
};

/**
 * Typed wrapper over one `browser.sessions` subscription. `scope` is the
 * stream's sole authorization and routing scope, so one client speaks for one
 * epic's whole browser inventory, or for the device's epic-less `independent`
 * one - never for both.
 *
 * It has only `sendClientFrame`: request correlation (an `openTab` awaiting its
 * `openTabResult`, an `attachTab` or a `closeTab` awaiting its `actionAck`)
 * lives in the GUI's coordinator, which is the thing that owns the pending
 * maps and the timeouts. Adding a request method here would put half of one
 * correlation on each side of the process boundary the desktop draws through
 * this client.
 *
 * `browser.sessions` serves a single minor (`@1.0`) - when the first additive
 * minor lands, the per-session schema selection belongs in
 * `handleServerFrame`, keyed off `session.getNegotiatedSchemaVersion()` the
 * way `TerminalStreamClient` does it. Parsing against a sibling session's
 * minor is the failure that placing the parse here exists to prevent.
 */
export class BrowserSessionsStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: BrowserSessionsStreamCallbacks;
  private closed: boolean;

  constructor(options: BrowserSessionsStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = wsStreamClient.subscribe("browser.sessions", openRequest);
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  sendClientFrame(frame: BrowserSessionsClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    const parsed = browserSessionsServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      // Log the frame kind and issue paths only - never the raw envelope or
      // `parsed.error`, which carry page URLs, titles and captured storage
      // state inside whichever field failed to validate.
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] browser.sessions frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }
    this.callbacks.onServerFrame(parsed.data);
  }
}
