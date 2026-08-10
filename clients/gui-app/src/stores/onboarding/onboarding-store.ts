import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { ONBOARDING_ACTS } from "@/components/onboarding/onboarding-acts";
import { isProductIntroDisabled } from "@/lib/thanos-flags";

const LAST_STEP = ONBOARDING_ACTS.length - 1;
const clampStep = (step: number): number =>
  Math.min(Math.max(Math.trunc(step), 0), LAST_STEP);

/**
 * First-launch onboarding state, persisted locally so the tour runs once per
 * machine. `completedAt` is set when the tour is finished or skipped; `step`
 * is intentionally session-local so a closed or replayed tour starts from the
 * first act instead of resuming from the last viewed page.
 *
 * Thanos Traycer: product intro is disabled outside tests — start/hydrate as
 * completed so the cinematic tour never blocks the app.
 */
interface OnboardingState {
  readonly completedAt: number | null;
  readonly step: number;
  /** Next act, or complete the tour if already on the last one. */
  readonly advance: () => void;
  /** Previous act (no-op on the first). */
  readonly retreat: () => void;
  /** Finish the tour (also used by skip). */
  readonly complete: () => void;
  /** Return to the first act without changing completion state. */
  readonly restart: () => void;
  /** Clear completion and return to the first act. */
  readonly reset: () => void;
}

/** Current act, clamped so a persisted step can't outrun a shorter act list. */
export const selectStep = (state: OnboardingState): number =>
  clampStep(state.step);

export const selectIsLastStep = (state: OnboardingState): boolean =>
  selectStep(state) >= LAST_STEP;

const ONBOARDING_PERSIST_KEY = persistKey(STORE_KEYS.onboarding);

function persistedCompletedAt(persistedState: unknown): number | null {
  if (typeof persistedState !== "object" || persistedState === null) {
    return null;
  }
  if (!("completedAt" in persistedState)) return null;
  const completedAt = persistedState.completedAt;
  return typeof completedAt === "number" ? completedAt : null;
}

function initialCompletedAt(): number | null {
  return isProductIntroDisabled() ? 1 : null;
}

function resolveCompletedAt(persistedState: unknown): number | null {
  const fromDisk = persistedCompletedAt(persistedState);
  if (fromDisk !== null) return fromDisk;
  return initialCompletedAt();
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      completedAt: initialCompletedAt(),
      step: 0,
      advance: () => {
        const step = clampStep(get().step);
        if (step >= LAST_STEP) {
          set({ completedAt: Date.now() });
          return;
        }
        set({ step: step + 1 });
      },
      retreat: () => set({ step: clampStep(get().step - 1) }),
      complete: () => set({ completedAt: Date.now() }),
      restart: () => set({ step: 0 }),
      reset: () => set({ completedAt: null, step: 0 }),
    }),
    {
      ...basePersistOptions(ONBOARDING_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      merge: (persistedState, currentState) => ({
        ...currentState,
        completedAt: resolveCompletedAt(persistedState),
        step: 0,
      }),
      partialize: (state) => ({
        completedAt: state.completedAt,
      }),
    },
  ),
);
