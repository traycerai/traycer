import { create } from "zustand";
import type { LandingOwnerChoice } from "@/components/home/composer/landing-owner-model";

/** A draft not created yet keys its pick here, until the draft exists. */
export const NO_DRAFT_OWNER_KEY = "";

interface LandingOwnerState {
  /** The person's explicit Belongs to pick per landing draft. */
  readonly byDraftId: Readonly<Record<string, LandingOwnerChoice>>;
  readonly setChoice: (draftId: string, choice: LandingOwnerChoice) => void;
  /**
   * Carries a pick made before the draft existed onto the draft's new id, the
   * moment the draft is created.
   */
  readonly migrateChoice: (fromKey: string, toDraftId: string) => void;
  /** Forgets a draft's pick once its create is sent. */
  readonly clearChoice: (draftKey: string) => void;
  /** Forgets every pick: they name the signed-in account's teams. */
  readonly clearAll: () => void;
}

/**
 * The Belongs to pick per landing draft. Kept in memory: a draft with no pick
 * follows its resolved host's team.
 */
export const useLandingOwnerStore = create<LandingOwnerState>()((set) => ({
  byDraftId: {},
  setChoice: (draftId, choice) => {
    set((state) => ({ byDraftId: { ...state.byDraftId, [draftId]: choice } }));
  },
  clearChoice: (draftKey) => {
    set((state) => {
      if (!Object.hasOwn(state.byDraftId, draftKey)) return state;
      const { [draftKey]: _cleared, ...rest } = state.byDraftId;
      return { byDraftId: rest };
    });
  },
  migrateChoice: (fromKey, toDraftId) => {
    set((state) => {
      if (!Object.hasOwn(state.byDraftId, fromKey)) return state;
      const choice = state.byDraftId[fromKey];
      const { [fromKey]: _moved, ...rest } = state.byDraftId;
      return { byDraftId: { ...rest, [toDraftId]: choice } };
    });
  },
  clearAll: () => {
    set({ byDraftId: {} });
  },
}));

export function landingOwnerDraftKey(draftId: string | null): string {
  return draftId ?? NO_DRAFT_OWNER_KEY;
}
