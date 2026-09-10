import {
  browserScreencastServerFrameSchema,
  type BrowserScreencastClientFrame,
  type BrowserScreencastOpenRequest,
  type BrowserScreencastServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  projectBrowserScreencastOpenRequestToV10,
  subscribeAtScopeAddressedBrowserVersion,
} from "./browser-contracts-v1-bridge";
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
 * Typed wrapper over one `browser.screencast` subscription - a
 * scope-authorized, tab-addressed media stream for a single viewer.
 *
 * ## Two majors, and only the OPEN differs
 *
 * `browser.screencast` is served on `@1.0` (the v1.3.0 release: addressed by
 * `epicId`, no placement handoff) and `@2.0` (the live line). Unlike its
 * sibling `browser.sessions`, the two lines' server and client FRAME unions are
 * identical - the whole divergence is the open request - so there is nothing to
 * lift here and every frame parses against the live schema on both. That is a
 * fact about the frozen contract, not an assumption: `contracts-v1.ts` names
 * exactly what the two lines differ on, and the protocol's own
 * `browser-contracts-v1-line` suite pins it.
 *
 * The open request is projected per session rather than per client, off the
 * version this session negotiated. Every viewer opens its own session (a tile,
 * a PiP mirror, a headless peek) and a reconnect may renegotiate one against a
 * new host incarnation, so a client-wide answer would describe some other
 * viewer's stream.
 *
 * The `independent` scope is pinned to `@2` instead of projected: `@1` can only
 * address an epic, and there is no honest epic to name for the device's
 * epic-less inventory - see {@link subscribeAtScopeAddressedBrowserVersion}.
 */
export class BrowserScreencastStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: BrowserScreencastStreamCallbacks;
  private closed: boolean;

  constructor(options: BrowserScreencastStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = openScreencastSubscription(wsStreamClient, openRequest);
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

function openScreencastSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  request: BrowserScreencastOpenRequest,
): IStreamSession {
  const scope = request.scope;
  if (scope.kind === "independent") {
    return subscribeAtScopeAddressedBrowserVersion(
      wsStreamClient,
      "browser.screencast",
      request,
    );
  }
  const epicId = scope.epicId;
  // Re-read at every wire subscribe: the major belongs to the CONNECTION, and a
  // reconnect can land on a host incarnation that serves the other one.
  return wsStreamClient.subscribeWithParamsProvider(
    "browser.screencast",
    (onWireVersion) =>
      onWireVersion?.major === 1
        ? projectBrowserScreencastOpenRequestToV10(request, epicId)
        : request,
  );
}
