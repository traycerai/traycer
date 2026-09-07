import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostEndpointProvider } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { buildHostStreamClient } from "@/hooks/host/use-host-stream-client-for";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { appLogger } from "@/lib/logger";

/**
 * Builds a module-ownable host stream transport for a ONE-SHOT, side-effecting host operation (Settings ▸ Worktrees `worktree.deleteByPath`) that must OUTLIVE the React tile that started it - so a backgrounded delete keeps its socket when the panel unmounts.
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
    // The whole point of this transport: a swept reconnect would replay the side-effecting subscribe (see the doc above), so the process-wide wake sweep must never poke or force-drop this session.
    proactiveWakeEligible: false,
    // Owned-lifetime transport: eager warm-connect is correct here.
    autoStart: true,
  });
  if (wsStreamClient === null) {
    // Two refusals map here: a remote target whose registry-published public key does not decode (a corrupt row), or the transport bearer gate finding no presentable credential (a null/released/empty lease - e.g. this delete racing a sign-out or a context handoff).
    throw new Error(
      `Cannot open a one-shot stream to remote host ${params.target.hostId}: no valid public key or presentable credential`,
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
