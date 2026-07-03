import { useEffect, useMemo } from "react";
import {
  HostClient,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { RemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/index";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostClient } from "@/lib/host/runtime";
import {
  buildRawHostMessengerForTarget,
  defaultHostRpcRequestId,
} from "@/lib/host/host-messenger";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * A transient client owns no host-scoped TanStack cache, so its invalidator
 * is inert: constructing or discarding one must never touch the global query
 * cache the active-host client manages.
 */
const NO_OP_INVALIDATOR: IHostQueryInvalidator = {
  invalidateHostScope: () => {},
};

interface HostClientBinding {
  readonly client: HostClient<HostRpcRegistry>;
  /**
   * The remote session backing this client, when `target.kind === "remote"`.
   * Held so the cleanup effect can close its persistent socket on teardown;
   * `null` for a local client (which holds no socket across calls).
   */
  readonly remoteTransport: RemoteHostTransport<
    HostRpcRegistry,
    HostStreamRpcRegistry
  > | null;
}

/**
 * Builds a throwaway `HostClient` that issues RPCs against a chosen host
 * WITHOUT `bind()`-ing it as the app-wide active host (which would reload the
 * Epic list and swap app-wide host state). Settings ▸ Worktrees uses it to
 * list / delete worktrees on whichever host the user selects.
 *
 * Transport selection is by `HostDirectoryEntry.kind` (net-new for remote):
 *  - `local`: a fresh `WsRpcClient` dials `target.websocketUrl` per request (the
 *    transport holds no socket across calls), so a second instance is cheap and
 *    side-effect-free.
 *  - `remote`: a persistent `RemoteSession` (Noise-NK + mux over one relay
 *    socket) behind a `RemoteHostMessenger`. The relay attach URL rides
 *    `target.websocketUrl` (populated by the directory once the host is
 *    connectable, S2/T14); the Noise host key is `target.publicKey`; grants are
 *    minted at `runnerHost.authnBaseUrl`. A cleanup effect closes the session's
 *    socket when the memo is replaced or the component unmounts.
 *
 * The bearer is the **shared** `RequestContext` from the global client - auth is
 * per-user, valid across hosts - so there is no separate sign-in. Wrapped in a
 * `HostClient` with a NO_OP invalidator, so `bind()` / `setRequestContext()`
 * (needed only to satisfy the request preflight) stay inert beyond this
 * instance's own state.
 *
 * Returns `null` when there is no target, no dialable endpoint, no authenticated
 * request context, or no bound user. Memoized on the target entry + auth
 * identity so the same selection yields a stable client across renders; callers
 * should pass a referentially stable `target` (e.g. memoized by host id).
 */
export function useHostClientFor(
  target: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  const globalClient = useHostClient();
  const runnerHost = useRunnerHost();
  const registry = globalClient.getRegistry();
  const requestContext = globalClient.getRequestContext();
  // `null` when signed out or the credential lease was released - the
  // "no bound user" gate.
  const userId = globalClient.getRequestContextUserId();
  const authnBaseUrl = runnerHost.authnBaseUrl;

  const binding = useMemo<HostClientBinding | null>(() => {
    if (target === null || target.websocketUrl === null) return null;
    if (requestContext === null || userId === null) return null;

    const bearer = () => globalClient.getRequestContext()?.credentials ?? null;

    const built = buildRawHostMessengerForTarget({
      target,
      endpoint: () => target,
      registry,
      bearer,
      authnBaseUrl,
      requestId: defaultHostRpcRequestId,
    });
    if (built === null) return null;

    const client = new HostClient<HostRpcRegistry>({
      registry,
      messenger: createRetryingMessenger<HostRpcRegistry>(
        built.messenger,
        DEFAULT_TRANSPORT_RETRY_POLICY,
      ),
      invalidator: NO_OP_INVALIDATOR,
    });
    client.bind(target);
    client.setRequestContext(requestContext);
    built.remoteTransport?.session.start();
    return { client, remoteTransport: built.remoteTransport };
  }, [target, registry, requestContext, userId, globalClient, authnBaseUrl]);

  // A remote binding owns a persistent socket; close it when replaced/unmounted.
  const remoteTransport = binding?.remoteTransport ?? null;
  useEffect(() => {
    if (remoteTransport === null) return;
    return () => remoteTransport.session.close();
  }, [remoteTransport]);

  return binding?.client ?? null;
}
