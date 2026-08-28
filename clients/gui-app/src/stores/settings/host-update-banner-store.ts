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

/**
 * How long a completed update stays on the landing banner before collapsing.
 *
 * "Completion may auto-collapse after a short acknowledgement" (experience doc).
 * Long enough to read one sentence, short enough that a success nobody needs to
 * act on does not keep occupying the banner — which, for a durable attempt
 * record retained for days, is otherwise exactly what happens.
 */
export const HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS = 8_000;

/**
 * Most dismissed attempts remembered.
 *
 * Bounded because attempt ids are unbounded and this list is PERSISTED: an
 * unbounded set would grow once per update forever, in local storage, to answer
 * a question only the newest few attempts can ever ask. Dropping the oldest is
 * safe — an attempt old enough to fall off has long since been superseded on
 * the host, so it can no longer be the view the banner is rendering.
 */
const MAX_REMEMBERED_DISMISSALS = 32;

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
  /**
   * Terminal attempts the LANDING banner has finished with — a failure the user
   * dismissed, or a completion that acknowledged itself and collapsed.
   *
   * Keyed by `attemptId`, and that is what makes supersession free: a newer
   * attempt has an id nobody has dismissed, so it presents normally without any
   * expiry rule or version comparison. Keying by host, or by a boolean, would
   * mean the next failure on that machine arrived pre-dismissed.
   *
   * LANDING ONLY. The selected-host Overview reads none of this: "failure
   * dismissal is client-local presentation state; the failure remains
   * discoverable in the selected-host Overview until host-side expiry or a
   * newer attempt supersedes it" (experience doc). Dismissing is "stop telling
   * me on the home screen", never "delete the evidence".
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
