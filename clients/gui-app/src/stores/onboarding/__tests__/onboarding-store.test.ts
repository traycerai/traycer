import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { ONBOARDING_STEPS } from "@/components/onboarding/onboarding-steps";
import {
  clampOnboardingStep,
  isLastOnboardingStep,
  ONBOARDING_GUIDE_COUNT,
  onboardingCompletedCount,
  useOnboardingStore,
} from "@/stores/onboarding/onboarding-store";

const PERSIST_KEY = persistKey(STORE_KEYS.onboarding);
const STEP_COUNT = ONBOARDING_STEPS.length;
const LAST_STEP = STEP_COUNT - 1;

function resetStore(): void {
  window.localStorage.clear();
  useOnboardingStore.setState({
    setupProgress: { agents: -1, appearance: -1, cookies: -1 },
    setupReminderDismissed: false,
    activeSetup: null,
    completedAt: null,
    step: 0,
  });
}

describe("useOnboardingStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("initializes on the first step, not yet complete", () => {
    expect(useOnboardingStore.getState().completedAt).toBeNull();
    expect(useOnboardingStore.getState().step).toBe(0);
    expect(useOnboardingStore.getState().setupProgress).toEqual({
      agents: -1,
      appearance: -1,
      cookies: -1,
    });
    expect(useOnboardingStore.getState().activeSetup).toBeNull();
    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
  });

  it("counts only the completed tour and setup guides", () => {
    expect(onboardingCompletedCount(useOnboardingStore.getState())).toBe(0);

    useOnboardingStore.setState({
      setupProgress: { agents: 0, appearance: 2, cookies: 0 },
    });
    expect(onboardingCompletedCount(useOnboardingStore.getState())).toBe(0);

    useOnboardingStore.getState().complete();
    useOnboardingStore.getState().completeSetup("agents");
    useOnboardingStore.getState().completeSetup("cookies");
    expect(onboardingCompletedCount(useOnboardingStore.getState())).toBe(3);

    useOnboardingStore.getState().completeSetup("appearance");
    expect(onboardingCompletedCount(useOnboardingStore.getState())).toBe(
      ONBOARDING_GUIDE_COUNT,
    );
  });

  it("preserves completion count when a completed setup guide is replayed", () => {
    useOnboardingStore.getState().completeSetup("appearance");
    const completedCount = onboardingCompletedCount(
      useOnboardingStore.getState(),
    );

    useOnboardingStore.getState().startSetup("appearance");

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 0,
    });
    expect(onboardingCompletedCount(useOnboardingStore.getState())).toBe(
      completedCount,
    );
  });

  it("starts, pauses, and resumes appearance at its saved step", () => {
    const store = useOnboardingStore.getState();
    store.startSetup("appearance");
    store.advanceSetup();
    store.pauseSetup();

    expect(useOnboardingStore.getState().activeSetup).toBeNull();
    expect(useOnboardingStore.getState().setupProgress.appearance).toBe(1);

    useOnboardingStore.getState().startSetup("appearance");

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 1,
    });
  });

  it("retreats an active setup step without changing saved progress or completion", () => {
    const completedAt = 1_600_000_000_000;
    useOnboardingStore.setState({
      completedAt,
      setupProgress: { agents: 0, appearance: 2, cookies: 0 },
      activeSetup: { id: "appearance", step: 2 },
    });
    useOnboardingStore.getState().retreatSetup();

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 1,
    });
    expect(useOnboardingStore.getState().setupProgress).toEqual({
      agents: 0,
      appearance: 2,
      cookies: 0,
    });
    expect(useOnboardingStore.getState().completedAt).toBe(completedAt);

    useOnboardingStore.getState().retreatSetup();
    useOnboardingStore.getState().retreatSetup();
    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 0,
    });
  });

  it("completes appearance after its third step and replays from the start without losing completion", () => {
    useOnboardingStore.getState().startSetup("appearance");
    useOnboardingStore.getState().advanceSetup();
    useOnboardingStore.getState().advanceSetup();
    useOnboardingStore.getState().advanceSetup();

    expect(useOnboardingStore.getState().activeSetup).toBeNull();
    expect(useOnboardingStore.getState().setupProgress.appearance).toBe(3);

    useOnboardingStore.getState().startSetup("appearance");

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "appearance",
      step: 0,
    });
    expect(useOnboardingStore.getState().setupProgress.appearance).toBe(3);
  });

  it("requires the cookie import result to complete the cookie guide", () => {
    useOnboardingStore.getState().startSetup("cookies");
    useOnboardingStore.getState().advanceSetup();

    expect(useOnboardingStore.getState().activeSetup).toEqual({
      id: "cookies",
      step: 0,
    });
    expect(useOnboardingStore.getState().setupProgress.cookies).toBe(0);

    useOnboardingStore.getState().completeSetup("cookies");

    expect(useOnboardingStore.getState().activeSetup).toBeNull();
    expect(useOnboardingStore.getState().setupProgress.cookies).toBe(1);
  });

  it("complete marks the tour done with a timestamp", () => {
    useOnboardingStore.getState().complete();

    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
  });

  it("advance moves to the next step for the active session", () => {
    useOnboardingStore.getState().advance(STEP_COUNT);

    expect(useOnboardingStore.getState().step).toBe(1);
  });

  it("advance on the last step completes the tour instead of overrunning", () => {
    useOnboardingStore.setState({ step: LAST_STEP });

    useOnboardingStore.getState().advance(STEP_COUNT);

    expect(useOnboardingStore.getState().step).toBe(LAST_STEP);
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
  });

  it("advance completes on the last step of a shorter tour", () => {
    const shorterCount = STEP_COUNT - 1;
    useOnboardingStore.setState({ step: shorterCount - 1 });

    useOnboardingStore.getState().advance(shorterCount);

    expect(useOnboardingStore.getState().step).toBe(shorterCount - 1);
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
  });

  it("retreat moves back and clamps at the first step", () => {
    useOnboardingStore.setState({ step: 2 });
    useOnboardingStore.getState().retreat(STEP_COUNT);
    expect(useOnboardingStore.getState().step).toBe(1);

    useOnboardingStore.setState({ step: 0 });
    useOnboardingStore.getState().retreat(STEP_COUNT);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("retreat leaves the visible step when the tour shrinks under the user", () => {
    const shorterCount = STEP_COUNT - 1;
    useOnboardingStore.setState({ step: STEP_COUNT - 1 });

    useOnboardingStore.getState().retreat(shorterCount);

    expect(useOnboardingStore.getState().step).toBe(shorterCount - 2);
  });

  it("clampOnboardingStep holds a stale position inside the tour being shown", () => {
    expect(clampOnboardingStep(999, STEP_COUNT)).toBe(LAST_STEP);
    expect(clampOnboardingStep(999, STEP_COUNT - 1)).toBe(LAST_STEP - 1);
    expect(clampOnboardingStep(-3, STEP_COUNT)).toBe(0);
  });

  it("isLastOnboardingStep reflects whether the final step is showing", () => {
    expect(isLastOnboardingStep(0, STEP_COUNT)).toBe(false);
    expect(isLastOnboardingStep(LAST_STEP, STEP_COUNT)).toBe(true);
    expect(isLastOnboardingStep(LAST_STEP - 1, STEP_COUNT - 1)).toBe(true);
  });

  it("reset clears completion, step, and setup reminder dismissal", () => {
    useOnboardingStore.getState().complete();
    useOnboardingStore.getState().completeSetup("agents");
    useOnboardingStore.setState({ step: 4 });
    useOnboardingStore.getState().dismissSetupReminder();

    useOnboardingStore.getState().reset();

    expect(useOnboardingStore.getState().completedAt).toBeNull();
    expect(useOnboardingStore.getState().step).toBe(0);
    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(false);
    expect(onboardingCompletedCount(useOnboardingStore.getState())).toBe(0);
  });

  it("persists and rehydrates setup reminder dismissal", async () => {
    useOnboardingStore.getState().dismissSetupReminder();

    await useOnboardingStore.persist.rehydrate();

    expect(useOnboardingStore.getState().setupReminderDismissed).toBe(true);
    const raw = window.localStorage.getItem(PERSIST_KEY);
    const parsed = JSON.parse(raw ?? "{}") as {
      state?: { setupReminderDismissed?: boolean };
    };
    expect(parsed.state?.setupReminderDismissed).toBe(true);
  });

  it("restart returns to the first step without clearing completion", () => {
    useOnboardingStore.setState({ completedAt: 123, step: 4 });

    useOnboardingStore.getState().restart();

    expect(useOnboardingStore.getState().completedAt).toBe(123);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("reseat sets the position directly, clamped at 0, without touching completion", () => {
    useOnboardingStore.setState({ completedAt: 123, step: 0 });

    useOnboardingStore.getState().reseat(3);
    expect(useOnboardingStore.getState().step).toBe(3);
    expect(useOnboardingStore.getState().completedAt).toBe(123);

    useOnboardingStore.getState().reseat(-1);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("persists completedAt to localStorage under its store key", async () => {
    useOnboardingStore.getState().complete();

    // Let the persist middleware flush (microtask boundary is enough for
    // zustand/middleware persist with the default synchronous storage).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as {
      state?: { completedAt?: number | null };
    };
    expect(typeof parsed.state?.completedAt).toBe("number");
  });

  it("persists setup progress but not the active guide or step", async () => {
    useOnboardingStore.getState().complete();
    useOnboardingStore.setState({
      step: 2,
      setupProgress: { agents: 1, appearance: 2, cookies: 0 },
      activeSetup: { id: "appearance", step: 2 },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    const parsed = JSON.parse(raw ?? "{}") as {
      state?: Record<string, unknown>;
    };
    const keys = Object.keys(parsed.state ?? {}).sort();

    expect(keys).toEqual([
      "completedAt",
      "setupProgress",
      "setupReminderDismissed",
    ]);
    expect(parsed.state?.setupProgress).toEqual({
      agents: 1,
      appearance: 2,
      cookies: 0,
    });
    expect(parsed.state?.activeSetup).toBeUndefined();
  });

  it("rehydrates completion but ignores stale persisted step", async () => {
    const timestamp = 1_600_000_000_000;
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          completedAt: timestamp,
          step: 2,
          setupProgress: { agents: 0, appearance: 2, cookies: 1 },
          activeSetup: { id: "appearance", step: 2 },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useOnboardingStore.persist.rehydrate();

    expect(useOnboardingStore.getState().completedAt).toBe(timestamp);
    expect(useOnboardingStore.getState().step).toBe(0);
    expect(useOnboardingStore.getState().setupProgress).toEqual({
      agents: 0,
      appearance: 2,
      cookies: 1,
    });
    expect(useOnboardingStore.getState().activeSetup).toBeNull();
  });

  it("restores legacy state with default setup progress", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { completedAt: null, step: 3 },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useOnboardingStore.persist.rehydrate();

    expect(useOnboardingStore.getState().setupProgress).toEqual({
      agents: -1,
      appearance: -1,
      cookies: -1,
    });
    expect(useOnboardingStore.getState().activeSetup).toBeNull();
  });

  it("recovers safely from malformed persisted setup progress", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          completedAt: null,
          setupProgress: { agents: 10, appearance: "later", cookies: 0 },
          activeSetup: { id: "cookies", step: 0 },
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useOnboardingStore.persist.rehydrate();

    expect(useOnboardingStore.getState().setupProgress).toEqual({
      agents: -1,
      appearance: -1,
      cookies: 0,
    });
    expect(useOnboardingStore.getState().activeSetup).toBeNull();
  });
});
