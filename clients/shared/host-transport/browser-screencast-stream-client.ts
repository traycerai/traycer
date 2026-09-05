import {
  browserScreencastServerFrameSchema,
  type BrowserScreencastClientFrame,
  type BrowserScreencastOpenRequest,
  type BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface BrowserScreencastStreamCallbacks {
  /**
   * `jpegBytes` is the paired binary WS frame for a `frame` kind and null for
   * every text kind. Delivered as a separate parameter for the same reason
   * `TerminalStreamClient` does it: the payload arrives out-of-band, not as a
   * field on the envelope.
   *
   * Acking is deliberately the consumer's job - the host gates the next frame
   * on it, and a tile acks after paint while a PiP mirror acks on arrival.
   */
  readonly onServerFrame: (
    frame: BrowserScreencastServerFrame,
    jpegBytes: Uint8Array | null,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export type BrowserScreencastStreamClientOptions =
  BrowserScreencastOpenRequest & {
    readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
    readonly callbacks: BrowserScreencastStreamCallbacks;
  };

/**
 * Typed wrapper over one `browser.screencast` subscription - an
 * epic-authorized, tab-addressed media stream for a single viewer.
 *
 * `browser.screencast` serves a single minor (`@1.0`) - when the first
 * additive minor lands, the per-session schema selection belongs in
 * `handleServerFrame`, keyed off `session.getNegotiatedSchemaVersion()` the
 * way `TerminalStreamClient` does it. Every viewer opens its own session, so
 * parsing at a sibling viewer's minor is exactly the skew that placing the
 * parse here exists to prevent.
 */
export class BrowserScreencastStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: BrowserScreencastStreamCallbacks;
  private closed: boolean;

  constructor(options: BrowserScreencastStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = wsStreamClient.subscribe("browser.screencast", openRequest);
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  sendClientFrame(frame: BrowserScreencastClientFrame): void {
    if (this.closed) return;
    this.session.sendClientFrame(frame, null);
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
    const parsed = browserScreencastServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      // Issue paths only - a `dialogOpened` frame carries page-authored text
      // and `navState` carries the visited URL.
      const issuePaths = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0 ? issue.path.join(".") : "(root)",
        )
        .join(", ");
      console.warn(
        `[stream] browser.screencast frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
      );
      return;
    }
    this.callbacks.onServerFrame(parsed.data, binaryPayload);
  }
}
