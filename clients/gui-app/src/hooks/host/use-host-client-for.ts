import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  HostClient,
  type IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { RemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/index";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useHostClient } from "@/lib/host/runtime";
import {
  buildRawHostMessengerForTarget,
  defaultHostRpcRequestId,
} from "@/lib/host/host-messenger";
import { useRunnerHost } from "@/providers/use-runner-host";

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

interface HostClientBinding {
  /**
   * The inputs this binding was built from. Compared against the hook's
   * current `target`/`requestContext`/`userId` on every render so a commit
   * that changes one of them never returns the PREVIOUS binding's client -
   * React re-renders with the new props before this hook's own effect has had
   * a chance to run and rebuild `binding`, so without this guard the hook
   * would hand back a client still bound to the old target for that one
   * render.
   */
  readonly target: HostDirectoryEntry;
  readonly requestContext: RequestContext;
  readonly userId: string;
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
 * Builds a throwaway `HostClient` that issues RPCs against `target`
 * WITHOUT `bind()`-ing it as the app-wide active host (which would reload the
 * Epic list and swap app-wide host state).
 *
 * LOCAL (AND MOCK) HOSTS ONLY: a fresh `WsRpcClient` dials
 * `target.websocketUrl` per request (the transport holds no socket across
 * calls), so a second instance is cheap and side-effect-free. A `remote`
 * target's `websocketUrl` is a relay attach URL, not a directly-dialable
 * local endpoint - reaching it needs the Noise-NK handshake + persistent
 * session that `useHostClientFor` below manages via an effect (start/close),
 * which this plain, one-shot function has no lifecycle hook to run. Fails
 * closed (returns `null`) for a `remote` target rather than handing back a
 * client that would dial the relay URL directly and never connect.
 *
 * The bearer is the **shared** `RequestContext` from `globalClient` -
 * auth is per-user, valid across hosts - so there is no separate sign-in.
 * Wrapped in a `HostClient` with a NO_OP invalidator, so `bind()` /
 * `setRequestContext()` (needed only to satisfy the request preflight)
 * stay inert beyond this instance's own state.
 *
 * Returns `null` when `target` is `remote`, has no websocket URL, or there is
 * no authenticated request context / bound user on `globalClient`. Plain
 * function (no hooks) so imperative call sites - a callback or `mutationFn`
 * invoked once per differing `hostId` - can resolve a routed client without
 * violating the rules of hooks.
 */
export function buildTransientHostClient(
  globalClient: HostClient<HostRpcRegistry>,
  target: HostDirectoryEntry,
): HostClient<HostRpcRegistry> | null {
  // Fail closed: a "remote" target's `websocketUrl` is a relay attach URL,
  // not a directly-dialable endpoint - reaching it needs the Noise-NK
  // handshake + persistent session `useHostClientFor` manages via an effect,
  // which this plain, one-shot function has no lifecycle hook to run. Never
  // fall through to the plain `WsRpcClient` branch below for one.
  if (target.kind === "remote") return null;
  if (target.websocketUrl === null) return null;
  const requestContext = globalClient.getRequestContext();
  // `null` when signed out or the credential lease was released - the
  // "no bound user" gate.
  const userId = globalClient.getRequestContextUserId();
  if (requestContext === null || userId === null) return null;

  const registry = globalClient.getRegistry();
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
 * Unlike `buildTransientHostClient` above (a plain, local-only, no-lifecycle
 * function for imperative call sites), this is a hook: only a hook can run the
 * effect that starts/closes a remote session, so it is the one to use for any
 * render-time consumer that might resolve a remote host.
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
    setBinding({
      target,
      requestContext,
      userId,
      client,
      remoteTransport: built.remoteTransport,
    });

    return () => {
      built.remoteTransport?.session.close();
    };
  }, [target, registry, requestContext, userId, globalClient, authnBaseUrl]);

  // Guard against the one-render window where `target`/`requestContext`/
  // `userId` have already changed but this hook's own effect (above) has not
  // yet run to rebuild `binding` for them - without this check, that render
  // would hand back the PREVIOUS binding's client as if it belonged to the
  // new inputs.
  if (
    binding === null ||
    binding.target !== target ||
    binding.requestContext !== requestContext ||
    binding.userId !== userId
  ) {
    return null;
  }
  return binding.client;
}
