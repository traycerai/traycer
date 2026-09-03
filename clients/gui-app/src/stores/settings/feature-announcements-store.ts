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
  /**
   * Take `id` for THIS surface, answering whether it got it: `true` exactly
   * once per install, `false` when some surface - in this window or another
   * - already has. A surface that shows something only on `true` holds the
   * once-per-install guarantee across windows, which {@link consume} alone
   * does not: it records on this window's copy of the store.
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
        // The store is one per renderer and hydrates once, at module load;
        // the install's record is localStorage, shared by every window. Two
        // windows restored together each hydrate `consumed` empty, and each
        // would show the announcement on its own copy. So the claim re-reads
        // storage first: `rehydrate` applies synchronously for a synchronous
        // storage (zustand wraps `getItem` in a thenable that runs inline
        // when it is not a promise), so the state below is what the other
        // window wrote, if it wrote. The `storage` listener at the bottom
        // keeps a window that did NOT claim in step afterwards; it is not
        // what makes this exclusive, since that event is asynchronous.
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

// Another window consumed an announcement: follow it, so this window's
// surfaces read the install's record rather than their own hydration. The
// `storage` event only fires in OTHER same-origin windows, never the one that
// wrote, so this cannot loop with `consume` / `claim`. `event.key === null`
// covers an explicit `localStorage.clear()`.
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
