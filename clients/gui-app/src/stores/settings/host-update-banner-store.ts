import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
const HOST_UPDATE_BANNER_PERSIST_KEY = persistKey(STORE_KEYS.hostUpdateBanner);

/**
 * Default snooze window applied when the user dismisses the in-app host
 * update banner with "Remind me later". Re-prompts after this much time has
 * elapsed unless a newer release lands first (the available version key on
 * disk is bound to the latest version, so any change re-arms the banner).
 */
export const HOST_UPDATE_BANNER_SNOOZE_MS = 24 * 60 * 60 * 1000;

interface HostUpdateBannerState {
  /**
   * Map of latestVersion (the one shown when the user snoozed) → epoch
   * milliseconds after which the banner should re-appear for that version.
   * Keyed by version so a newer release naturally re-prompts (its key is
   * absent from the map).
   */
  readonly snoozeUntilByVersion: Readonly<Record<string, number>>;
  snooze: (latestVersion: string, snoozeUntilMs: number) => void;
  clearSnooze: (latestVersion: string) => void;
}

type PersistedHostUpdateBannerState = Pick<
  HostUpdateBannerState,
  "snoozeUntilByVersion"
>;

export const useHostUpdateBannerStore = create<HostUpdateBannerState>()(
  persist(
    (set) => ({
      snoozeUntilByVersion: {},
      snooze: (latestVersion, snoozeUntilMs) => {
        set((state) => {
          if (
            (state.snoozeUntilByVersion[latestVersion] ?? null) ===
            snoozeUntilMs
          ) {
            return state;
          }
          return {
            snoozeUntilByVersion: {
              ...state.snoozeUntilByVersion,
              [latestVersion]: snoozeUntilMs,
            },
          };
        });
      },
      clearSnooze: (latestVersion) => {
        set((state) => {
          if (!Object.hasOwn(state.snoozeUntilByVersion, latestVersion)) {
            return state;
          }
          const next = { ...state.snoozeUntilByVersion };
          delete next[latestVersion];
          return { snoozeUntilByVersion: next };
        });
      },
    }),
    {
      ...basePersistOptions(HOST_UPDATE_BANNER_PERSIST_KEY),
      partialize: (state): PersistedHostUpdateBannerState => ({
        snoozeUntilByVersion: state.snoozeUntilByVersion,
      }),
    },
  ),
);

/**
 * Returns true when the banner should be hidden because the user snoozed it
 * for the currently-advertised `latestVersion`. A newer `latestVersion`
 * cleanly re-arms because its key isn't in the persisted map.
 */
export function isHostUpdateBannerSnoozed(
  snoozeUntilByVersion: Readonly<Record<string, number>>,
  latestVersion: string,
  nowMs: number,
): boolean {
  if (!Object.hasOwn(snoozeUntilByVersion, latestVersion)) return false;
  const snoozedUntil = snoozeUntilByVersion[latestVersion];
  return nowMs < snoozedUntil;
}
