import { useEffect, useState } from "react";
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
 * request context, or no bound user - including transiently on first mount and
 * right after a dependency change, until the acquire effect below commits (see
 * that effect's doc comment for why the build lives there, not in a memo).
 * Callers should pass a referentially stable `target` (e.g. memoized by host
 * id) so an unrelated re-render does not needlessly rebuild the client.
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

  const [binding, setBinding] = useState<HostClientBinding | null>(null);

  // Builds AND starts the remote transport inside this one effect, rather
  // than a `useMemo` (as this hook did before S1's session cache): React can
  // invoke a `useMemo` factory more than once per committed render while
  // committing only one result - guaranteed in dev under `<StrictMode>`
  // (`clients/desktop/src/renderer-shell/main.tsx`), plausible in prod via a
  // discarded concurrent render - and a discarded factory run's return value
  // is thrown away with no cleanup hook of its own. That was harmless
  // pre-cache (each run built its own independent, unstarted `RemoteSession`
  // that GC reclaimed). Under the shared `(hostId, userId)` cache
  // (Architecture §4 / S1) it is NOT harmless: a discarded run still holds a
  // live reference (an incremented refCount) on the ONE shared session, and
  // nothing ever releases it, so the session's refCount can never return to
  // zero and it never tears down. An effect's cleanup, by contrast, is
  // guaranteed to run exactly once for exactly the committed acquire - a
  // discarded render never runs this effect at all - so every acquire this
  // hook makes has a guaranteed matching release.
  //
  // A StrictMode dev double-invoke of THIS effect (mount -> cleanup ->
  // remount) is safe by construction: cleanup releases the view (tearing the
  // shared session down at refCount 0, since `RemoteSession.close()` is
  // permanent - `start()` no-ops after), and the remount re-acquires a FRESH
  // session via the cache rather than reviving the closed one.
  useEffect(() => {
    if (target === null || target.websocketUrl === null) {
      setBinding(null);
      return;
    }
    if (requestContext === null || userId === null) {
      setBinding(null);
      return;
    }

    const bearer = () => globalClient.getRequestContext()?.credentials ?? null;

    const built = buildRawHostMessengerForTarget({
      target,
      userId,
      endpoint: () => target,
      registry,
      bearer,
      authnBaseUrl,
      requestId: defaultHostRpcRequestId,
    });
    if (built === null) {
      setBinding(null);
      return;
    }

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
    setBinding({ client, remoteTransport: built.remoteTransport });

    return () => {
      built.remoteTransport?.session.close();
    };
  }, [target, registry, requestContext, userId, globalClient, authnBaseUrl]);

  return binding?.client ?? null;
}
