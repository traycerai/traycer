import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * The tour's length is a per-host fact - an act whose capability the bound host
 * lacks is dropped from the list (`onboardingActsFor`) - so the store cannot
 * derive its own bounds from the act catalog. Every caller passes the count of
 * the act list it is actually showing.
 */
const lastStepOf = (actCount: number): number => Math.max(0, actCount - 1);

/** Current act, clamped so a step can't outrun the act list being shown. */
export const clampOnboardingStep = (step: number, actCount: number): number =>
  Math.min(Math.max(Math.trunc(step), 0), lastStepOf(actCount));

export const isLastOnboardingStep = (step: number, actCount: number): boolean =>
  clampOnboardingStep(step, actCount) >= lastStepOf(actCount);

/**
 * First-launch onboarding state, persisted locally so the tour runs once per
 * machine. `completedAt` is set when the tour is finished or skipped; `step`
 * is intentionally session-local so a closed or replayed tour starts from the
 * first act instead of resuming from the last viewed page. The store owns step
 * movement and bounds - callers just invoke the actions.
 */
interface OnboardingState {
  readonly completedAt: number | null;
  readonly step: number;
  /** Next act, or complete the tour if already on the last one. */
  readonly advance: (actCount: number) => void;
  /** Previous act (no-op on the first). */
  readonly retreat: (actCount: number) => void;
  /** Finish the tour (also used by skip). */
  readonly complete: () => void;
  /** Return to the first act without changing completion state. */
  readonly restart: () => void;
  /** Clear completion and return to the first act. */
  readonly reset: () => void;
}

const ONBOARDING_PERSIST_KEY = persistKey(STORE_KEYS.onboarding);

function persistedCompletedAt(persistedState: unknown): number | null {
  if (typeof persistedState !== "object" || persistedState === null) {
    return null;
  }
  if (!("completedAt" in persistedState)) return null;
  const completedAt = persistedState.completedAt;
  return typeof completedAt === "number" ? completedAt : null;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      completedAt: null,
      step: 0,
      advance: (actCount) => {
        const step = clampOnboardingStep(get().step, actCount);
        if (step >= lastStepOf(actCount)) {
          set({ completedAt: Date.now() });
          return;
        }
        set({ step: step + 1 });
      },
      // Clamped from the same place the page reads: when the act list shrinks
      // under a user who is past its new end, Back must leave the act they can
      // see rather than step down to the same clamped one.
      retreat: (actCount) =>
        set({
          step: Math.max(0, clampOnboardingStep(get().step, actCount) - 1),
        }),
      complete: () => set({ completedAt: Date.now() }),
      restart: () => set({ step: 0 }),
      reset: () => set({ completedAt: null, step: 0 }),
    }),
    {
      ...basePersistOptions(ONBOARDING_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        completedAt: persistedCompletedAt(persistedState),
        step: 0,
      }),
      partialize: (state) => ({
        completedAt: state.completedAt,
      }),
    },
  ),
);
