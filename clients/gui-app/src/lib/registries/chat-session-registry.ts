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
import type { HostKind } from "@traycer-clients/shared/host-client/host-directory";
import { useAuthService, useHostClient } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostLease } from "@/hooks/host/use-host-lease";
import {
  authenticatedHostStreamKey,
  authenticatedOwnerIdentityKey,
} from "@/hooks/host/use-host-stream-client-for";
import { isLocalHostBootingEntry } from "@/lib/host/transport-key";
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

/**
 * The registry's own signal is NOT enough, and assuming it was left this retry
 * mostly inert.
 *
 * `unsettledWorkForEpic` reads `activeTurn`, `runStatus`, the approval lists,
 * `pendingActions`, `acceptedActions`, `failedSendRestoration` and `restore`
 * out of each chat's STORE, but `registry.subscribe` relays only the shared
 * session registry's membership and demand events - acquire, release, dispose.
 * An inner store write is none of those. So the exact moments this retry exists
 * for - a chat's last action settling, a restoration slot being taken into the
 * composer, a restore completing - emitted nothing, and a park deferred for
 * chat work sat waiting for some unrelated acquire elsewhere to shake it loose.
 *
 * Every one of those settlements is a store write and nothing else, which is
 * why the watch is on the store rather than on any narrower signal.
 *
 * So watch the stores themselves, rebinding on every membership change because
 * membership is precisely what changes the set of live handles. Firing on
 * every store write is deliberate and cheap: `retryDeferredEpicParks` walks
 * this window's open-tab entries and returns immediately for every epic not
 * sitting on a refused park, which is all of them almost all of the time.
 */
const chatStoreWatches = new Map<ChatSessionStoreHandle, () => void>();

function rebindChatStoreWatches(): void {
  const live = new Set(registry.listHandles());
  for (const [handle, unsubscribe] of Array.from(chatStoreWatches)) {
    if (live.has(handle)) continue;
    unsubscribe();
    chatStoreWatches.delete(handle);
  }
  for (const handle of live) {
    if (chatStoreWatches.has(handle)) continue;
    chatStoreWatches.set(
      handle,
      handle.store.subscribe(() => {
        retryDeferredEpicParks();
      }),
    );
  }
}

registry.subscribe(() => {
  rebindChatStoreWatches();
  retryDeferredEpicParks();
});
rebindChatStoreWatches();

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
  const lease = useHostLease(hostId);
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

  // Dialability, for the gate below and never for the scope: null with no
  // request context, no websocket URL, or a CONFIRMED refusal. The test seam
  // is a clearly separate top-level branch; the production value is derived by
  // the shared `authenticatedHostStreamKey` ONLY when the factory is not
  // overridden, so tests drive the stream through the override and never touch
  // the real request context.
  const transportKey =
    streamClientFactoryOverride !== null
      ? "test-stream-client-factory"
      : authenticatedHostStreamKey(globalClient, hostEntry);
  // Owner identity (R-1), which with the host's kind is the whole of the
  // session's scope: `hostId + userId` for a local host, plus the public key
  // and relay attach URL for a remote one, so a remote public-key rotation
  // still rebuilds. Null with no request context or no directory entry.
  const ownerIdentityKey =
    streamClientFactoryOverride !== null
      ? "test-stream-client-factory"
      : authenticatedOwnerIdentityKey(globalClient, hostEntry);
  const hostKind = hostEntry?.kind ?? null;
  // Whether this chat may hold its session. A dialable host may. So may a host
  // that is coming back, which is what keeps the store and its transcript
  // through a restart while the owned transport re-dials underneath (it reads
  // the endpoint live on every dial): this machine's host in its booting
  // shape, and any host whose lease says `restarting-expected`, a hold the
  // lease's own bounds end. Everything else that nulls `transportKey` still
  // releases: identity loss, a missing entry, and a confirmed refusal with no
  // restart episode vouching for the host.
  const sessionAllowed =
    ownerIdentityKey !== null &&
    (transportKey !== null ||
      isLocalHostBootingEntry(hostEntry) ||
      lease?.status === "restarting-expected");

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
    // See `sessionAllowed`, which also narrows `ownerIdentityKey` to non-null
    // for the scope below.
    if (!sessionAllowed) {
      setHandle(null);
      return;
    }
    // Identity only. The websocket URL and the host version stay out: both
    // change when a host restarts, and a scope that moved with them disposed
    // the store and its transcript on every restart (the "Still opening this
    // agent" incident). A version change is safe to keep a store across: the
    // transport renegotiates on every subscribe, and a legacy snapshot resets
    // windowed state atomically.
    const scopeKey = chatSessionScopeKey({
      epicId,
      chatId,
      userId,
      hostId,
      hostKind,
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
          // The same socket the wake above reaches, asked instead whether it
          // is worth waking. `?? false` covers both "no transport of ours"
          // (the `streamClientFactoryOverride` path never assigns
          // `boundStreamClient`) and "this transport does not measure
          // silence" (the local `WsStreamClient` leaves the member absent):
          // neither is evidence of a dead session, so neither escalates.
          transportSilentFor: (ms) =>
            boundStreamClient?.isSilentFor?.(ms) ?? false,
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
    // a stale-capture risk and does not belong in this array. `transportKey` is
    // deliberately absent: it moves with the endpoint, and only its share of
    // `sessionAllowed` may end the session. `ownerIdentityKey` discriminates a
    // remote host's public-key rotation (R-1). `queryClient` is the stable
    // TanStack client used by the provider-reauth invalidation.
  }, [
    chatId,
    hostId,
    hostKind,
    epicId,
    sessionAllowed,
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
  readonly hostKind: HostKind | null;
  readonly ownerIdentityKey: string;
}): string {
  return [
    input.epicId,
    input.chatId,
    input.userId ?? "anonymous",
    input.hostId,
    // `null` only on the test-factory seam, which binds no directory entry.
    input.hostKind ?? "none",
    input.ownerIdentityKey,
  ].join(CHAT_SESSION_SCOPE_SEPARATOR);
}
