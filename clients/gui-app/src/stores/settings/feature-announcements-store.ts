import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/** Features this install has been told about, once each. */
export type FeatureAnnouncementId = "login-import" | "session-import";

const FEATURE_ANNOUNCEMENT_IDS: ReadonlyArray<FeatureAnnouncementId> = [
  "login-import",
  "session-import",
];

type ConsumedAnnouncements = Readonly<
  Partial<Record<FeatureAnnouncementId, number>>
>;

interface FeatureAnnouncementsState {
  readonly consumed: ConsumedAnnouncements;
  /** Record that `id` has been shown on some surface. Idempotent. */
  readonly consume: (id: FeatureAnnouncementId) => void;
  /**
   * Take `id` for THIS surface, answering whether it got it: `true` exactly once per install,
   * `false` when some surface - in this window or another
   */
  readonly claim: (id: FeatureAnnouncementId) => boolean;
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
 * Only the ids this build knows, each with a finite timestamp: an id a later build retired is
 * dropped, and a corrupt entry reads as "not consumed" - one extra announcement, never a stuck
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

function consumeInto(
  consumed: ConsumedAnnouncements,
  id: FeatureAnnouncementId,
): ConsumedAnnouncements {
  if (Object.hasOwn(consumed, id)) return consumed;
  return { ...consumed, [id]: Date.now() };
}

export const useFeatureAnnouncementsStore = create<FeatureAnnouncementsState>()(
  persist(
    (set, get) => ({
      consumed: {},
      consume: (id) => {
        set((state) => {
          const consumed = consumeInto(state.consumed, id);
          return consumed === state.consumed ? state : { consumed };
        });
      },
      claim: (id) => {
        // The store is one per renderer and hydrates once, at module load; the install's record is
        // localStorage, shared by every window.
        void useFeatureAnnouncementsStore.persist.rehydrate();
        if (Object.hasOwn(get().consumed, id)) return false;
        set({ consumed: consumeInto(get().consumed, id) });
        return true;
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

// Another window consumed an announcement: follow it, so this window's surfaces read the install's
// record rather than their own hydration.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === FEATURE_ANNOUNCEMENTS_PERSIST_KEY) {
      void useFeatureAnnouncementsStore.persist.rehydrate();
    }
  });
}

export function isFeatureAnnouncementConsumed(
  consumed: ConsumedAnnouncements,
  id: FeatureAnnouncementId,
): boolean {
  return Object.hasOwn(consumed, id);
}
