import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** How long after this install first sees the nudge before it may show. */
const FIRST_SHOW_DELAY_MS = 24 * HOUR_MS;
/** A showing that ended without a decision: the countdown ran out, or "Remind me later". */
const SHORT_COOLDOWN_MS = 3 * DAY_MS;
/** A showing the person closed, or a share dialog closed without posting. */
const LONG_COOLDOWN_MS = 14 * DAY_MS;
/** Showings the person acted on, after which the nudge stops for good. */
const MAX_COUNTED_SHOWINGS = 3;

/**
 * What this install has done with the "share Traycer on X" nudge. Machine-
 * local, like the feature announcements: it records what this install has
 * asked, not who is signed in.
 */
export interface ShareOnXNudgeRecord {
  /** When this install first could have shown the nudge; `null` until then. */
  readonly firstSeenAt: number | null;
  readonly optedOut: boolean;
  /** When the person last opened X from the share dialog. */
  readonly postedAt: number | null;
  /** Showings that count toward the cap (an untouched timeout does not). */
  readonly countedShowings: number;
  /** The nudge may not show before this time. */
  readonly nextEligibleAt: number;
}

interface ShareOnXNudgeState extends ShareOnXNudgeRecord {
  /** Start the first-show delay. Idempotent. */
  readonly noteSeen: (now: number) => void;
  /**
   * Take the next showing for THIS window, answering whether it may show the
   * toast. Re-reads storage first, and on success pushes `nextEligibleAt` out
   * at once, so a second window that asks a moment later is refused.
   */
  readonly claimShowing: (now: number) => boolean;
  readonly recordTimeout: (now: number) => void;
  readonly recordRemindLater: (now: number) => void;
  readonly recordClose: (now: number) => void;
  readonly recordDialogAbandoned: (now: number) => void;
  readonly recordOptOut: () => void;
  readonly recordPosted: (now: number) => void;
}

const INITIAL_RECORD: ShareOnXNudgeRecord = {
  firstSeenAt: null,
  optedOut: false,
  postedAt: null,
  countedShowings: 0,
  nextEligibleAt: 0,
};

const SHARE_ON_X_NUDGE_PERSIST_KEY = persistKey(STORE_KEYS.shareOnXNudge);

/** Whether the nudge may show at `now`, from the record alone. */
export function isShareOnXNudgeEligible(
  record: ShareOnXNudgeRecord,
  now: number,
): boolean {
  if (record.firstSeenAt === null) return false;
  if (record.optedOut || record.postedAt !== null) return false;
  if (record.countedShowings >= MAX_COUNTED_SHOWINGS) return false;
  if (now < record.firstSeenAt + FIRST_SHOW_DELAY_MS) return false;
  return now >= record.nextEligibleAt;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Each field read on its own: a corrupt field falls back to its initial
 * value rather than discarding the rest. `optedOut` only reads `true` when it
 * was stored as `true`, so a corrupt record can never opt someone back in
 * without asking them, only re-arm a delay.
 */
function persistedRecord(persistedState: unknown): ShareOnXNudgeRecord {
  if (typeof persistedState !== "object" || persistedState === null) {
    return INITIAL_RECORD;
  }
  const read = (key: string): unknown => Reflect.get(persistedState, key);
  const showings = finiteOr(read("countedShowings"), 0);
  return {
    firstSeenAt: finiteOrNull(read("firstSeenAt")),
    optedOut: read("optedOut") === true,
    postedAt: finiteOrNull(read("postedAt")),
    countedShowings: Math.max(0, Math.floor(showings)),
    nextEligibleAt: finiteOr(read("nextEligibleAt"), 0),
  };
}

export const useShareOnXNudgeStore = create<ShareOnXNudgeState>()(
  persist(
    (set, get) => ({
      ...INITIAL_RECORD,
      noteSeen: (now) => {
        if (get().firstSeenAt !== null) return;
        set({ firstSeenAt: now });
      },
      claimShowing: (now) => {
        // Same reasoning as `useFeatureAnnouncementsStore.claim`: storage is
        // shared by every window, each window's store hydrated once, and a
        // synchronous storage makes this rehydrate apply inline.
        void useShareOnXNudgeStore.persist.rehydrate();
        if (!isShareOnXNudgeEligible(get(), now)) return false;
        set({ nextEligibleAt: now + SHORT_COOLDOWN_MS });
        return true;
      },
      recordTimeout: (now) => {
        set({ nextEligibleAt: now + SHORT_COOLDOWN_MS });
      },
      recordRemindLater: (now) => {
        set((state) => ({
          nextEligibleAt: now + SHORT_COOLDOWN_MS,
          countedShowings: state.countedShowings + 1,
        }));
      },
      recordClose: (now) => {
        set((state) => ({
          nextEligibleAt: now + LONG_COOLDOWN_MS,
          countedShowings: state.countedShowings + 1,
        }));
      },
      recordDialogAbandoned: (now) => {
        set((state) => ({
          nextEligibleAt: now + LONG_COOLDOWN_MS,
          countedShowings: state.countedShowings + 1,
        }));
      },
      recordOptOut: () => {
        set({ optedOut: true });
      },
      recordPosted: (now) => {
        set({ postedAt: now });
      },
    }),
    {
      ...basePersistOptions(SHARE_ON_X_NUDGE_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...persistedRecord(persistedState),
      }),
      partialize: (state): ShareOnXNudgeRecord => ({
        firstSeenAt: state.firstSeenAt,
        optedOut: state.optedOut,
        postedAt: state.postedAt,
        countedShowings: state.countedShowings,
        nextEligibleAt: state.nextEligibleAt,
      }),
    },
  ),
);

// Another window recorded an outcome: follow it, so this window's next claim
// starts from the install's record.
installCrossWindowRehydrate(
  useShareOnXNudgeStore,
  SHARE_ON_X_NUDGE_PERSIST_KEY,
);
