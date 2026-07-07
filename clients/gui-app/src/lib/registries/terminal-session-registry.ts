import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";
import { TerminalStreamClient } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import { useHostClient } from "@/lib/host";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { authenticatedHostStreamKey } from "@/hooks/host/use-host-stream-client-for";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { openOwnedDurableStreamClient } from "@/lib/host/owned-durable-stream-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  createTerminalSessionStore,
  type TerminalReattachMode,
  type TerminalSessionStoreHandle,
  type TerminalStreamClientFactory,
} from "@/stores/terminals/terminal-session-store";
import { TerminalSessionRegistry } from "@/stores/terminals/terminal-session-registry";
import type {
  ListTerminalsResponse,
  TerminalSessionKind,
} from "@traycer/protocol/host/terminal/unary-schemas";

const registry = new TerminalSessionRegistry();

const handleHostIds = new WeakMap<TerminalSessionStoreHandle, string | null>();

let streamClientFactoryOverride: TerminalStreamClientFactory | null = null;

export function __setTerminalStreamClientFactoryForTests(
  factory: TerminalStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function __getTerminalSessionRegistryForTests(): TerminalSessionRegistry {
  return registry;
}

export function getTerminalSessionRegistry(): TerminalSessionRegistry {
  return registry;
}

export function getTerminalSessionHandleHostId(
  handle: TerminalSessionStoreHandle,
): string | null {
  return handleHostIds.get(handle) ?? null;
}

export function disposeAllTerminalSessions(): void {
  registry.disposeAll();
}

export interface UseTerminalSessionHandleArgs {
  readonly hostId: string;
  readonly epicId: string;
  readonly sessionId: string;
  /**
   * Per-tab instance id this handle is registered under. Keying by
   * `instanceId` (not `sessionId`) lets two tab instances of the same PTY/TUI
   * session each hold their own handle + stream client subscribing to the
   * shared `sessionId`.
   */
  readonly instanceId: string;
  readonly cols: number;
  readonly rows: number;
  readonly reattachMode: TerminalReattachMode;
  readonly kind: TerminalSessionKind;
  /** Set false until the host-side session is known to exist (post-create or post-list-hit). */
  readonly enabled: boolean;
}

export function useTerminalSessionHandle(
  args: UseTerminalSessionHandleArgs,
): TerminalSessionStoreHandle | null {
  const hostEntry = useHostDirectoryEntry(args.hostId);
  const globalClient = useHostClient();
  // Terminal is a DURABLE per-tab stream: its `WsStreamClient` is OWNED by the
  // session store for the session's warm lifetime (terminal-agent sessions are
  // kept warm across tile unmount), NOT by this tile - so closing then reopening
  // the tab no longer hands the revived warm session a socket the unmounting
  // tile already closed. The opener wires the shared "durable stream = auth +
  // wake" recovery; the returned handle's `close()` tears it down on dispose.
  const openTransport = useDurableStreamTransportFactory();
  const queryClient = useQueryClient();
  const creationConfigRef = useRef({
    cols: args.cols,
    rows: args.rows,
    reattachMode: args.reattachMode,
  });

  // Readiness gate: authenticated request context + dialable endpoint (or the
  // test seam). A non-null `transportKey` is the terminal's "ready to acquire"
  // signal, replacing the old per-tile `wsStreamClient !== null` check. The
  // shared `authenticatedHostStreamKey` derives the production identity only
  // when the factory is not overridden, matching chat.
  const transportKey =
    streamClientFactoryOverride !== null
      ? "test-stream-client-factory"
      : authenticatedHostStreamKey(globalClient, hostEntry);

  const [handle, setHandle] = useReducer(
    (
      _state: TerminalSessionStoreHandle | null,
      next: TerminalSessionStoreHandle | null,
    ) => next,
    null,
  );

  useEffect(() => {
    creationConfigRef.current = {
      cols: args.cols,
      rows: args.rows,
      reattachMode: args.reattachMode,
    };
  }, [args.cols, args.rows, args.reattachMode]);

  useEffect(() => {
    if (!args.enabled) {
      setHandle(null);
      return;
    }
    // Null until there is an authenticated request context and a dialable host
    // endpoint (or "test-..." when the factory is overridden).
    if (transportKey === null) {
      setHandle(null);
      return;
    }

    const existing = registry.get(args.instanceId);
    if (existing !== null) {
      const existingHostId = handleHostIds.get(existing) ?? null;
      if (existingHostId !== args.hostId) {
        registry.forceRelease(args.instanceId);
      }
    }

    const factory: TerminalStreamClientFactory = (
      sessionId,
      cols,
      rows,
      callbacks,
    ) => {
      if (streamClientFactoryOverride !== null) {
        return streamClientFactoryOverride(sessionId, cols, rows, callbacks);
      }
      // The session OWNS this transport (built here, torn down by `close()`), so
      // it survives tile unmount for warm terminal-agent sessions instead of
      // being closed with the tile. `openOwnedDurableStreamClient` composes the
      // close and closes the half-built transport if `new TerminalStreamClient`
      // (it subscribes on the socket) throws synchronously, so no socket or wake
      // listener leaks.
      const result = openOwnedDurableStreamClient(
        openTransport,
        args.hostId,
        (ws) =>
          new TerminalStreamClient({
            wsStreamClient: ws,
            sessionId,
            cols,
            rows,
            callbacks,
          }),
      );
      return {
        sendAction: (frame) => result.client.sendAction(frame),
        close: result.close,
      };
    };

    const next = registry.acquire(args.instanceId, () => {
      const creationConfig = creationConfigRef.current;
      return createTerminalSessionStore({
        epicId: args.epicId,
        sessionId: args.sessionId,
        cols: creationConfig.cols,
        rows: creationConfig.rows,
        reattachMode: creationConfig.reattachMode,
        kind: args.kind,
        streamClientFactory: factory,
      });
    });
    handleHostIds.set(next, args.hostId);
    setHandle(next);

    return () => {
      registry.release(args.instanceId);
    };
    // `openTransport` is referentially stable and reads its deps live;
    // `transportKey` already encodes user + host + endpoint identity.
  }, [
    args.hostId,
    args.enabled,
    args.epicId,
    args.sessionId,
    args.instanceId,
    args.kind,
    transportKey,
    openTransport,
  ]);

  useEffect(() => {
    if (handle === null) return;
    const initialState = handle.store.getState();
    let previousStatus = initialState.status;
    let previousTitle = initialState.title;
    let previousActiveProcessName = initialState.activeProcessName;
    return handle.store.subscribe((state) => {
      const statusChanged = state.status !== previousStatus;
      const metadataChanged =
        state.title !== previousTitle ||
        state.activeProcessName !== previousActiveProcessName;
      previousStatus = state.status;
      previousTitle = state.title;
      previousActiveProcessName = state.activeProcessName;
      if (metadataChanged) {
        // Patch the cached `terminal.list` rows in place - NEVER invalidate
        // here. The stream is the authoritative source for these fields
        // (snapshot / `sessionUpdated` frames), so a refetch adds nothing,
        // and invalidating was actively harmful: the tile bootstrap gates
        // this handle on `terminal.list`, so invalidate -> refetch -> handle
        // released -> re-subscribe -> snapshot re-sets metadata -> invalidate
        // looped forever, bouncing the PTY stream and leaving reattached
        // terminals blank. (An explicitly justified `setQueriesData`:
        // stream-pushed state IS the response state.)
        queryClient.setQueriesData<ListTerminalsResponse>(
          { queryKey: hostQueryKeys.methodScope(args.hostId, "terminal.list") },
          (data) => {
            if (data === undefined) return undefined;
            const target = data.sessions.find(
              (session) => session.sessionId === args.sessionId,
            );
            if (
              target === undefined ||
              (target.title === state.title &&
                (target.activeProcessName ?? null) === state.activeProcessName)
            ) {
              return data;
            }
            return {
              sessions: data.sessions.map((session) =>
                session.sessionId === args.sessionId
                  ? {
                      ...session,
                      title: state.title,
                      activeProcessName: state.activeProcessName,
                    }
                  : session,
              ),
            };
          },
        );
      }
      if (
        statusChanged &&
        (state.status === "exited" || state.status === "lost")
      ) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.scope(args.hostId),
        });
      }
    });
  }, [args.hostId, args.sessionId, handle, queryClient]);

  return handle;
}
