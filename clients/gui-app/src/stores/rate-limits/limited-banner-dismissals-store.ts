import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";

/**
 * Dismissed limit banners, per host: `hostId` → banner key → the `resetsAt`
 * of the limit episode the user hid (`null` for a limit with no reset time).
 *
 * The episode is the reset time, so a new limit on the same account (a
 * different `resetsAt`) is not covered by an old entry and its banner shows.
 * Host first because the popover shows one host's usage at a time and the
 * same account on another machine is a different reading.
 */
export type LimitedBannerDismissals = Readonly<
  Record<string, Readonly<Record<string, number | null>>>
>;

interface LimitedBannerDismissalsState {
  readonly dismissals: LimitedBannerDismissals;
  readonly dismiss: (
    hostId: string,
    bannerKey: string,
    resetsAt: number | null,
  ) => void;
  /**
   * Drops every entry that can no longer hide anything: a timed entry whose
   * reset has passed, on any host, and - on `hostId` only - an entry with no
   * reset time whose account a live reading now shows not limited
   * (`clearedKeys`), so the next limit shows its banner. An account with no
   * live reading (still loading, cold, failed) is not evidence either way,
   * so its entry stays.
   */
  readonly prune: (
    hostId: string,
    clearedKeys: ReadonlySet<string>,
    now: number,
  ) => void;
}

const LIMITED_BANNER_DISMISSALS_PERSIST_KEY = persistKey(
  STORE_KEYS.limitedBannerDismissals,
);

function persistedDismissals(persistedState: unknown): LimitedBannerDismissals {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  if (!("dismissals" in persistedState)) return {};
  const byHost = persistedState.dismissals;
  if (typeof byHost !== "object" || byHost === null) return {};
  const result: Record<string, Record<string, number | null>> = {};
  const hosts: ReadonlyArray<[string, unknown]> = Object.entries(byHost);
  for (const [hostId, entries] of hosts) {
    if (typeof entries !== "object" || entries === null) continue;
    const kept: Record<string, number | null> = {};
    const banners: ReadonlyArray<[string, unknown]> = Object.entries(entries);
    for (const [bannerKey, resetsAt] of banners) {
      if (
        resetsAt === null ||
        (typeof resetsAt === "number" && Number.isFinite(resetsAt))
      ) {
        kept[bannerKey] = resetsAt;
      }
    }
    if (Object.keys(kept).length > 0) result[hostId] = kept;
  }
  return result;
}

export const useLimitedBannerDismissalsStore =
  create<LimitedBannerDismissalsState>()(
    persist(
      (set) => ({
        dismissals: {},
        dismiss: (hostId, bannerKey, resetsAt) => {
          set((state) => {
            const entries = state.dismissals[hostId] ?? {};
            if (
              Object.hasOwn(entries, bannerKey) &&
              entries[bannerKey] === resetsAt
            ) {
              return state;
            }
            return {
              dismissals: {
                ...state.dismissals,
                [hostId]: { ...entries, [bannerKey]: resetsAt },
              },
            };
          });
        },
        prune: (hostId, clearedKeys, now) => {
          set((state) => {
            let changed = false;
            const next: Record<string, Record<string, number | null>> = {};
            for (const [entryHostId, entries] of Object.entries(
              state.dismissals,
            )) {
              const kept: Record<string, number | null> = {};
              for (const [bannerKey, resetsAt] of Object.entries(entries)) {
                const stale =
                  resetsAt === null
                    ? entryHostId === hostId && clearedKeys.has(bannerKey)
                    : resetsAt <= now;
                if (stale) {
                  changed = true;
                } else {
                  kept[bannerKey] = resetsAt;
                }
              }
              if (Object.keys(kept).length > 0) next[entryHostId] = kept;
            }
            return changed ? { dismissals: next } : state;
          });
        },
      }),
      {
        ...basePersistOptions(LIMITED_BANNER_DISMISSALS_PERSIST_KEY),
        storage: createJSONStorage(() => localStorage),
        merge: (persistedState, currentState) => ({
          ...currentState,
          dismissals: persistedDismissals(persistedState),
        }),
        partialize: (state) => ({ dismissals: state.dismissals }),
      },
    ),
  );

// A dismissal in one window hides the banner in every window of this device,
// and a window still holding the old map must not write it back over the new
// one when it next prunes.
installCrossWindowRehydrate(
  useLimitedBannerDismissalsStore,
  LIMITED_BANNER_DISMISSALS_PERSIST_KEY,
);
