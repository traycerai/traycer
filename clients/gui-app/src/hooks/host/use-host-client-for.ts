import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  HostClient,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostClient } from "@/lib/host/runtime";

/**
 * Per-request WS frame timeout. Mirrors the value the global
 * `HostRuntimeProvider` builds its `WsRpcClient` with (that constant is
 * module-private there) so a transient client behaves identically on the wire;
 * the dial timeout is the shared `DEFAULT_DIAL_TIMEOUT_MS`.
 */
const FRAME_TIMEOUT_MS = 30_000;

// Stateless and shareable - hoisted to module scope so each transient client
// reuses one factory instead of allocating a throwaway per memo recompute
// (mirrors `browserStreamWebSocketFactory` in `use-host-stream-client-for`).
const browserWebSocketFactory = createWhatwgWebSocketFactory();

/**
 * A transient client owns no host-scoped TanStack cache, so its invalidator
 * is inert: constructing or discarding one must never touch the global query
 * cache the active-host client manages.
 */
const NO_OP_INVALIDATOR: IHostQueryInvalidator = {
  invalidateHostScope: () => {},
};

/**
 * Builds a throwaway `HostClient` that issues RPCs against a chosen host
 * WITHOUT `bind()`-ing it as the app-wide active host (which would reload the
 * Epic list and swap app-wide host state). Settings ▸ Worktrees uses it to
 * list / delete worktrees on whichever host the user selects.
 *
 * Mechanics:
 *  - A fresh `WsRpcClient` dials `target.websocketUrl` per request (the
 *    transport holds no socket across calls), so a second instance is cheap
 *    and side-effect-free.
 *  - The bearer is the **shared** `RequestContext` from the global client -
 *    auth is per-user, valid across hosts - so there is no separate sign-in.
 *  - Wrapped in a `HostClient` with a NO_OP invalidator, so `bind()` /
 *    `setRequestContext()` (needed only to satisfy the request preflight)
 *    stay inert beyond this instance's own state.
 *
 * Returns `null` when there is no target, no authenticated request context, or
 * no bound user. Memoized on the target entry + auth identity so the same
 * selection yields a stable client across renders; callers should pass a
 * referentially stable `target` (e.g. memoized by host id).
 */
export function useHostClientFor(
  target: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  const globalClient = useHostClient();
  const registry = globalClient.getRegistry();
  const requestContext = globalClient.getRequestContext();
  // `null` when signed out or the credential lease was released - the
  // "no bound user" gate.
  const userId = globalClient.getRequestContextUserId();

  return useMemo(() => {
    if (target === null || target.websocketUrl === null) return null;
    if (requestContext === null || userId === null) return null;

    const messenger = createRetryingMessenger<HostRpcRegistry>(
      new WsRpcClient<HostRpcRegistry>({
        registry,
        endpoint: () => target,
        // Read the bearer live so a credential-context replacement (not just an
        // in-place rotation) is picked up, matching the stream sibling hook.
        bearer: () => globalClient.getRequestContext()?.credentials ?? null,
        requestId: uuidv4,
        webSocketFactory: browserWebSocketFactory,
        dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
        frameTimeoutMs: FRAME_TIMEOUT_MS,
      }),
      DEFAULT_TRANSPORT_RETRY_POLICY,
    );
    const client = new HostClient<HostRpcRegistry>({
      registry,
      messenger,
      invalidator: NO_OP_INVALIDATOR,
    });
    client.bind(target);
    client.setRequestContext(requestContext);
    return client;
  }, [target, registry, requestContext, userId, globalClient]);
}
