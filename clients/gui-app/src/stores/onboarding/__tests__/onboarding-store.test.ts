import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import { ONBOARDING_ACTS } from "@/components/onboarding/onboarding-acts";
import {
  clampOnboardingStep,
  isLastOnboardingStep,
  useOnboardingStore,
} from "@/stores/onboarding/onboarding-store";

const PERSIST_KEY = persistKey(STORE_KEYS.onboarding);
// The full catalog is one host's tour; a host missing an optional capability
// runs a shorter one, which is why every bound below is a passed count.
const ACT_COUNT = ONBOARDING_ACTS.length;
const LAST_STEP = ACT_COUNT - 1;

function resetStore(): void {
  window.localStorage.clear();
  useOnboardingStore.setState({ completedAt: null, step: 0 });
}

describe("useOnboardingStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("initializes on the first act, not yet complete", () => {
    expect(useOnboardingStore.getState().completedAt).toBeNull();
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("complete marks the tour done with a timestamp", () => {
    useOnboardingStore.getState().complete();

    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
  });

  it("advance moves to the next act for the active session", () => {
    useOnboardingStore.getState().advance(ACT_COUNT);

    expect(useOnboardingStore.getState().step).toBe(1);
  });

  it("advance on the last act completes the tour instead of overrunning", () => {
    useOnboardingStore.setState({ step: LAST_STEP });

    useOnboardingStore.getState().advance(ACT_COUNT);

    expect(useOnboardingStore.getState().step).toBe(LAST_STEP);
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
  });

  it("advance completes on the last act of a SHORTER tour, not of the catalog", () => {
    const shorterCount = ACT_COUNT - 1;
    useOnboardingStore.setState({ step: shorterCount - 1 });

    useOnboardingStore.getState().advance(shorterCount);

    expect(useOnboardingStore.getState().step).toBe(shorterCount - 1);
    expect(typeof useOnboardingStore.getState().completedAt).toBe("number");
  });

  it("retreat moves back and clamps at the first act", () => {
    useOnboardingStore.setState({ step: 2 });
    useOnboardingStore.getState().retreat(ACT_COUNT);
    expect(useOnboardingStore.getState().step).toBe(1);

    useOnboardingStore.setState({ step: 0 });
    useOnboardingStore.getState().retreat(ACT_COUNT);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("retreat leaves the act the user can SEE when the tour shrank under them", () => {
    // An act retired mid-tour clamps the view to the new last act; Back has to
    // move off that act rather than land on it again.
    const shorterCount = ACT_COUNT - 1;
    useOnboardingStore.setState({ step: ACT_COUNT - 1 });

    useOnboardingStore.getState().retreat(shorterCount);

    expect(useOnboardingStore.getState().step).toBe(shorterCount - 2);
  });

  it("clampOnboardingStep holds a stale step inside the tour being shown", () => {
    expect(clampOnboardingStep(999, ACT_COUNT)).toBe(LAST_STEP);
    expect(clampOnboardingStep(999, ACT_COUNT - 1)).toBe(LAST_STEP - 1);
    expect(clampOnboardingStep(-3, ACT_COUNT)).toBe(0);
  });

  it("isLastOnboardingStep reflects whether the last act is showing", () => {
    expect(isLastOnboardingStep(0, ACT_COUNT)).toBe(false);
    expect(isLastOnboardingStep(LAST_STEP, ACT_COUNT)).toBe(true);
    // The same step is the last act of a tour one act shorter.
    expect(isLastOnboardingStep(LAST_STEP - 1, ACT_COUNT - 1)).toBe(true);
  });

  it("reset clears both completedAt and step (replay from act 1)", () => {
    useOnboardingStore.getState().complete();
    useOnboardingStore.setState({ step: 4 });

    useOnboardingStore.getState().reset();

    expect(useOnboardingStore.getState().completedAt).toBeNull();
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("restart returns to act 1 without clearing completion", () => {
    useOnboardingStore.setState({ completedAt: 123, step: 4 });

    useOnboardingStore.getState().restart();

    expect(useOnboardingStore.getState().completedAt).toBe(123);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("persists completedAt to localStorage under its catalog persist key", async () => {
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

  it("persistence partialize includes only completedAt — not step or action functions", async () => {
    useOnboardingStore.getState().complete();
    useOnboardingStore.setState({ step: 2 });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(PERSIST_KEY);
    const parsed = JSON.parse(raw ?? "{}") as {
      state?: Record<string, unknown>;
    };
    const keys = Object.keys(parsed.state ?? {}).sort();

    expect(keys).toEqual(["completedAt"]);
  });

  it("rehydrates completion but ignores stale persisted step", async () => {
    const timestamp = 1_600_000_000_000;
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: { completedAt: timestamp, step: 2 },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useOnboardingStore.persist.rehydrate();

    expect(useOnboardingStore.getState().completedAt).toBe(timestamp);
    expect(useOnboardingStore.getState().step).toBe(0);
  });
});
