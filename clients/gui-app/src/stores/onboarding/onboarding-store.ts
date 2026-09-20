import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  availableSetupGuideIds,
  setupGuide,
  setupGuideCompletedBy,
  setupGuideLength,
  SETUP_GUIDE_IDS,
  type SetupGuideEvent,
  type SetupGuideId,
  type SetupGuideShell,
} from "@/stores/onboarding/setup-guides";

const setupProgressSchema = z.object({
  agents: z.number().int().min(-1).max(setupGuideLength("agents")).catch(-1),
  appearance: z
    .number()
    .int()
    .min(-1)
    .max(setupGuideLength("appearance"))
    .catch(-1),
  cookies: z.number().int().min(-1).max(setupGuideLength("cookies")).catch(-1),
});
const emptySetupProgress = { agents: -1, appearance: -1, cookies: -1 };
/** Every guide at its own length, which is the value that means complete. */
const completedSetupProgress = (): Record<SetupGuideId, number> => ({
  agents: setupGuideLength("agents"),
  appearance: setupGuideLength("appearance"),
  cookies: setupGuideLength("cookies"),
});

const lastStepOf = (stepCount: number): number => Math.max(0, stepCount - 1);

/** Current step, clamped so a step can't outrun the step list being shown. */
export const clampOnboardingStep = (step: number, stepCount: number): number =>
  Math.min(Math.max(Math.trunc(step), 0), lastStepOf(stepCount));

export const isLastOnboardingStep = (
  step: number,
  stepCount: number,
): boolean => clampOnboardingStep(step, stepCount) >= lastStepOf(stepCount);

/**
 * Onboarding and optional setup progress, persisted locally. The tour runs once per
 * machine. `completedAt` is set when the tour is finished or skipped; `step`
 * is intentionally session-local so a closed or replayed tour starts from the
 * first step instead of resuming from the last viewed page. The store owns step
 * movement and bounds - callers just invoke the actions.
 */
interface OnboardingState {
  readonly setupReminderDismissed: boolean;
  readonly dismissSetupReminder: () => void;
  readonly setupProgress: Record<SetupGuideId, number>;
  readonly activeSetup: {
    readonly id: SetupGuideId;
    readonly step: number;
  } | null;
  readonly startSetup: (id: SetupGuideId) => void;
  readonly advanceSetup: () => void;
  readonly retreatSetup: () => void;
  readonly completeSetup: (id: SetupGuideId) => void;
  /**
   * The product reporting something a guide may be waiting for. Whichever
   * guide the step table says cares is advanced or completed; a call site
   * names the event, never a guide.
   */
  readonly notifySetupEvent: (event: SetupGuideEvent) => void;
  readonly completedAt: number | null;
  readonly step: number;
  /** Next step, or complete the tour if already on the last one. */
  readonly advance: (stepCount: number) => void;
  /** Previous step (no-op on the first). */
  readonly retreat: (stepCount: number) => void;
  /** Finish the tour (also used by skip). */
  readonly complete: () => void;
  /** Return to the first step without changing completion state. */
  readonly restart: () => void;
  /**
   * Put the position on `step` directly: the page's re-seat when the step
   * list changes under the user and the step they were on now sits at another
   * index. Not a navigation, so it records nothing and completes nothing.
   */
  readonly reseat: (step: number) => void;
  /** Clear completion and return to the first step. */
  readonly reset: () => void;
}

/**
 * The tour plus the setup guides this shell can actually offer. A guide that
 * can never be completed here is not a step the checklist is waiting for, so
 * it is no part of the denominator either.
 */
export function onboardingGuideCount(shell: SetupGuideShell): number {
  return 1 + availableSetupGuideIds(shell).length;
}

export function onboardingCompletedCount(
  state: Pick<OnboardingState, "completedAt" | "setupProgress">,
  shell: SetupGuideShell,
): number {
  return (
    Number(state.completedAt !== null) +
    availableSetupGuideIds(shell).filter(
      (id) => state.setupProgress[id] >= setupGuideLength(id),
    ).length
  );
}

const ONBOARDING_PERSIST_KEY = persistKey(STORE_KEYS.onboarding);
/** v2 settles the checklist - see `migrateOnboardingPersistedState`. */
export const ONBOARDING_PERSIST_VERSION = 2;

function persistedCompletedAt(persistedState: unknown): number | null {
  if (typeof persistedState !== "object" || persistedState === null) {
    return null;
  }
  if (!("completedAt" in persistedState)) return null;
  const completedAt = persistedState.completedAt;
  return typeof completedAt === "number" ? completedAt : null;
}

/** Exactly what this store keeps in localStorage - see `partialize` below. */
interface OnboardingPersistedState {
  readonly completedAt: number | null;
  readonly setupReminderDismissed: boolean;
  readonly setupProgress: Record<SetupGuideId, number>;
}

/**
 * The one reader for a persisted blob, so a rehydration and a migration see
 * the same sanitized state rather than each making their own guesses about a
 * shape localStorage is free to hold anything in.
 */
function readOnboardingPersistedState(
  persistedState: unknown,
): OnboardingPersistedState {
  return {
    completedAt: persistedCompletedAt(persistedState),
    setupReminderDismissed: z
      .object({ setupReminderDismissed: z.boolean().catch(false) })
      .catch({ setupReminderDismissed: false })
      .parse(persistedState).setupReminderDismissed,
    setupProgress: setupProgressSchema
      .catch(emptySetupProgress)
      .parse(
        typeof persistedState === "object" &&
          persistedState !== null &&
          "setupProgress" in persistedState
          ? (persistedState.setupProgress ?? {})
          : {},
      ),
  };
}

/**
 * v2 settles the checklist for anyone who finished onboarding before it
 * existed: they have been using the app already, so three untouched cards and
 * a reminder toast are a nag about work they are not waiting on. Only an
 * untouched checklist is settled - someone part-way through a guide keeps
 * their progress and is still offered the rest of it. `migrate` runs on the
 * version bump alone, which is exactly the once this should happen.
 */
function migrateOnboardingPersistedState(
  persistedState: unknown,
): OnboardingPersistedState {
  const persisted = readOnboardingPersistedState(persistedState);
  if (
    persisted.completedAt === null ||
    SETUP_GUIDE_IDS.some((id) => persisted.setupProgress[id] !== -1)
  )
    return persisted;
  return {
    ...persisted,
    setupProgress: completedSetupProgress(),
    setupReminderDismissed: true,
  };
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set, get) => ({
      setupReminderDismissed: false,
      dismissSetupReminder: () => set({ setupReminderDismissed: true }),
      setupProgress: emptySetupProgress,
      activeSetup: null,
      startSetup: (id) => {
        const progress = get().setupProgress[id];
        set({
          setupProgress: {
            ...get().setupProgress,
            [id]: Math.max(0, progress),
          },
          activeSetup: {
            id,
            step: progress >= setupGuideLength(id) ? 0 : Math.max(0, progress),
          },
        });
      },
      advanceSetup: () => {
        const active = get().activeSetup;
        if (active === null) return;
        // A step the product finishes is never walked off by Continue: the
        // guide waits there until the real thing happens, so it may walk its
        // steps and still never run off the end of them.
        if (setupGuide(active.id).steps[active.step].completesOn !== undefined)
          return;
        const step = active.step + 1;
        set({
          setupProgress: {
            ...get().setupProgress,
            [active.id]: Math.max(step, get().setupProgress[active.id]),
          },
          activeSetup:
            step >= setupGuideLength(active.id)
              ? null
              : { id: active.id, step },
        });
      },
      retreatSetup: () => {
        const active = get().activeSetup;
        if (active !== null && active.step > 0)
          set({ activeSetup: { ...active, step: active.step - 1 } });
      },
      completeSetup: (id) =>
        set({
          setupProgress: {
            ...get().setupProgress,
            [id]: setupGuideLength(id),
          },
          activeSetup: get().activeSetup?.id === id ? null : get().activeSetup,
        }),
      notifySetupEvent: (event) => {
        // Completion does not need the guide to be running: the user may have
        // done the thing on their own, and the card is about the state of the
        // account, not about a card being open.
        const completed = setupGuideCompletedBy(event);
        if (completed !== null) get().completeSetup(completed);
        const active = get().activeSetup;
        if (
          active !== null &&
          setupGuide(active.id).steps[active.step].advanceOn === event
        )
          get().advanceSetup();
      },
      completedAt: null,
      step: 0,
      advance: (stepCount) => {
        const step = clampOnboardingStep(get().step, stepCount);
        if (step >= lastStepOf(stepCount)) {
          set({ completedAt: Date.now() });
          return;
        }
        set({ step: step + 1 });
      },
      // Clamped from the same place the page reads: when the step list shrinks
      // under a user who is past its new end, Back must leave the step they can
      // see rather than step down to the same clamped one.
      retreat: (stepCount) =>
        set({
          step: Math.max(0, clampOnboardingStep(get().step, stepCount) - 1),
        }),
      complete: () => set({ completedAt: Date.now() }),
      restart: () => set({ step: 0 }),
      reseat: (step) => set({ step: Math.max(0, step) }),
      reset: () =>
        set({
          completedAt: null,
          step: 0,
          setupReminderDismissed: false,
          setupProgress: emptySetupProgress,
          activeSetup: null,
        }),
    }),
    {
      ...basePersistOptions(ONBOARDING_PERSIST_KEY),
      version: ONBOARDING_PERSIST_VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState) =>
        migrateOnboardingPersistedState(persistedState),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...readOnboardingPersistedState(persistedState),
        activeSetup: null,
        step: 0,
      }),
      partialize: (state) => ({
        completedAt: state.completedAt,
        setupReminderDismissed: state.setupReminderDismissed,
        setupProgress: state.setupProgress,
      }),
    },
  ),
);
