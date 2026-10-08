import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";
import {
  isLimitedBannerDismissalExpired,
  type LimitedBannerDismissal,
} from "@/lib/rate-limits/limited-profiles";

/**
 * Dismissed limit banners, per host: `hostId` → banner key → the limit
 * episode the user hid (its `resetsAt`, `null` for a limit with no reset
 * time) and when.
 *
 * The episode is the reset time, so a new limit on the same account (a
 * different `resetsAt`) is not covered by an old entry and its banner shows.
 * Host first because the popover shows one host's usage at a time and the
 * same account on another machine is a different reading.
 */
export type LimitedBannerDismissals = Readonly<
  Record<string, Readonly<Record<string, LimitedBannerDismissal>>>
>;

interface LimitedBannerDismissalsState {
  readonly dismissals: LimitedBannerDismissals;
  readonly dismiss: (
    hostId: string,
    bannerKey: string,
    resetsAt: number | null,
    now: number,
  ) => void;
  /**
   * Drops every entry that can no longer hide anything: an expired one, on
   * any host (a timed entry past its reset, a no-reset entry a day old -
   * `isLimitedBannerDismissalExpired`), and - on `hostId` only - any entry whose
   * account a live reading received AFTER the dismissal shows not limited
   * (`clearedReadings`: banner key → when that reading arrived), so the next
   * limit shows its banner even when it keeps the same reset time (a reset
   * credit spent mid-window) or has none. A reading that predates the
   * dismissal is not evidence (another window's older cache), and an account
   * with no live reading (loading, cold, failed) is not either, so its entry
   * stays.
   */
  readonly prune: (
    hostId: string,
    clearedReadings: ReadonlyMap<string, number>,
    now: number,
  ) => void;
}

const LIMITED_BANNER_DISMISSALS_PERSIST_KEY = persistKey(
  STORE_KEYS.limitedBannerDismissals,
);

function persistedDismissal(value: unknown): LimitedBannerDismissal | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("resetsAt" in value) || !("dismissedAt" in value)) return null;
  const { resetsAt, dismissedAt } = value;
  if (typeof dismissedAt !== "number" || !Number.isFinite(dismissedAt)) {
    return null;
  }
  if (resetsAt === null) return { resetsAt, dismissedAt };
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  return { resetsAt, dismissedAt };
}

function persistedDismissals(persistedState: unknown): LimitedBannerDismissals {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  if (!("dismissals" in persistedState)) return {};
  const byHost = persistedState.dismissals;
  if (typeof byHost !== "object" || byHost === null) return {};
  const result: Record<string, Record<string, LimitedBannerDismissal>> = {};
  const hosts: ReadonlyArray<[string, unknown]> = Object.entries(byHost);
  for (const [hostId, entries] of hosts) {
    if (typeof entries !== "object" || entries === null) continue;
    const kept: Record<string, LimitedBannerDismissal> = {};
    const banners: ReadonlyArray<[string, unknown]> = Object.entries(entries);
    for (const [bannerKey, value] of banners) {
      const dismissal = persistedDismissal(value);
      if (dismissal !== null) kept[bannerKey] = dismissal;
    }
    if (Object.keys(kept).length > 0) result[hostId] = kept;
  }
  return result;
}

/**
 * The store is one per renderer and hydrates once; the record is
 * localStorage, shared by every window, and persist writes the WHOLE map on
 * every `set`. So each mutation re-reads storage first - `rehydrate` applies
 * synchronously for localStorage (the `feature-announcements-store.ts`
 * claim) - and a window that has not yet handled another window's
 * asynchronous `storage` event computes from that window's write rather than
 * writing its stale map back over it. Not atomic across processes: two
 * windows mutating within Chromium's replication (milliseconds) can still
 * race, and the cost is one banner to hide again.
 */
function readLatest(): void {
  void useLimitedBannerDismissalsStore.persist.rehydrate();
}

export const useLimitedBannerDismissalsStore =
  create<LimitedBannerDismissalsState>()(
    persist(
      (set, get) => ({
        dismissals: {},
        dismiss: (hostId, bannerKey, resetsAt, now) => {
          readLatest();
          const dismissals = get().dismissals;
          const entries = dismissals[hostId] ?? {};
          if (
            Object.hasOwn(entries, bannerKey) &&
            entries[bannerKey].resetsAt === resetsAt
          ) {
            return;
          }
          set({
            dismissals: {
              ...dismissals,
              [hostId]: {
                ...entries,
                [bannerKey]: { resetsAt, dismissedAt: now },
              },
            },
          });
        },
        prune: (hostId, clearedReadings, now) => {
          readLatest();
          let changed = false;
          const next: Record<
            string,
            Record<string, LimitedBannerDismissal>
          > = {};
          for (const [entryHostId, entries] of Object.entries(
            get().dismissals,
          )) {
            const kept: Record<string, LimitedBannerDismissal> = {};
            for (const [bannerKey, dismissal] of Object.entries(entries)) {
              const clearedAt =
                entryHostId === hostId
                  ? (clearedReadings.get(bannerKey) ?? null)
                  : null;
              const stale =
                (clearedAt !== null && clearedAt > dismissal.dismissedAt) ||
                isLimitedBannerDismissalExpired(dismissal, now);
              if (stale) {
                changed = true;
              } else {
                kept[bannerKey] = dismissal;
              }
            }
            if (Object.keys(kept).length > 0) next[entryHostId] = kept;
          }
          // No `set` when nothing changed: persist writes on every `set`,
          // unchanged or not, and a write is what a stale window must avoid.
          if (changed) set({ dismissals: next });
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

// Propagation: a dismissal in one window hides the banner in every window of
// this device without waiting for that window's next mutation.
installCrossWindowRehydrate(
  useLimitedBannerDismissalsStore,
  LIMITED_BANNER_DISMISSALS_PERSIST_KEY,
);
