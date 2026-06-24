import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChatStreamClient } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { useAuthService, useHostClient } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { authenticatedHostStreamKey } from "@/hooks/host/use-host-stream-client-for";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type ChatStreamClientFactory,
} from "@/stores/chats/chat-session-store";
import {
  ChatSessionRegistry,
  DEFAULT_CHAT_IDLE_TTL_MS,
  DEFAULT_MAX_WARM_CHAT_SESSIONS,
} from "@/stores/chats/session-registry";
import {
  BROWSER_STREAM_FLUSH_TIMERS,
  createStreamFlushCoordinator,
} from "@/stores/chats/stream-flush-coordinator";

const registry = new ChatSessionRegistry({
  idleTtlMs: DEFAULT_CHAT_IDLE_TTL_MS,
  maxWarmSessions: DEFAULT_MAX_WARM_CHAT_SESSIONS,
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

export function getChatSessionHandleHostId(
  handle: ChatSessionStoreHandle,
): string | null {
  return handleHostIds.get(handle) ?? null;
}

export function disposeAllChatSessions(): void {
  registry.disposeAll();
}

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
    if (transportKey === null) {
      setHandle(null);
      return;
    }
    const scopeKey = chatSessionScopeKey({
      epicId,
      chatId,
      userId,
      hostId,
      transportKey,
    });

    // The session OWNS its transport: the factory builds it (socket + auth +
    // wake), and the returned handle's `close()` tears all of it down. Because
    // the registry only closes the handle when it DISPOSES the session (not on
    // tile unmount), the socket stays alive across close -> warm -> reopen, so a
    // revived session is never handed a dead transport. `retry()` re-invokes
    // this factory, rebuilding the transport with live deps.
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
        (ws) =>
          new ChatStreamClient({
            wsStreamClient: ws,
            epicId: factoryEpicId,
            chatId: factoryChatId,
            callbacks,
          }),
      );
      return {
        sendAction: (frame) => result.client.sendAction(frame),
        close: result.close,
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
      epicId,
      chatId,
      scopeKey,
      (factoryEpicId, factoryChatId) =>
        createChatSessionStore({
          epicId: factoryEpicId,
          chatId: factoryChatId,
          userId,
          streamClientFactory: factory,
          streamFlushCoordinator: STREAM_FLUSH_COORDINATOR,
          onAuthError,
          onProviderAuthError,
        }),
    );
    handleHostIds.set(next, hostId);
    setHandle(next);

    return () => {
      registry.releaseHandle(epicId, chatId, next);
    };
    // `openTransport` is referentially stable and reads its deps (auth, runner
    // host, credential source, directory) live, so the recovery wiring is never
    // a stale-capture risk and does not belong in this array. `transportKey`
    // already encodes user + host + endpoint identity. `queryClient` is the
    // stable TanStack client used by the provider-reauth invalidation.
  }, [
    chatId,
    hostId,
    epicId,
    transportKey,
    userId,
    enabled,
    openTransport,
    queryClient,
  ]);

  return handle;
}

export function useExistingChatSessionHandle(
  epicId: string,
  chatId: string,
): ChatSessionStoreHandle | null {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => registry.peek(epicId, chatId),
    [chatId, epicId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

function chatSessionScopeKey(input: {
  readonly epicId: string;
  readonly chatId: string;
  readonly userId: string | null;
  readonly hostId: string;
  readonly transportKey: string;
}): string {
  return [
    input.epicId,
    input.chatId,
    input.userId ?? "anonymous",
    input.hostId,
    input.transportKey,
  ].join(CHAT_SESSION_SCOPE_SEPARATOR);
}
