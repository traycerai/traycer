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

  it("keeps the mobile tour to task tabs and providers regardless of capability", () => {
    setMobileApp(true);

    expect(onboardingStepsFor(true).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
    ]);
    expect(onboardingStepsFor(false).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
    ]);
  });

  it("uses mobile-specific task-tabs copy while keeping the step id", () => {
    const desktopTaskTabs = onboardingStepsFor(true)[0];

    setMobileApp(true);

    const mobileTaskTabs = onboardingStepsFor(true)[0];
    expect(mobileTaskTabs.id).toBe("task-tabs");
    expect(mobileTaskTabs.subtitle).toBe(
      "Find tasks in the menu. Use the tab switcher for chats, browsers, and files.",
    );
    expect(mobileTaskTabs).not.toEqual(desktopTaskTabs);
  });
});
