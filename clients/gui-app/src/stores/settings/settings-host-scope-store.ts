import { create } from "zustand";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  environmentPickValue,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";

export interface SettingsHostSelection {
  readonly hostId: string;
  readonly name: string;
}

/** Settings view selections belong to this window and never survive a restart. */
interface SettingsHostScopeState {
  readonly hostByEnvironment: Readonly<
    Record<string, SettingsHostSelection | undefined>
  >;
  /** A named entry waits for its environment before any host panel can read. */
  readonly pendingHostId: string | null;
  readonly selectHost: (
    pick: EnvironmentPick,
    host: SettingsHostSelection | null,
  ) => void;
  readonly requestHost: (hostId: string) => void;
  readonly completeHostEntry: (
    host: SettingsHostSelection,
    pick: EnvironmentPick,
  ) => void;
  readonly abandonHostEntry: (hostId: string) => void;
  readonly reset: () => void;
  readonly adoptHostId: (previous: string, next: string) => void;
}

export const useSettingsHostScopeStore = create<SettingsHostScopeState>(
  (set) => ({
    hostByEnvironment: {},
    pendingHostId: null,
    selectHost: (pick, host) =>
      set((state) => {
        const hostByEnvironment = { ...state.hostByEnvironment };
        const key = environmentPickValue(pick);
        if (host === null) delete hostByEnvironment[key];
        else hostByEnvironment[key] = host;
        return { hostByEnvironment, pendingHostId: null };
      }),
    requestHost: (pendingHostId) => set({ pendingHostId }),
    completeHostEntry: (host, pick) =>
      set((state) =>
        state.pendingHostId !== host.hostId
          ? state
          : {
              hostByEnvironment: {
                ...state.hostByEnvironment,
                [environmentPickValue(pick)]: host,
              },
              pendingHostId: null,
            },
      ),
    abandonHostEntry: (hostId) =>
      set((state) =>
        state.pendingHostId === hostId ? { pendingHostId: null } : state,
      ),
    reset: () => set({ hostByEnvironment: {}, pendingHostId: null }),
    adoptHostId: (previous, next) => {
      set((state) => ({
        hostByEnvironment: Object.fromEntries(
          Object.entries(state.hostByEnvironment).map(([key, host]) => [
            key === `local:${previous}` ? `local:${next}` : key,
            host?.hostId === previous ? { ...host, hostId: next } : host,
          ]),
        ),
        pendingHostId:
          state.pendingHostId === previous ? next : state.pendingHostId,
      }));
      const environment = useSettingsEnvironmentPickStore.getState();
      if (
        environment.pick?.kind === "local" &&
        environment.pick.hostId === previous
      ) {
        environment.setPick({ ...environment.pick, hostId: next });
      }
      if (
        environment.defaultPick.kind === "local" &&
        environment.defaultPick.hostId === previous
      ) {
        environment.setDefaultPick({
          ...environment.defaultPick,
          hostId: next,
        });
      }
    },
  }),
);
