import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  onboardingStepsFor,
} from "@/components/onboarding/onboarding-steps";

describe("onboardingStepsFor", () => {
  it("shows all three steps on desktop when session import is available", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
      "session-import",
    ]);
    expect(onboardingStepsFor(true, false)).toBe(ONBOARDING_STEPS);
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
    expect(onboardingStepsFor(false, false).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
    ]);
  });

  it("offers the phone tour the import act under the same gate as desktop", () => {
    // The phone is not the reason the act is there or not - the host is.
    expect(onboardingStepsFor(true, true).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
      "session-import",
    ]);
    expect(onboardingStepsFor(false, true).map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
    ]);
  });

  it("overrides act one's subtitle at phone width and nothing else", () => {
    const desktop = onboardingStepsFor(true, false);
    const phone = onboardingStepsFor(true, true);

    expect(phone[0].id).toBe("task-tabs");
    // The title is shared with the desktop; only the line under it changes.
    expect(phone[0].title).toBe(desktop[0].title);
    expect(phone[0].subtitle).toBe("Tasks in the menu. Swipe for the rest.");
    expect(phone[0]).not.toEqual(desktop[0]);
    // Only act one is rewritten: the other acts are the same objects.
    expect(phone.slice(1)).toEqual(desktop.slice(1));
  });
});
