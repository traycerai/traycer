import { create } from "zustand";
import type {
  SweepReviewSnapshot,
  SweepSessionOutcome,
} from "@/lib/epics/sweep-consequences";

/**
 * A consequences review that a proof produced for a session, waiting for the
 * dialog to show it.
 */
export interface ParkedSweepReview {
  readonly snapshot: SweepReviewSnapshot;
  readonly outcomes: ReadonlyMap<string, SweepSessionOutcome>;
}

/**
 * What a Sweep session owes across the dialog's lifetime - the part that must NOT live in
 * component state, because the flow never holds the user.
 */
interface SweepSessionState {
  readonly proving: ReadonlySet<string>;
  readonly parked: ReadonlyMap<string, ParkedSweepReview>;
  readonly open: ReadonlySet<string>;
  readonly beginProving: (sessionKey: string) => void;
  readonly endProving: (sessionKey: string) => void;
  readonly park: (sessionKey: string, review: ParkedSweepReview) => void;
  /** Removes and returns the parked review, or `null` when there is none. */
  readonly take: (sessionKey: string) => ParkedSweepReview | null;
  readonly setOpen: (sessionKey: string, open: boolean) => void;
  readonly reset: () => void;
}

function withKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (set.has(key)) return set;
  const next = new Set(set);
  next.add(key);
  return next;
}

function withoutKey(
  set: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

export const useSweepSessionStore = create<SweepSessionState>((set, get) => ({
  proving: new Set(),
  parked: new Map(),
  open: new Set(),
  beginProving: (sessionKey) =>
    set((state) => ({ proving: withKey(state.proving, sessionKey) })),
  endProving: (sessionKey) =>
    set((state) => ({ proving: withoutKey(state.proving, sessionKey) })),
  park: (sessionKey, review) =>
    set((state) => {
      const parked = new Map(state.parked);
      parked.set(sessionKey, review);
      return { parked };
    }),
  take: (sessionKey) => {
    const review = get().parked.get(sessionKey) ?? null;
    if (review === null) return null;
    set((state) => {
      const parked = new Map(state.parked);
      parked.delete(sessionKey);
      return { parked };
    });
    return review;
  },
  setOpen: (sessionKey, open) =>
    set((state) => ({
      open: open
        ? withKey(state.open, sessionKey)
        : withoutKey(state.open, sessionKey),
    })),
  reset: () => set({ proving: new Set(), parked: new Map(), open: new Set() }),
}));
