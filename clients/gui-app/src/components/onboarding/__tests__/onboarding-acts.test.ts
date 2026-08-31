import { afterEach, describe, expect, it } from "vitest";
import {
  actEyebrow,
  ONBOARDING_ACTS,
  onboardingActsFor,
  type OnboardingAct,
  type OnboardingActId,
} from "@/components/onboarding/onboarding-acts";
import { setMobileApp } from "@/lib/mobile-app";

function actById(
  acts: ReadonlyArray<OnboardingAct>,
  id: OnboardingActId,
): OnboardingAct {
  const act = acts.find((candidate) => candidate.id === id);
  if (act === undefined) throw new Error(`no act with id ${id}`);
  return act;
}

describe("onboardingActsFor", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  it("plays the full desktop tour when the host can scan sessions", () => {
    expect(onboardingActsFor(true).map((act) => act.id)).toEqual([
      "task-tabs",
      "navigation",
      "task-context",
      "providers",
      "session-import",
      "agent-guide",
      "command-theme",
    ]);
    expect(onboardingActsFor(true)).toBe(ONBOARDING_ACTS);
  });

  it("drops the session-import act when the host cannot scan", () => {
    expect(onboardingActsFor(false).map((act) => act.id)).toEqual([
      "task-tabs",
      "navigation",
      "task-context",
      "providers",
      "agent-guide",
      "command-theme",
    ]);
    // A stable reference per (platform, capability) pair, so memoized
    // consumers do not re-render on every read.
    expect(onboardingActsFor(false)).toBe(onboardingActsFor(false));
  });

  it("plays the mobile tour inside the installed mobile app, capability aside", () => {
    setMobileApp(true);

    const withScan = onboardingActsFor(true).map((act) => act.id);
    expect(withScan).toEqual([
      "mobile-tasks",
      "mobile-switcher",
      "task-context",
      "providers",
      "agent-guide",
      "mobile-flow",
    ]);
    // The phone tour never lists session-import, so the capability cannot
    // change its shape.
    expect(onboardingActsFor(false)).toBe(onboardingActsFor(true));
  });

  // The Capacitor entry sets the flag in its bootstrap, which runs AFTER
  // gui-app's static module graph - including this module - has been
  // evaluated. A list captured at module scope would pin the desktop tour on
  // every phone.
  it("resolves the platform per call rather than at module evaluation", () => {
    const beforeFlag = onboardingActsFor(true);

    setMobileApp(true);

    expect(onboardingActsFor(true)).not.toBe(beforeFlag);
    expect(onboardingActsFor(true)[0].id).toBe("mobile-tasks");
  });

  it("numbers the eyebrow off the tour being shown, not the catalog", () => {
    // On a host that cannot scan, delegation is the tour's fifth act even
    // though it sits sixth in the catalog.
    const shorterTour = onboardingActsFor(false);
    expect(actEyebrow(shorterTour[4], 4)).toBe("ACT 05 - DELEGATION");
    expect(actEyebrow(ONBOARDING_ACTS[4], 4)).toBe("ACT 05 - YOUR WORK");

    setMobileApp(true);
    const mobileTour = onboardingActsFor(true);
    expect(mobileTour.map(actEyebrow)).toEqual([
      "ACT 01 - TASKS",
      "ACT 02 - LAYOUT",
      "ACT 03 - HANDOFF",
      "ACT 04 - PROVIDERS",
      "ACT 05 - DELEGATION",
      "ACT 06 - FLOW",
    ]);
  });

  it("shares the platform-neutral acts with the desktop tour by reference", () => {
    const desktopTaskContext = actById(onboardingActsFor(true), "task-context");
    const desktopProviders = actById(onboardingActsFor(true), "providers");

    setMobileApp(true);

    expect(actById(onboardingActsFor(true), "task-context")).toBe(
      desktopTaskContext,
    );
    expect(actById(onboardingActsFor(true), "providers")).toBe(
      desktopProviders,
    );
  });

  it("keeps the agent guide's copy and id, moving only its editor into the rail", () => {
    const desktopGuide = actById(onboardingActsFor(true), "agent-guide");
    expect(desktopGuide.addon).toBeNull();

    setMobileApp(true);

    expect(actById(onboardingActsFor(true), "agent-guide")).toEqual({
      ...desktopGuide,
      addon: "agent-guide",
    });
  });

  it("teaches the drawer, the switcher and the gestures in place of desktop chrome", () => {
    setMobileApp(true);
    const acts = onboardingActsFor(true);

    expect(actById(acts, "mobile-tasks")).toEqual({
      id: "mobile-tasks",
      eyebrowLabel: "TASKS",
      title: "Your work lives\nin Tasks",
      body: "Each Task holds one initiative: agents, artifacts, terminals, and context stay together. The menu, top left, holds your recent Tasks, a new one, and Settings.",
      addon: null,
    });
    expect(actById(acts, "mobile-switcher")).toEqual({
      id: "mobile-switcher",
      eyebrowLabel: "LAYOUT",
      title: "One tap opens\neverything",
      body: "The stack icon, top right, is the whole Task: chats, terminals, artifacts, diffs. Pick one; it fills the screen.",
      addon: null,
    });
    // The theme picker comes across from the desktop act it replaces; Cmd+K,
    // which a phone cannot open, does not.
    expect(actById(acts, "mobile-flow")).toEqual({
      id: "mobile-flow",
      eyebrowLabel: "FLOW",
      title: "Move with a swipe.\nMake it yours.",
      body: "Swipe from the left edge to go back, the right edge to go forward. Pick a theme before you enter; terminals and app surfaces follow it together.",
      addon: "theme",
    });
  });
});
