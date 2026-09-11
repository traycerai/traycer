import {
  browserSessionsServerFrameSchema,
  type BrowserSessionsClientFrame,
  type BrowserSessionsOpenRequest,
  type BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { browserSessionsServerFrameSchemaV10 } from "@traycer/protocol/host/browser/contracts-v1";
import type { HostResourceScope } from "@traycer/protocol/host/resource-scope";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON,
  liftBrowserSessionsServerFrameFromV10,
  projectBrowserSessionsClientFrameToV10,
  subscribeAtScopeAddressedBrowserVersion,
} from "./browser-contracts-v1-bridge";
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
   *
   * Always in the LIVE frame shape, whichever major was negotiated - a `@1`
   * frame is lifted before it gets here (see `browser-contracts-v1-bridge`),
   * and the one frame this client answers by itself arrives through the same
   * callback so a consumer has a single place to correlate against.
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
 * ## Two majors, one caller-facing shape
 *
 * `browser.sessions` is served on `@1.0` (what the v1.3.0 release shipped,
 * addressed by `epicId`) and `@2.0` (the live line, addressed by a scope). This
 * client speaks both and hides the difference completely: callers pass the live
 * `scope` options and receive live frames, and everything version-dependent -
 * which open request goes on the wire, which schema parses a server frame, what
 * happens to a client frame `@1` has no spelling for - is decided HERE, per
 * session, off `session.getNegotiatedSchemaVersion()`.
 *
 * Per session rather than per client, and that is the whole reason the
 * selection sits in this file: several inventories can be open at once (an
 * epic's, the device's, a PiP fleet's, one per host) and a reconnect can
 * renegotiate one of them against a different host incarnation while its
 * siblings keep the version they had. Parsing at a sibling session's version is
 * exactly the skew this placement prevents.
 *
 * The `independent` scope is the one thing `@1` cannot express, and it is not
 * projected: {@link requireScopeAddressedSubscribe} pins `@2` for it, so a
 * v1.3.0 host fails the open through the ordinary fatal path (which the GUI
 * coordinator already renders as `lifecycle: "failed"`) rather than quietly
 * serving some epic's inventory under the Start Page's name.
 */
export class BrowserSessionsStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: BrowserSessionsStreamCallbacks;
  private closed: boolean;

  constructor(options: BrowserSessionsStreamClientOptions) {
    const { wsStreamClient, callbacks, ...openRequest } = options;
    this.callbacks = callbacks;
    this.closed = false;
    this.session = openSessionsSubscription(wsStreamClient, openRequest.scope);
    this.session.onServerFrame((envelope) => {
      this.handleServerFrame(envelope);
    });
    this.session.onStatusChange((status, reason) => {
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  sendClientFrame(frame: BrowserSessionsClientFrame): void {
    if (this.closed) return;
    if (!this.servingFrozenLine()) {
      this.session.sendClientFrame(frame, null);
      return;
    }
    const projected = projectBrowserSessionsClientFrameToV10(frame);
    if (projected.kind === "frame") {
      this.session.sendClientFrame(projected.frame, null);
      return;
    }
    // `attachTab` / `moveTab` reach a host that has no such frame. Sending one
    // is worse than useless - the frozen schema is `.strict()`, so a v1.3.0
    // host drops it at the parse and the coordinator's pending request waits
    // out its timeout with no answer at all. Answering here instead keeps the
    // one guarantee every request frame on this stream has: exactly one
    // `actionAck`, and a refusal carries the reason a user is shown.
    this.callbacks.onServerFrame({
      kind: "actionAck",
      hasBinaryPayload: false,
      requestId: projected.requestId,
      ok: false,
      reason: BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  /**
   * Whether this session negotiated the frozen `@1` line.
   *
   * `null` - the handshake has not settled, or a drop cleared it - reads as the
   * LIVE line, and nothing is lost by that: the transport drops an outbound
   * frame unless the session is subscribed, which is a state it only reaches
   * after recording the negotiated version, and no server frame can arrive
   * before it either.
   */
  private servingFrozenLine(): boolean {
    return this.session.getNegotiatedSchemaVersion()?.major === 1;
  }

  private handleServerFrame(envelope: StreamFrameEnvelope): void {
    if (this.servingFrozenLine()) {
      const parsedV10 = browserSessionsServerFrameSchemaV10.safeParse(envelope);
      if (!parsedV10.success) {
        this.warnMalformedFrame(envelope, parsedV10.error.issues);
        return;
      }
      this.callbacks.onServerFrame(
        liftBrowserSessionsServerFrameFromV10(parsedV10.data),
      );
      return;
    }
    const parsed = browserSessionsServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      this.warnMalformedFrame(envelope, parsed.error.issues);
      return;
    }
    this.callbacks.onServerFrame(parsed.data);
  }

  /**
   * Log the frame kind and issue paths only - never the raw envelope or
   * `parsed.error`, which carry page URLs, titles and captured storage state
   * inside whichever field failed to validate.
   */
  private warnMalformedFrame(
    envelope: StreamFrameEnvelope,
    issues: readonly { readonly path: PropertyKey[] }[],
  ): void {
    const issuePaths = issues
      .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)"))
      .join(", ");
    console.warn(
      `[stream] browser.sessions frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
    );
  }
}

function openSessionsSubscription(
  wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>,
  scope: HostResourceScope,
): IStreamSession {
  if (scope.kind === "independent") {
    return subscribeAtScopeAddressedBrowserVersion(
      wsStreamClient,
      "browser.sessions",
      { scope },
    );
  }
  // Read at each wire subscribe, including the re-declare after a reconnect,
  // because the major is a property of the CONNECTION: a reconnect can land on
  // a different host incarnation, and the request has to be re-shaped for
  // whatever that one serves rather than for whatever the first one did.
  const epicId = scope.epicId;
  return wsStreamClient.subscribeWithParamsProvider(
    "browser.sessions",
    (onWireVersion) => (onWireVersion?.major === 1 ? { epicId } : { scope }),
  );
}
