import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";

/**
 * Builds a module-ownable host stream transport for a ONE-SHOT, side-effecting
 * host operation (Settings ▸ Worktrees `worktree.deleteByPath`) that must
 * OUTLIVE the React tile that started it - so a backgrounded delete keeps its
 * socket when the panel unmounts - but must NOT silently re-issue itself.
 *
 * Unlike `openDurableStreamTransport` (the chat / terminal / epic warm sessions)
 * this deliberately wires NONE of the proactive reconnect triggers:
 *  - no wake re-dial (`subscribeStreamWakeReconnect`),
 *  - no endpoint-change re-dial (`subscribeEndpointRedial`),
 *  - `auth: null`, so an `UNAUTHORIZED` rejection is terminal rather than a
 *    revalidate-then-redial.
 *
 * Every reconnect re-sends the stream's `subscribe` frame, which makes the host
 * re-run the subscribe handler. For a warm snapshot session that is harmless (it
 * re-snapshots); for a one-shot delete it would re-execute the teardown script
 * and git removal - duplicating side effects or failing an already-removed
 * worktree. So here a dropped socket surfaces the failure instead of being
 * papered over by a forced re-subscribe. `WsStreamClient` still owns its passive
 * backoff reconnect; the point is that nothing FORCES a reconnect that re-runs
 * the delete.
 *
 * `endpoint`/`bearer` are read live per dial so a credential rotation is
 * reflected. The returned `close()` tears down the socket; the owning delete run
 * calls it exactly once, when the delete settles or is cancelled.
 */
export function openOneShotStreamTransport(params: {
  readonly target: HostDirectoryEntry;
  /** The signed-in user this transport is built for (Architecture §4 / S1 cache key). */
  readonly userId: string;
  readonly endpoint: HostEndpointProvider;
  readonly bearer: BearerSourceProvider;
  readonly authnBaseUrl: string;
}): DurableStreamTransport {
  const wsStreamClient = buildHostStreamClient({
    target: params.target,
    endpoint: params.endpoint,
    bearer: params.bearer,
    authnBaseUrl: params.authnBaseUrl,
    auth: null,
    userId: params.userId,
    // Owned-lifetime transport: eager warm-connect is correct here.
    autoStart: true,
  });
  if (wsStreamClient === null) {
    // Only reachable for a remote target whose registry-published public key
    // does not decode (a corrupt row) — genuinely exceptional.
    throw new Error(
      `Remote host ${params.target.hostId} has an invalid public key; cannot open a one-shot stream`,
    );
  }
  appLogger.debug("[stream] one-shot transport opened", {
    hasEndpoint: params.endpoint() !== null,
  });
  return {
    wsStreamClient,
    close: () => {
      wsStreamClient.close("one-shot-transport-closed");
    },
  };
}
