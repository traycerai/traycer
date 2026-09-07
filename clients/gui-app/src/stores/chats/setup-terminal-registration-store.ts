import { create } from "zustand";

interface SetupTerminalRegistrationState {
  /**
   * `${viewTabId}:${setupTerminalSessionId}` keys for worktree setup terminals already auto-opened
   * as a background canvas tab this session.
   */
  readonly registeredKeys: ReadonlySet<string>;
  /**
   * Marks `key` and returns true the FIRST time it is seen (the caller should open the tab); returns
   * false on every later call (the caller should skip), so the setup terminal auto-opens exactly
   */
  registerOnce: (key: string) => boolean;
  /** Test-only: clear all registrations so cases don't leak into each other. */
  reset: () => void;
}

export const useSetupTerminalRegistrationStore =
  create<SetupTerminalRegistrationState>((set, get) => ({
    registeredKeys: new Set(),
    registerOnce: (key) => {
      if (get().registeredKeys.has(key)) return false;
      set((state) => {
        const next = new Set(state.registeredKeys);
        next.add(key);
        return { registeredKeys: next };
      });
      return true;
    },
    reset: () => set({ registeredKeys: new Set() }),
  }));
