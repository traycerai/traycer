import type {
  BrowserSessionsServerFrame,
  BrowserSessionsUxClientFrame,
  BrowserSessionsUxServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { isBrowserSessionsJarServerFrame } from "@traycer/protocol/host/browser/contracts";
import { BrowserSessionsStreamClient } from "@traycer-clients/shared/host-transport/browser-sessions-stream-client";
import type {
  BrowserSessionsLifecycle,
  BrowserSessionsStreamKey,
  BrowserViewBridge,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import {
  browserSessionsError,
  browserSessionsLifecycle,
} from "@traycer-clients/shared/platform/browser-view";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";

export interface BrowserSessionsSessionCallbacks {
  readonly onStatus: (
    lifecycle: BrowserSessionsLifecycle,
    errorMessage: string | null,
  ) => void;
  readonly onFrame: (frame: BrowserSessionsUxServerFrame) => void;
  readonly onTabBound: (capability: BrowserViewNativeTabCapability) => void;
  readonly onTabReleased: (capability: BrowserViewNativeTabCapability) => void;
}

export interface BrowserSessionsSession {
  send(frame: BrowserSessionsUxClientFrame): void;
  close(): void;
}

export interface BrowserSessionsSessionArgs {
  readonly key: BrowserSessionsStreamKey;
  /**
   * Whether this renderer knows who it is signed in as yet. NOT sent to main,
   * which reads the signed-in user from the desktop auth session it owns; it
   * only decides whether asking is worth an IPC.
   */
  readonly userId: string | null;
  readonly browserView: BrowserViewBridge | null;
  readonly openTransport: (hostId: string) => DurableStreamTransport;
  readonly callbacks: BrowserSessionsSessionCallbacks;
}

/**
 * One `browser.sessions` stream as this renderer sees it.
 *
 * Two implementations, and which one you get is decided by whether this shell
 * has a desktop bridge:
 *
 *  - DESKTOP: main owns the socket and every cookie-bearing frame on it, and
 *    this renderer holds an IPC-backed view of the UX projection (H10).
 *  - EVERY OTHER SHELL (mobile, dev/browser): there is no main process and no
 *    jar on this machine, so the renderer opens the stream itself. It cannot
 *    receive a jar frame: the host only sends those to a subscriber that sent
 *    `electronTabLifecycleReady` and answered a desktop identity challenge,
 *    which needs a keystore this shell does not have. The projection below
 *    drops any it somehow saw rather than relying on that argument.
 */
export function openBrowserSessionsSession(
  args: BrowserSessionsSessionArgs,
): BrowserSessionsSession {
  const browserView = args.browserView;
  if (browserView === null) return openDirectSession(args);
  if (args.userId === null) {
    // UX only: main reads the signed-in user itself and would simply answer
    // nothing, so asking before this renderer knows who it is would spend an
    // IPC and show `connecting` either way. The coordinator restarts when the
    // identity arrives.
    return { send: () => undefined, close: () => undefined };
  }
  return openIpcSession(browserView, args);
}

function openIpcSession(
  browserView: BrowserViewBridge,
  args: BrowserSessionsSessionArgs,
): BrowserSessionsSession {
  const key = args.key;
  let closed = false;
  const subscription = browserView.onSessionsStreamEvent((envelope) => {
    if (closed || !sameStreamKey(envelope.key, key)) return;
    const event = envelope.event;
    switch (event.kind) {
      case "status":
        args.callbacks.onStatus(event.lifecycle, event.errorMessage);
        return;
      case "frame":
        args.callbacks.onFrame(event.frame);
        return;
      case "tabBound":
        args.callbacks.onTabBound(event.capability);
        return;
      case "tabReleased":
        args.callbacks.onTabReleased(event.capability);
        return;
      default: {
        // A new envelope kind is a COMPILE error here, not a tab release. The
        // old `default` read `event.capability` off whatever arrived, so an
        // added kind was delivered as a release and failed only if it happened
        // to lack that field. Same discipline the coordinator's frame router
        // states for the server-frame union.
        const unreachable: never = event;
        void unreachable;
      }
    }
  });
  void browserView.openSessionsStream(key).catch((cause: unknown) => {
    appLogger.warn("[browser] could not open the sessions stream", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    // Gated on `closed` the way the event handler above is: the open is an IPC
    // round trip, so its rejection can land after the coordinator closed this
    // session - and the coordinator reuses one `onStatus` closure across
    // incarnations, so a late `failed` from a dead session would be reported
    // against the live one that replaced it.
    if (closed) return;
    args.callbacks.onStatus("failed", "Browser sessions stream failed.");
  });
  return {
    send: (frame) => {
      if (closed) return;
      void browserView.sendSessionsFrame({ key, frame }).catch(ignoreSendError);
    },
    close: () => {
      if (closed) return;
      closed = true;
      subscription.dispose();
      void browserView.closeSessionsStream(key).catch(ignoreSendError);
    },
  };
}

function openDirectSession(
  args: BrowserSessionsSessionArgs,
): BrowserSessionsSession {
  const transport = args.openTransport(args.key.hostId);
  let stream: BrowserSessionsStreamClient | null = null;
  try {
    stream = new BrowserSessionsStreamClient({
      wsStreamClient: transport.wsStreamClient,
      epicId: args.key.epicId,
      callbacks: {
        onServerFrame: (frame) => {
          const ux = asUxServerFrame(frame);
          if (ux === null) return;
          args.callbacks.onFrame(ux);
        },
        onConnectionStatus: (status, reason) => {
          args.callbacks.onStatus(
            browserSessionsLifecycle(status, reason),
            browserSessionsError(status, reason),
          );
        },
      },
    });
  } catch (cause) {
    transport.close();
    throw cause;
  }
  const opened = stream;
  // The same post-close contract the IPC path has: a `send` after close is
  // ignored rather than pushed into a closed client, and a second `close` is a
  // no-op rather than a second close of the client and the transport. Both
  // implementations satisfy one interface, so they answer the same way.
  let closed = false;
  return {
    send: (frame) => {
      if (closed) return;
      opened.sendClientFrame(frame);
    },
    close: () => {
      if (closed) return;
      closed = true;
      opened.close();
      transport.close();
    },
  };
}

/**
 * The one narrowing on the direct path. A jar frame here would mean a host
 * treated a shell with no keystore as jar-authorized; it is dropped rather
 * than handled, because this shell has no jar to put it in.
 */
function asUxServerFrame(
  frame: BrowserSessionsServerFrame,
): BrowserSessionsUxServerFrame | null {
  // Membership in the protocol's own exclusion set, not a second copy of it:
  // the predicate narrows to exactly what `BrowserSessionsUxServerFrame`
  // excludes, so a new jar frame is dropped here the moment it is listed there.
  if (isBrowserSessionsJarServerFrame(frame)) {
    appLogger.warn("[browser] dropped a jar frame on a shell with no jar", {
      frameKind: frame.kind,
    });
    return null;
  }
  return frame;
}

function sameStreamKey(
  left: BrowserSessionsStreamKey,
  right: BrowserSessionsStreamKey,
): boolean {
  return (
    left.epicId === right.epicId &&
    left.hostId === right.hostId &&
    left.identityKey === right.identityKey
  );
}

function ignoreSendError(cause: unknown): void {
  appLogger.warn("[browser] a browser sessions request did not reach main", {
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}
