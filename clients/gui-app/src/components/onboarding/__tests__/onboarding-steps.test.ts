import { afterEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  onboardingStepsFor,
} from "@/components/onboarding/onboarding-steps";
import { setMobileApp } from "@/lib/mobile-app";

describe("onboardingStepsFor", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  it("shows all three steps on desktop when session import is available", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
      "session-import",
    ]);
    expect(onboardingStepsFor(true)).toBe(ONBOARDING_STEPS);
    expect(ONBOARDING_STEPS.map((step) => step.title)).toEqual([
      "A home for all your work.",
      "Choose your agents.",
      "Pick up where you left off.",
    ]);
    expect(ONBOARDING_STEPS.map((step) => step.subtitle)).toEqual([
      "Tasks, agents, browsers and artifacts, side by side.",
      "Keep your accounts, skills and plugins.",
      "Bring your Claude Code, Codex and OpenCode chats.",
    ]);
  });

  it("omits session import when the host cannot scan sessions", () => {
    expect(onboardingStepsFor(false).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
    ]);
  });

  it("offers the mobile tour the import act under the same gate as desktop", () => {
    setMobileApp(true);

    // The phone is not the reason the act is there or not - the host is.
    expect(onboardingStepsFor(true).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
      "session-import",
    ]);
    expect(onboardingStepsFor(false).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
    ]);
  });

  it("overrides act one's copy on mobile and nothing else", () => {
    const desktop = onboardingStepsFor(true);

    setMobileApp(true);

    const mobile = onboardingStepsFor(true);
    expect(mobile[0].id).toBe("task-tabs");
    expect(mobile[0].subtitle).toBe(
      "Tasks in the menu, everything else a swipe away.",
    );
    expect(mobile[0]).not.toEqual(desktop[0]);
    // Only act one is rewritten: the other acts are the same objects.
    expect(mobile.slice(1)).toEqual(desktop.slice(1));
  });
});
