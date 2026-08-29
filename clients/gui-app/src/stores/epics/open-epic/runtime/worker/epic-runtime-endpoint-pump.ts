/**
 * Keeps the worker's dialable-endpoint replica current.
 *
 * The sibling of the bearer pump, and for the same structural reason: the
 * transport reads `HostEndpointProvider` SYNCHRONOUSLY inside a dial, so the
 * worker cannot pull it across a thread boundary and the main thread has to
 * push. The directory that answers it is a main-thread object with subscribers
 * all over the renderer; it does not move.
 *
 * What this pump does NOT do is decide what counts as a re-dial. The transport
 * already owns that judgement (`subscribeEndpointRedial` filters a directory
 * change down to a genuine MOVE to a new non-null endpoint, so the
 * high-frequency benign re-emits do not churn the socket), and that filter
 * travels into the worker with the transport, unchanged. Re-implementing it
 * here would make two deciders out of one, and the pump's copy would be the one
 * nobody updates.
 *
 * The dedupe below is therefore about POSTS, not about dials: the directory
 * rebuilds its entry on every `onLocalHostChange` - and on desktop it crosses
 * the IPC bridge as a fresh object each time - so an unfiltered pump would put
 * a `postMessage` on the path this whole relocation exists to keep quiet, for a
 * value that did not change.
 */
import type { HostTransportEndpoint } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";

export interface EndpointPumpOptions {
  /** The live read, as the main thread performs it today. */
  readonly endpoint: HostEndpointProvider;
  /**
   * Subscribes to host-directory changes, returning a disposer. Fires on ANY
   * change - the filtering that matters happens in the worker's transport.
   */
  readonly subscribeEndpointChange: (onChange: () => void) => () => void;
  /** Where a push goes. The bridge in production. */
  readonly push: (endpoint: HostTransportEndpoint | null) => void;
  /**
   * Reports a read that threw. Not optional and not swallowed, for the same
   * reason the bearer pump's is: this runs inside the directory's notification
   * loop, which iterates its subscribers without catching, so an escaping throw
   * would silently stop every other subscriber of that signal.
   */
  readonly onReadFailure: (cause: unknown) => void;
}

/**
 * Pushes the current endpoint immediately, then on every directory change.
 * Returns the unsubscribe.
 */
export function startEndpointPump(options: EndpointPumpOptions): () => void {
  let lastPushed: HostTransportEndpoint | null = null;
  let pushedOnce = false;

  const pushCurrent = (): void => {
    let next: HostTransportEndpoint | null;
    try {
      next = options.endpoint();
    } catch (cause: unknown) {
      options.onReadFailure(cause);
      // Fail closed: `null` is the value the transport already treats as "do
      // not dial", so a directory that threw parks the worker rather than
      // leaving it dialing the last address it happened to see.
      next = null;
    }
    if (pushedOnce && sameEndpoint(lastPushed, next)) return;
    lastPushed = next;
    pushedOnce = true;
    options.push(next);
  };

  // Subscribe FIRST, then take the snapshot - the bearer pump's ordering, for
  // the bearer pump's reason. A host that moved between the snapshot read and
  // the subscription would emit to nobody, and the worker would dial a dead
  // address until the NEXT directory change happened to arrive.
  //
  // `pushedOnce` rather than a `lastPushed !== null` guard: `null` is a
  // legitimate endpoint value ("not dialable right now"), so a nullable
  // sentinel cannot distinguish "never pushed" from "pushed null", and the
  // initial snapshot of a non-dialable host would be suppressed by its own
  // subscription callback.
  const unsubscribe = options.subscribeEndpointChange(() => {
    pushCurrent();
  });
  pushCurrent();

  return unsubscribe;
}

function sameEndpoint(
  left: HostTransportEndpoint | null,
  right: HostTransportEndpoint | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.hostId === right.hostId && left.websocketUrl === right.websocketUrl
  );
}
