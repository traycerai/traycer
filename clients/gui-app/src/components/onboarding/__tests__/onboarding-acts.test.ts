import { afterEach, describe, expect, it } from "vitest";
import {
  actEyebrow,
  ONBOARDING_ACTS,
  onboardingActsFor,
  type OnboardingAct,
  type OnboardingActId,
} from "@/components/onboarding/onboarding-acts";
import { setMobileApp } from "@/lib/mobile-app";

const FULL_TOUR = { sessionImportAvailable: true, loginImportAvailable: true };
const NO_IMPORTS = {
  sessionImportAvailable: false,
  loginImportAvailable: false,
};

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
    expect(onboardingActsFor(FULL_TOUR).map((act) => act.id)).toEqual([
      "task-tabs",
      "navigation",
      "task-context",
      "providers",
      "session-import",
      "login-import",
      "agent-guide",
      "command-theme",
    ]);
    expect(onboardingActsFor(FULL_TOUR)).toBe(ONBOARDING_ACTS);
  });

  it("drops the session-import act when the host cannot scan", () => {
    expect(onboardingActsFor(NO_IMPORTS).map((act) => act.id)).toEqual([
      "task-tabs",
      "navigation",
      "task-context",
      "providers",
      "agent-guide",
      "command-theme",
    ]);
    // A stable reference per (platform, capability) pair, so memoized
    // consumers do not re-render on every read.
    expect(onboardingActsFor(NO_IMPORTS)).toBe(onboardingActsFor(NO_IMPORTS));
  });

  it("plays the mobile tour inside the installed mobile app, capability aside", () => {
    setMobileApp(true);

    const withScan = onboardingActsFor(FULL_TOUR).map((act) => act.id);
    expect(withScan).toEqual([
      "mobile-tasks",
      "mobile-switcher",
      "task-context",
      "providers",
      "agent-guide",
    ]);
    // The phone tour never lists session-import, so the capability cannot
    // change its shape.
    expect(onboardingActsFor(NO_IMPORTS)).toBe(onboardingActsFor(FULL_TOUR));
  });

  // The Capacitor entry sets the flag in its bootstrap, which runs AFTER
  // gui-app's static module graph - including this module - has been
  // evaluated. A list captured at module scope would pin the desktop tour on
  // every phone.
  it("resolves the platform per call rather than at module evaluation", () => {
    const beforeFlag = onboardingActsFor(FULL_TOUR);

    setMobileApp(true);

    expect(onboardingActsFor(FULL_TOUR)).not.toBe(beforeFlag);
    expect(onboardingActsFor(FULL_TOUR)[0].id).toBe("mobile-tasks");
  });

  it("numbers the eyebrow off the tour being shown, not the catalog", () => {
    // On a host that cannot scan, delegation is the tour's fifth act even
    // though it sits sixth in the catalog.
    const shorterTour = onboardingActsFor(NO_IMPORTS);
    expect(actEyebrow(shorterTour[4], 4)).toBe("ACT 05 - DELEGATION");
    expect(actEyebrow(ONBOARDING_ACTS[4], 4)).toBe("ACT 05 - YOUR WORK");

    setMobileApp(true);
    const mobileTour = onboardingActsFor(FULL_TOUR);
    expect(mobileTour.map(actEyebrow)).toEqual([
      "ACT 01 - TASKS",
      "ACT 02 - LAYOUT",
      "ACT 03 - HANDOFF",
      "ACT 04 - PROVIDERS",
      "ACT 05 - DELEGATION",
    ]);
  });

  it("shares the platform-neutral acts with the desktop tour by reference", () => {
    const desktopTaskContext = actById(
      onboardingActsFor(FULL_TOUR),
      "task-context",
    );
    const desktopProviders = actById(onboardingActsFor(FULL_TOUR), "providers");

    setMobileApp(true);

    expect(actById(onboardingActsFor(FULL_TOUR), "task-context")).toBe(
      desktopTaskContext,
    );
    expect(actById(onboardingActsFor(FULL_TOUR), "providers")).toBe(
      desktopProviders,
    );
  });

  it("keeps the agent guide's copy and id, moving only its editor into the rail", () => {
    const desktopGuide = actById(onboardingActsFor(FULL_TOUR), "agent-guide");
    expect(desktopGuide.addon).toBeNull();

    setMobileApp(true);

    expect(actById(onboardingActsFor(FULL_TOUR), "agent-guide")).toEqual({
      ...desktopGuide,
      addon: "agent-guide",
    });
  });

  it("adds the login-import act right after session-import when the machine can import logins", () => {
    const acts = onboardingActsFor({
      sessionImportAvailable: true,
      loginImportAvailable: true,
    });
    const sessionImportIndex = acts.findIndex(
      (act) => act.id === "session-import",
    );
    expect(acts[sessionImportIndex + 1].id).toBe("login-import");
  });

  it("drops the login-import act entirely when the machine cannot import logins", () => {
    const acts = onboardingActsFor({
      sessionImportAvailable: true,
      loginImportAvailable: false,
    });
    expect(acts.map((act) => act.id)).not.toContain("login-import");
  });

  it("positions login-import independent of session-import's own availability", () => {
    const withSessionImport = onboardingActsFor({
      sessionImportAvailable: true,
      loginImportAvailable: true,
    });
    const withoutSessionImport = onboardingActsFor({
      sessionImportAvailable: false,
      loginImportAvailable: true,
    });
    expect(withSessionImport.map((act) => act.id)).toContain("login-import");
    expect(withoutSessionImport.map((act) => act.id)).toContain("login-import");
    // Session-import is absent from this tour, so login-import simply
    // follows providers there instead.
    const providersIndex = withoutSessionImport.findIndex(
      (act) => act.id === "providers",
    );
    expect(withoutSessionImport[providersIndex + 1].id).toBe("login-import");
  });

  it("hands back a stable reference for the same capability pair across calls", () => {
    const capabilities = {
      sessionImportAvailable: false,
      loginImportAvailable: true,
    };
    expect(onboardingActsFor(capabilities)).toBe(
      onboardingActsFor({ ...capabilities }),
    );
  });

  it("hands back the full catalog by reference when both capabilities are available", () => {
    expect(onboardingActsFor(FULL_TOUR)).toBe(ONBOARDING_ACTS);
  });

  it("ignores both import capabilities on the mobile tour", () => {
    setMobileApp(true);
    expect(
      onboardingActsFor({
        sessionImportAvailable: true,
        loginImportAvailable: true,
      }),
    ).toBe(
      onboardingActsFor({
        sessionImportAvailable: false,
        loginImportAvailable: false,
      }),
    );
    expect(onboardingActsFor(FULL_TOUR).map((act) => act.id)).not.toContain(
      "login-import",
    );
  });

  it("teaches the drawer and the switcher in place of desktop chrome", () => {
    setMobileApp(true);
    const acts = onboardingActsFor(FULL_TOUR);

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
    // Desktop's closing flow act has no phone counterpart: the tour ends on
    // delegation.
    expect(acts[acts.length - 1].id).toBe("agent-guide");
  });
});
