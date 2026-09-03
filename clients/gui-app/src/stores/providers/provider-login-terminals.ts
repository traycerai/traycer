import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Which terminal sessions the HOST created for a provider sign-in.
 *
 * The tile ref records this too (`origin: "provider-login"`), but a tile is the
 * wrong place for it to LIVE: the sidebar, the command palette and a drag-drop
 * all mint fresh refs straight from `terminal.list`, which carries no origin,
 * so a sign-in terminal reopened from any of them becomes an ordinary tile that
 * believes it owns the session. When the host later loses the PTY that tile
 * dispatches `terminal.create` for the id and spawns a bare shell with none of
 * the provider's spawn env - a prompt that looks like the sign-in terminal and
 * cannot sign anyone in.
 *
 * Keyed by host + session because session ids are only unique within a host.
 *
 * Persisted, and deliberately so: the whole point is to answer the question
 * after the originating tile is gone, which includes after a renderer reload.
 * Bounded to {@link MAX_TRACKED_SESSIONS} most-recent entries - a sign-in
 * terminal is short-lived, ids are uuids so a stale entry can never be
 * re-matched, and an unbounded map in localStorage would grow forever.
 *
 * The durable home for this is a field on `terminal.list` itself, so the host
 * answers it for every client and every open path. That is a wire change with
 * a frozen-line bump; this store closes the same hole client-side until then.
 */
const MAX_TRACKED_SESSIONS = 32;

const PROVIDER_LOGIN_TERMINALS_PERSIST_KEY = persistKey(
  STORE_KEYS.providerLoginTerminals,
);

interface ProviderLoginTerminalsState {
  readonly providerBySessionKey: Readonly<
    Record<string, ProviderId | undefined>
  >;
  /** Most-recent-first, the eviction order for the bound above. */
  readonly recentKeys: ReadonlyArray<string>;
  readonly record: (args: {
    readonly hostId: string;
    readonly sessionId: string;
    readonly providerId: ProviderId;
  }) => void;
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

export const useProviderLoginTerminalsStore =
  create<ProviderLoginTerminalsState>()(
    persist(
      (set) => ({
        providerBySessionKey: {},
        recentKeys: [],
        record: ({ hostId, sessionId, providerId }) =>
          set((state) => {
            const key = sessionKey(hostId, sessionId);
            const recentKeys = [
              key,
              ...state.recentKeys.filter((entry) => entry !== key),
            ].slice(0, MAX_TRACKED_SESSIONS);
            const kept = new Set(recentKeys);
            const providerBySessionKey: Record<string, ProviderId> = {
              [key]: providerId,
            };
            for (const [entry, value] of Object.entries(
              state.providerBySessionKey,
            )) {
              if (value !== undefined && kept.has(entry)) {
                providerBySessionKey[entry] = value;
              }
            }
            return { providerBySessionKey, recentKeys };
          }),
      }),
      basePersistOptions(PROVIDER_LOGIN_TERMINALS_PERSIST_KEY),
    ),
  );

// Another window started a sign-in: follow it. Hydration alone is not enough
// because the window that has to ANSWER this question is usually already open -
// a second window lists the same host's independent sessions and would adopt
// the sign-in session as an ordinary terminal, which is exactly the bare-shell
// failure above. The `storage` event fires only in OTHER same-origin windows,
// never the one that wrote, so this cannot loop with `record`. `event.key ===
// null` covers an explicit `localStorage.clear()`. Same pattern as
// `feature-announcements-store`.
//
// This closes the window-to-window gap, not the general one: the durable answer
// is still an origin field on `terminal.list`, which would also cover a client
// that never saw the write at all.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (
      event.key === null ||
      event.key === PROVIDER_LOGIN_TERMINALS_PERSIST_KEY
    ) {
      void useProviderLoginTerminalsStore.persist.rehydrate();
    }
  });
}

/** Records a host-created sign-in terminal. Call this wherever the host hands
 *  one back, not only where a tile is opened for it. */
export function recordProviderLoginTerminal(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly providerId: ProviderId;
}): void {
  useProviderLoginTerminalsStore.getState().record(args);
}

/** The provider this session was opened to sign in to, or `null` for an
 *  ordinary terminal. Read outside React - the ref builders that need it are
 *  plain functions. */
export function providerLoginTerminalProviderId(
  hostId: string,
  sessionId: string,
): ProviderId | null {
  return (
    useProviderLoginTerminalsStore.getState().providerBySessionKey[
      sessionKey(hostId, sessionId)
    ] ?? null
  );
}
