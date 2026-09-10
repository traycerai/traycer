import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { useAuthService, useHostClient } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useOpenEpicId } from "@/lib/epic-selectors";
import {
  isEpicParked,
  retryDeferredEpicParks,
  subscribeEpicParking,
} from "@/lib/epics/epic-parking";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ChatStreamClientFactory,
} from "@/stores/chats/chat-session-store";
import {
  ChatSessionRegistry,
  DEFAULT_CHAT_IDLE_TTL_MS,
} from "@/stores/chats/session-registry";
import {
  BROWSER_STREAM_FLUSH_TIMERS,
  createStreamFlushCoordinator,
} from "@/stores/chats/stream-flush-coordinator";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { setEpicChatWorkProbe } from "@/stores/epics/open-epic/session-registry";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

const registry = new ChatSessionRegistry({
  idleTtlMs: DEFAULT_CHAT_IDLE_TTL_MS,
  // The shell's retention profile (desktop: `DEFAULT_MAX_WARM_CHAT_SESSIONS`),
  // read on every cap walk so the phone's smaller pool applies whenever its
  // bootstrap selected it.
  maxWarmSessions: () => getRetentionProfile().maxWarmChatSessions,
});

/**
 * Coalesce streamed `blockDelta` events onto the animation frame so a fast
 * turn renders at the display refresh rate instead of once per token - the
 * fix for the renderer heap sawtooth during streaming. One process-wide
 * coordinator serves every chat store: N concurrently-streaming chats share a
 * single rAF tick, a 500ms timeout fallback keeps draining buffers while the
 * window is hidden/minimized (rAF is starved there), and chats whose surfaces
 * are all hidden flush at the slow tier instead of every frame.
 */
const STREAM_FLUSH_COORDINATOR = createStreamFlushCoordinator(
  BROWSER_STREAM_FLUSH_TIMERS,
);
const CHAT_SESSION_SCOPE_SEPARATOR = "\u0000";

/** Passed to `reconnectAll` so a hand-driven wake is distinguishable in logs. */
const CHAT_SESSION_WAKE_REASON = "user-retry";

const handleHostIds = new WeakMap<ChatSessionStoreHandle, string | null>();

let streamClientFactoryOverride: ChatStreamClientFactory | null = null;

export function __setChatStreamClientFactoryForTests(
  factory: ChatStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function __getChatSessionRegistryForTests(): ChatSessionRegistry {
  return registry;
}

/**
 * The process-wide chat session registry for this window. Used by the
 * agent-activity monitor to aggregate run state across every live chat
 * session.
 */
export function getChatSessionRegistry(): ChatSessionRegistry {
  return registry;
}

// The cross-plane wiring for a park verdict, both halves anchored HERE because
// this module is downstream of both: it already imports `epic-parking`, which
// imports the open-epic registry, so it can reach either without closing a
// cycle - and neither of them can reach the chat registry without one.
//
// Registering the probe is what lets `canPark` see a chat holding work before
// the epic-level decision force-disposes it; the subscription is the other half
// and is not optional. A park refused for chat work waits on the OPEN-EPIC
// registry's signal, which an epic with no session entry never emits, so
// without this the refusal is permanent for exactly the epics whose chats
// caused it.
setEpicChatWorkProbe((epicId) => registry.unsettledWorkForEpic(epicId));
registry.subscribe(() => {
  retryDeferredEpicParks();
});

export function getChatSessionHandleHostId(
  handle: ChatSessionStoreHandle,
): string | null {
  return handleHostIds.get(handle) ?? null;
}

export function disposeAllChatSessions(): void {
  registry.disposeAll();
}

/**
 * Renderer parking (plan C, decision C1): a parked epic holds no
 * `chat.subscribe`.
 *
 * Wired here, on the plane that OWNS chat sessions, rather than called from
 * the parking module - so that module stays a near-leaf that knows about
 * visibility, a clock and the epic session registry, and each plane answers
 * for its own subscriptions. It is also what makes the release complete
 * without the tiles' cooperation: a chat tile releasing its lease leaves the
 * session WARM with its websocket open for `DEFAULT_CHAT_IDLE_TTL_MS`, and one
 * surviving subscription keeps the epic visible-leased on the host, which is
 * the whole thing parking exists to end.
 *
 * Module-scoped and never torn down, matching the registry singleton it acts
 * on. `isEpicParked` is re-read rather than trusted from the notification: the
 * signal fires on both edges and only the parked one releases anything.
 */
subscribeEpicParking((epicId) => {
  if (!isEpicParked(epicId)) return;
  registry.disposeForEpic(epicId);
});

export function useChatSessionHandle(
  chatId: string,
  hostId: string,
  enabled: boolean,
): ChatSessionStoreHandle | null {
  const epicId = useOpenEpicId();
  const hostEntry = useHostDirectoryEntry(hostId);
  // Chat is a DURABLE per-tab stream: its `WsStreamClient` is OWNED by the
  // session store for the session's warm lifetime, NOT by this tile, so closing
  // the tab (tile unmount) no longer `.close()`s the socket and strands the warm
  // session with a dead transport (the "send disabled after reopen" bug). The
  // opener wires the shared "durable stream = auth + wake" recovery; the returned
  // handle's `close()` tears it all down when the session disposes.
  const globalClient = useHostClient();
  const authService = useAuthService();
  const authServiceRef = useRef(authService);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const openTransport = useDurableStreamTransportFactory();
  const queryClient = useQueryClient();

  // Transport identity for the scope key + readiness gate. The test seam is a
  // clearly separate top-level branch; the production identity is derived by the
  // shared `authenticatedHostStreamKey` ONLY when the factory is not
  // overridden, so tests drive the stream through the override and never touch
  // the real request context.
  const transportKey =
    streamClientFactoryOverride !== null
      ? "test-stream-client-factory"
      : authenticatedHostStreamKey(globalClient, hostEntry);
  // Owner-identity discriminator (R-1): `transportKey` deliberately omits a
  // remote host's public key (dialability, not identity), so a same-host
  // remote public-key rotation would otherwise leave this session pinned to
  // a `ChatStreamClient` built against the stale key. Folded into the scope
  // key alongside `transportKey`, not in place of it, so every existing
  // rebuild trigger (host swap, user switch, endpoint dialability) is
  // preserved unchanged.
  const ownerIdentityKey =
    streamClientFactoryOverride !== null
      ? "test-stream-client-factory"
      : authenticatedOwnerIdentityKey(globalClient, hostEntry);

  const [handle, setHandle] = useReducer(
    (
      _state: ChatSessionStoreHandle | null,
      next: ChatSessionStoreHandle | null,
    ) => next,
    null,
  );

  useEffect(() => {
    authServiceRef.current = authService;
  }, [authService]);

  useEffect(() => {
    // Gate the subscribe on the caller's readiness (e.g. the chat record exists
    // in the epic projection). Until then we do not `registry.acquire`, so the
    // `ChatStreamClient` - and its eager `chat.subscribe` - is never constructed
    // and cannot open the epic before the create has seeded it.
    if (!enabled) {
      setHandle(null);
      return;
    }
    // `transportKey` is null until there is an authenticated request context and
    // a dialable host endpoint (or "test-..." when the factory is overridden).
    // `ownerIdentityKey` is null under that same gate (both derive from the
    // same `globalClient` + `hostEntry`), so this never masks a ready session
    // behind a not-yet-known identity.
    if (transportKey === null || ownerIdentityKey === null) {
      setHandle(null);
      return;
    }
    const scopeKey = chatSessionScopeKey({
      epicId,
      chatId,
      userId,
      hostId,
      transportKey,
      ownerIdentityKey,
    });

    // The session OWNS its transport: the factory builds it (socket + auth +
    // wake), and the returned handle's `close()` tears all of it down. Because
    // the registry only closes the handle when it DISPOSES the session (not on
    // tile unmount), the socket stays alive across close -> warm -> reopen, so a
    // revived session is never handed a dead transport. `retry()` re-invokes
    // this factory, rebuilding the transport with live deps.
    let acquiredHandle: ChatSessionStoreHandle | null = null;
    // The socket THIS chat's stream rides, captured as the transport is built.
    // A mutable slot rather than a value because `retry()` re-invokes the
    // factory and builds a new one: a wake must reach whichever socket is
    // current, not the one that existed when the session was first opened.
    // `null` until the first build, and on the override path, where no
    // transport of ours exists to wake.
    let boundStreamClient: IHostStreamClient<HostStreamRpcRegistry> | null =
      null;
    const factory: ChatStreamClientFactory = (
      factoryEpicId,
      factoryChatId,
      callbacks,
    ) => {
      if (streamClientFactoryOverride !== null) {
        return streamClientFactoryOverride(
          factoryEpicId,
          factoryChatId,
          callbacks,
        );
      }
      // `openOwnedDurableStreamClient` owns the transport for the typed
      // client's lifetime: `result.close` tears down both, and a synchronous
      // throw in `new ChatStreamClient` (it subscribes on the socket) closes
      // the half-built transport so its socket and wake listeners never leak.
      const result = openOwnedDurableStreamClient(
        openTransport,
        hostId,
        (ws) => {
          boundStreamClient = ws;
          return new ChatStreamClient({
            wsStreamClient: ws,
            epicId: factoryEpicId,
            chatId: factoryChatId,
            callbacks,
          });
        },
        () => acquiredHandle?.store.getState().retry(),
      );
      return {
        sendAction: (frame) => result.client.sendAction(frame),
        close: result.close,
        sameTurnSteeringProtocolSupported: () =>
          result.client.sameTurnSteeringProtocolSupported(),
        requestTranscriptRange: (request) =>
          result.client.requestTranscriptRange(request),
        requestResnapshot: () => result.client.requestResnapshot(),
        interviewSettlementActionsProtocolSupported: () =>
          result.client.interviewSettlementActionsProtocolSupported(),
      };
    };

    const onAuthError = (): void => {
      void authServiceRef.current.revalidateCurrentContext();
    };

    // A `code: "auth"` error frame means the tab's provider CLI signed out. The
    // host has already poisoned its auth cache, so a PLAIN invalidate (not a
    // `forceAuthRefresh`, which would re-run the flaky probe) makes
    // `providers.list` refetch and read that poisoned `unauthenticated`. Scoped
    // to this chat's host - the host the turn runs on.
    const onProviderAuthError = (): void => {
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "providers.list"),
      });
    };

    const next = registry.acquire(
      { epicId, chatId, hostId, scopeKey },
      (factoryEpicId, factoryChatId) =>
        createChatSessionStore({
          hostId,
          epicId: factoryEpicId,
          chatId: factoryChatId,
          userId,
          environment: createRendererRuntimeEnvironment(),
          streamClientFactory: factory,
          streamFlushCoordinator: STREAM_FLUSH_COORDINATOR,
          onAuthError,
          onProviderAuthError,
          // THIS chat's socket, never the app-wide one. Each chat session owns
          // its own transport, so a wake resolved from `useWsStreamClient()`
          // would collapse the backoff on a different connection and leave
          // this one sitting out its delay - a button that appears to work and
          // does nothing. `probeFirst: false` because a person pressing it is
          // demanding a re-dial, and the probe-first flavour answers a
          // live-but-stuck socket with nothing.
          wakeTransport: () => {
            boundStreamClient?.reconnectAll(CHAT_SESSION_WAKE_REASON, {
              probeFirst: false,
              wakeProbe: null,
            });
          },
        }),
    );
    acquiredHandle = next;
    handleHostIds.set(next, hostId);
    setHandle(next);

    return () => {
      registry.releaseHandle(epicId, chatId, hostId, next);
    };
    // `openTransport` is referentially stable and reads its deps (auth, runner
    // host, credential source, directory) live, so the recovery wiring is never
    // a stale-capture risk and does not belong in this array. `transportKey`
    // already encodes user + host + endpoint identity; `ownerIdentityKey`
    // additionally discriminates a remote host's public-key rotation (R-1).
    // `queryClient` is the stable TanStack client used by the
    // provider-reauth invalidation.
  }, [
    chatId,
    hostId,
    epicId,
    transportKey,
    ownerIdentityKey,
    userId,
    enabled,
    openTransport,
    queryClient,
  ]);

  return handle;
}

/**
 * Peek an already-open session WITHOUT taking a lease.
 *
 * `hostId` is part of the session's identity (see `ChatSessionRegistry`), so
 * every caller has to name the host it means rather than inheriting whichever
 * host happens to be active: a tab-scoped surface passes its bound
 * `useTabHostId()`, a row-scoped surface passes the row's own owner host.
 * `null` means "this surface has no host for that chat yet" (an epic-projection
 * row that predates the field, or an id that resolves to nothing) and reads as
 * no session - never as "look it up on some other host", which is exactly the
 * substitution that would hand back a different machine's transcript.
 */
export function useExistingChatSessionHandle(
  epicId: string,
  chatId: string,
  hostId: string | null,
): ChatSessionStoreHandle | null {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => (hostId === null ? null : registry.peek(epicId, chatId, hostId)),
    [chatId, epicId, hostId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/**
 * Peeks an already-open session's `fatalClose`, for a caller (the canvas-
 * altitude published-copy fallback, `tab-group-view.tsx`) that is NOT itself
 * the one holding the handle - `chat-tile.tsx`'s own `useChatSessionHandle`
 * is. Composed from `useExistingChatSessionHandle` (registry-membership
 * reactivity: re-renders when a session for this pair is created/destroyed)
 * plus a second `useSyncExternalStore` over the handle's own store (state-
 * reactivity: re-renders when `fatalClose` itself flips within an existing
 * session) - the registry's own subscription does not fire on that inner
 * state change, only on membership changes, so one subscription alone would
 * miss the transition this hook exists to observe.
 */
export function useExistingChatSessionFatalClose(
  epicId: string,
  chatId: string,
  hostId: string,
): FatalErrorDetails | null {
  const handle = useExistingChatSessionHandle(epicId, chatId, hostId);
  const subscribe = useCallback(
    (listener: () => void) =>
      handle === null ? () => undefined : handle.store.subscribe(listener),
    [handle],
  );
  const getSnapshot = useCallback(
    () => handle?.store.getState().fatalClose ?? null,
    [handle],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function chatSessionScopeKey(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly userId: string | null;
  readonly hostId: string;
  readonly transportKey: string;
  readonly ownerIdentityKey: string;
}): string {
  return [
    input.epicId,
    input.chatId,
    input.userId ?? "anonymous",
    input.hostId,
    input.transportKey,
    input.ownerIdentityKey,
  ].join(CHAT_SESSION_SCOPE_SEPARATOR);
}
