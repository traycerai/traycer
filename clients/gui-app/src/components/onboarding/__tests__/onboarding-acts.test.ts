import { afterEach, describe, expect, it } from "vitest";
import {
  onboardingActs,
  type OnboardingAct,
  type OnboardingActId,
} from "@/components/onboarding/onboarding-acts";
import { setMobileApp } from "@/lib/mobile-app";

function actById(id: OnboardingActId): OnboardingAct {
  const act = onboardingActs().find((candidate) => candidate.id === id);
  if (act === undefined) throw new Error(`no act with id ${id}`);
  return act;
}

describe("onboardingActs", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  it("plays the desktop tour outside the installed mobile app", () => {
    expect(onboardingActs().map((act) => act.id)).toEqual([
      "task-tabs",
      "navigation",
      "task-context",
      "providers",
      "agent-guide",
      "command-theme",
    ]);
  });

  it("plays the mobile tour inside the installed mobile app", () => {
    setMobileApp(true);

    expect(onboardingActs().map((act) => act.id)).toEqual([
      "mobile-tasks",
      "mobile-switcher",
      "task-context",
      "providers",
      "agent-guide",
      "mobile-flow",
    ]);
  });

  // The Capacitor entry sets the flag in its bootstrap, which runs AFTER
  // gui-app's static module graph - including this module - has been
  // evaluated. A list captured at module scope would pin the desktop tour on
  // every phone.
  it("resolves the list per call rather than at module evaluation", () => {
    const beforeFlag = onboardingActs();

    setMobileApp(true);

    expect(onboardingActs()).not.toBe(beforeFlag);
    expect(onboardingActs()[0].id).toBe("mobile-tasks");
  });

  it("keeps both tours the same length", () => {
    const desktopLength = onboardingActs().length;
    setMobileApp(true);

    expect(onboardingActs().length).toBe(desktopLength);
    expect(desktopLength).toBe(6);
  });

  it("shares the platform-neutral acts with the desktop tour by reference", () => {
    const desktopTaskContext = actById("task-context");
    const desktopProviders = actById("providers");

    setMobileApp(true);

    expect(actById("task-context")).toBe(desktopTaskContext);
    expect(actById("providers")).toBe(desktopProviders);
  });

  it("keeps the agent guide's copy and id, moving only its editor into the rail", () => {
    const desktopGuide = actById("agent-guide");
    expect(desktopGuide.addon).toBeNull();

    setMobileApp(true);

    expect(actById("agent-guide")).toEqual({
      ...desktopGuide,
      addon: "agent-guide",
    });
  });

  it("teaches the drawer, the switcher and the gestures in place of desktop chrome", () => {
    setMobileApp(true);

    expect(actById("mobile-tasks")).toEqual({
      id: "mobile-tasks",
      eyebrow: "ACT 01 - TASKS",
      title: "Your work lives\nin Tasks",
      body: "Each Task holds one initiative: agents, artifacts, terminals, and context stay together. The menu, top left, is your map — recent Tasks, a new one, Settings.",
      addon: null,
    });
    expect(actById("mobile-switcher")).toEqual({
      id: "mobile-switcher",
      eyebrow: "ACT 02 - LAYOUT",
      title: "One tap opens\neverything",
      body: "The stack icon, top right, is the whole Task: chats, terminals, artifacts, diffs. Pick one; it fills the screen.",
      addon: null,
    });
    // The theme picker comes across from the desktop act it replaces; Cmd+K,
    // which a phone cannot open, does not.
    expect(actById("mobile-flow")).toEqual({
      id: "mobile-flow",
      eyebrow: "ACT 06 - FLOW",
      title: "Move with a swipe.\nMake it yours.",
      body: "Swipe from the left edge to go back, the right edge to go forward. Pick a theme before you enter; terminals and app surfaces follow it together.",
      addon: "theme",
    });
  });
});
