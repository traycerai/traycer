import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEPS,
  onboardingStepsFor,
} from "@/components/onboarding/onboarding-steps";

const ALL = { sessionImport: true, agentMemories: true };

describe("onboardingStepsFor", () => {
  it("shows every step on desktop when the host offers both optional acts", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      "task-tabs",
      "providers",
      "agent-memories",
      "session-import",
    ]);
    expect(onboardingStepsFor({ ...ALL, phone: false })).toBe(ONBOARDING_STEPS);
    expect(ONBOARDING_STEPS.map((step) => step.title)).toEqual([
      "A home for all your work.",
      "Choose your agents.",
      "Let your agents remember.",
      "Pick up where you left off.",
    ]);
    expect(ONBOARDING_STEPS.map((step) => step.subtitle)).toEqual([
      "Tasks, agents, browsers and artifacts, side by side.",
      "Keep your accounts, skills and plugins.",
      "Keep useful facts and preferences across tasks, whichever provider you use.",
      "Bring your Claude Code, Codex and OpenCode chats.",
    ]);
  });

  it("omits session import when the host cannot scan sessions", () => {
    expect(
      onboardingStepsFor({ ...ALL, sessionImport: false, phone: false }).map(
        (step) => step.id,
      ),
    ).toEqual(["task-tabs", "providers", "agent-memories"]);
  });

  it("offers the phone tour the import act under the same gate as desktop", () => {
    // The phone is not the reason the act is there or not - the host is.
    expect(
      onboardingStepsFor({ ...ALL, phone: true }).map((step) => step.id),
    ).toEqual(["task-tabs", "providers", "agent-memories", "session-import"]);
    expect(
      onboardingStepsFor({ ...ALL, sessionImport: false, phone: true }).map(
        (step) => step.id,
      ),
    ).toEqual(["task-tabs", "providers", "agent-memories"]);
  });

  it("overrides act one's subtitle at phone width and nothing else", () => {
    const desktop = onboardingStepsFor({ ...ALL, phone: false });
    const phone = onboardingStepsFor({ ...ALL, phone: true });

    expect(phone[0].id).toBe("task-tabs");
    // The title is shared with the desktop; only the line under it changes.
    expect(phone[0].title).toBe(desktop[0].title);
    expect(phone[0].subtitle).toBe("Tasks in the menu. Swipe for the rest.");
    expect(phone[0]).not.toEqual(desktop[0]);
    // Only act one is rewritten: the other acts are the same objects.
    expect(phone.slice(1)).toEqual(desktop.slice(1));
  });
});
