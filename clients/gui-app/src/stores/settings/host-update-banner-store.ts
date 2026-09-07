import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
const HOST_UPDATE_BANNER_PERSIST_KEY = persistKey(STORE_KEYS.hostUpdateBanner);

/**
 * Default snooze window applied when the user dismisses the in-app host update banner with "Remind
 * me later".
 */
export const HOST_UPDATE_BANNER_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a completed update stays on the landing banner before collapsing. "Completion may
 * auto-collapse after a short acknowledgement" (experience doc).
 */
export const HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS = 8_000;

/** Most dismissed attempts remembered. */
const MAX_REMEMBERED_DISMISSALS = 32;

interface HostUpdateBannerState {
  /**
   * Map of latestVersion (the one shown when the user snoozed) → epoch milliseconds after which the
   * banner should re-appear for that version.
   */
  readonly snoozeUntilByVersion: Readonly<Record<string, number>>;
  snooze: (latestVersion: string, snoozeUntilMs: number) => void;
  clearSnooze: (latestVersion: string) => void;
  /**
   * Terminal attempts the LANDING banner has finished with - a failure the user dismissed, or a
   * completion that acknowledged itself and collapsed.
   */
  readonly landingDismissedAttemptIds: ReadonlyArray<string>;
  dismissLandingAttempt: (attemptId: string) => void;
}

type PersistedHostUpdateBannerState = Pick<
  HostUpdateBannerState,
  "snoozeUntilByVersion" | "landingDismissedAttemptIds"
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
      landingDismissedAttemptIds: [],
      dismissLandingAttempt: (attemptId) => {
        set((state) => {
          if (state.landingDismissedAttemptIds.includes(attemptId)) {
            return state;
          }
          return {
            landingDismissedAttemptIds: [
              ...state.landingDismissedAttemptIds,
              attemptId,
            ].slice(-MAX_REMEMBERED_DISMISSALS),
          };
        });
      },
    }),
    {
      ...basePersistOptions(HOST_UPDATE_BANNER_PERSIST_KEY),
      partialize: (state): PersistedHostUpdateBannerState => ({
        snoozeUntilByVersion: state.snoozeUntilByVersion,
        landingDismissedAttemptIds: state.landingDismissedAttemptIds,
      }),
    },
  ),
);

export function isHostUpdateBannerSnoozed(
  snoozeUntilByVersion: Readonly<Record<string, number>>,
  latestVersion: string,
  nowMs: number,
): boolean {
  if (!Object.hasOwn(snoozeUntilByVersion, latestVersion)) return false;
  const snoozedUntil = snoozeUntilByVersion[latestVersion];
  return nowMs < snoozedUntil;
}
