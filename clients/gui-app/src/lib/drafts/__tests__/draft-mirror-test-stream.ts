import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * A `drafts.subscribe` stream client that opens a session and then says
 * nothing. For suites that exercise the coordinator's UNARY paths (adoption,
 * stash publish/consume, list bookkeeping) and only need `acquireDraftMirrorSession`
 * to have something to subscribe against.
 *
 * Shared rather than re-stubbed per suite: the cast below is what lets a
 * partial session stand in for `IHostStreamClient`, and one copy of it means
 * a member the coordinator starts calling breaks in one place instead of
 * being silently absent in several.
 */
export function fakeDraftStreamClient(): IHostStreamClient<HostStreamRpcRegistry> {
  const session: IStreamSession = {
    sendClientFrame: () => undefined,
    onServerFrame: () => undefined,
    onStatusChange: () => undefined,
    requestReconnect: () => undefined,
    close: () => undefined,
    getNegotiatedSchemaVersion: () => ({ major: 1, minor: 0 }),
  };
  return { subscribe: () => session } as never;
}
