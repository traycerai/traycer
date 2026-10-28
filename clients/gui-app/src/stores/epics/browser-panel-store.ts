import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { basePersistOptions, persistKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";

const preferenceSchema = z.object({
  showOffline: z.boolean(),
  collapsed: z.record(z.string(), z.boolean()),
});
type BrowserPanelPreference = z.infer<typeof preferenceSchema>;
const EMPTY_PREFERENCE: BrowserPanelPreference = {
  showOffline: false,
  collapsed: {},
};

interface BrowserPanelStore {
  readonly preferences: Readonly<Record<string, BrowserPanelPreference>>;
  readonly setShowOffline: (scope: string, value: boolean) => void;
  readonly setCollapsed: (
    scope: string,
    hostId: string,
    value: boolean,
  ) => void;
}

export const useBrowserPanelStore = create<BrowserPanelStore>()(
  persist(
    (set) => ({
      preferences: {},
      setShowOffline: (scope, value) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            [scope]: {
              ...(state.preferences[scope] ?? EMPTY_PREFERENCE),
              showOffline: value,
            },
          },
        })),
      setCollapsed: (scope, hostId, value) =>
        set((state) => {
          const current = state.preferences[scope] ?? EMPTY_PREFERENCE;
          return {
            preferences: {
              ...state.preferences,
              [scope]: {
                ...current,
                collapsed: { ...current.collapsed, [hostId]: value },
              },
            },
          };
        }),
    }),
    {
      ...basePersistOptions(persistKey("browser-panel")),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ preferences: state.preferences }),
      merge: (value, current) => {
        const parsed = z
          .object({ preferences: z.record(z.string(), preferenceSchema) })
          .safeParse(value);
        return parsed.success
          ? { ...current, preferences: parsed.data.preferences }
          : current;
      },
    },
  ),
);

export interface BrowserPanelPreferences extends BrowserPanelPreference {
  readonly setShowOffline: (value: boolean) => void;
  readonly setCollapsed: (hostId: string, value: boolean) => void;
}

export function useBrowserPanelPreferences(
  epicId: string,
): BrowserPanelPreferences {
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  const scope = JSON.stringify([userId, epicId]);
  const preference = useBrowserPanelStore(
    (state) => state.preferences[scope] ?? EMPTY_PREFERENCE,
  );
  const setShowOffline = (value: boolean) =>
    useBrowserPanelStore.getState().setShowOffline(scope, value);
  const setCollapsed = (hostId: string, value: boolean) =>
    useBrowserPanelStore.getState().setCollapsed(scope, hostId, value);
  return {
    ...preference,
    setShowOffline,
    setCollapsed,
  };
}
