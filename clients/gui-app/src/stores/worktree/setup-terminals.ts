import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Which terminal sessions the HOST created for worktree setup.
 *
 * The tile ref records this too (`origin: "setup"`), but a tile is the wrong
 * place for it to LIVE: the sidebar, the command palette and a drag-drop all
 * mint fresh refs straight from `terminal.list`, which carries no origin, so a
 * setup terminal reopened from any of them becomes an ordinary tile that
 * believes it owns the session. Import then persists the orchestrator's pinned
 * setup invocation as `launch.shellCommand`, and a later `ensureRunning` after
 * restart re-runs worktree setup.
 *
 * Keyed by host + session because session ids are only unique within a host.
 *
 * Persisted, and deliberately so: the whole point is to answer the question
 * after the originating tile is gone, which includes after a renderer reload.
 * Bounded to {@link MAX_TRACKED_SESSIONS} most-recent entries - a setup
 * terminal is short-lived, ids are uuids so a stale entry can never be
 * re-matched, and an unbounded map in localStorage would grow forever.
 *
 * The durable home for this is a field on `terminal.list` itself, so the host
 * answers it for every client and every open path. That is a wire change with
 * a frozen-line bump; this store closes the same hole client-side until then.
 */
const MAX_TRACKED_SESSIONS = 32;

interface SetupTerminalsState {
  readonly trackedBySessionKey: Readonly<Record<string, true | undefined>>;
  /** Most-recent-first, the eviction order for the bound above. */
  readonly recentKeys: ReadonlyArray<string>;
  readonly record: (args: {
    readonly hostId: string;
    readonly sessionId: string;
  }) => void;
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

export const useSetupTerminalsStore = create<SetupTerminalsState>()(
  persist(
    (set) => ({
      trackedBySessionKey: {},
      recentKeys: [],
      record: ({ hostId, sessionId }) =>
        set((state) => {
          const key = sessionKey(hostId, sessionId);
          const recentKeys = [
            key,
            ...state.recentKeys.filter((entry) => entry !== key),
          ].slice(0, MAX_TRACKED_SESSIONS);
          const kept = new Set(recentKeys);
          const trackedBySessionKey: Record<string, true> = { [key]: true };
          for (const [entry, value] of Object.entries(
            state.trackedBySessionKey,
          )) {
            if (value === true && kept.has(entry)) {
              trackedBySessionKey[entry] = true;
            }
          }
          return { trackedBySessionKey, recentKeys };
        }),
    }),
    basePersistOptions(persistKey(STORE_KEYS.setupTerminals)),
  ),
);

/** Records a host-created setup terminal. Call this wherever the host hands
 *  one back, not only where a tile is opened for it. */
export function recordSetupTerminal(args: {
  readonly hostId: string;
  readonly sessionId: string;
}): void {
  useSetupTerminalsStore.getState().record(args);
}

/** True when this session was opened for worktree setup. Read outside React —
 *  the ref builders that need it are plain functions. */
export function isSetupTerminal(hostId: string, sessionId: string): boolean {
  return (
    useSetupTerminalsStore.getState().trackedBySessionKey[
      sessionKey(hostId, sessionId)
    ] === true
  );
}
