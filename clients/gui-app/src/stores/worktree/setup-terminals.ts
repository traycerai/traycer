import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/** Which terminal sessions the HOST created for worktree setup. */
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

/** True when this session was opened for worktree setup. Read outside React -
 *  the ref builders that need it are plain functions. */
export function isSetupTerminal(hostId: string, sessionId: string): boolean {
  return (
    useSetupTerminalsStore.getState().trackedBySessionKey[
      sessionKey(hostId, sessionId)
    ] === true
  );
}
