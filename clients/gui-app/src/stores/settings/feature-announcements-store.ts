import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Features this install has been told about, once each.
 *
 * Keyed by FEATURE, not by app version: the surface that announces a feature
 * is the first one to show it - a toast for a user who has already finished
 * onboarding, the tour act for one who has not - and either consumes the id,
 * so exactly one of them ever appears per install and skipping the tour act
 * does not resurrect the toast. A version-keyed "what's new" would need a
 * version compare against `snapshot.currentVersion`, which is empty without a
 * desktop bridge; a feature id needs nothing. A future announcement is one
 * more member of the union.
 *
 * The timestamp is when the id was consumed, kept for support reports rather
 * than read by any surface.
 */
export type FeatureAnnouncementId = "login-import";

const FEATURE_ANNOUNCEMENT_IDS: ReadonlyArray<FeatureAnnouncementId> = [
  "login-import",
];

type ConsumedAnnouncements = Readonly<
  Partial<Record<FeatureAnnouncementId, number>>
>;

interface FeatureAnnouncementsState {
  readonly consumed: ConsumedAnnouncements;
  /** Record that `id` has been shown on some surface. Idempotent. */
  readonly consume: (id: FeatureAnnouncementId) => void;
}

const FEATURE_ANNOUNCEMENTS_PERSIST_KEY = persistKey(
  STORE_KEYS.featureAnnouncements,
);

function isFeatureAnnouncementId(
  value: string,
): value is FeatureAnnouncementId {
  return FEATURE_ANNOUNCEMENT_IDS.some((id) => id === value);
}

/**
 * Only the ids this build knows, each with a finite timestamp: an id a later
 * build retired is dropped, and a corrupt entry reads as "not consumed" -
 * one extra announcement, never a stuck one.
 */
function persistedConsumed(persistedState: unknown): ConsumedAnnouncements {
  if (typeof persistedState !== "object" || persistedState === null) {
    return {};
  }
  if (!("consumed" in persistedState)) return {};
  const consumed = persistedState.consumed;
  if (typeof consumed !== "object" || consumed === null) return {};
  const next: Partial<Record<FeatureAnnouncementId, number>> = {};
  for (const [id, at] of Object.entries(consumed)) {
    if (!isFeatureAnnouncementId(id)) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    next[id] = at;
  }
  return next;
}

export const useFeatureAnnouncementsStore = create<FeatureAnnouncementsState>()(
  persist(
    (set) => ({
      consumed: {},
      consume: (id) => {
        set((state) => {
          if (Object.hasOwn(state.consumed, id)) return state;
          return { consumed: { ...state.consumed, [id]: Date.now() } };
        });
      },
    }),
    {
      ...basePersistOptions(FEATURE_ANNOUNCEMENTS_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        consumed: persistedConsumed(persistedState),
      }),
      partialize: (state) => ({ consumed: state.consumed }),
    },
  ),
);

export function isFeatureAnnouncementConsumed(
  consumed: ConsumedAnnouncements,
  id: FeatureAnnouncementId,
): boolean {
  return Object.hasOwn(consumed, id);
}
