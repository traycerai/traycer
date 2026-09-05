import { describe, expect, it } from "vitest";
import {
  actEyebrow,
  ONBOARDING_ACTS,
  onboardingActsFor,
  type OnboardingAct,
  type OnboardingActId,
} from "@/components/onboarding/onboarding-acts";

const FULL_TOUR = {
  phoneLayout: false,
  sessionImportAvailable: true,
  loginImportAvailable: true,
};
const NO_IMPORTS = {
  phoneLayout: false,
  sessionImportAvailable: false,
  loginImportAvailable: false,
};
const PHONE_TOUR = { ...FULL_TOUR, phoneLayout: true };

function actById(
  acts: ReadonlyArray<OnboardingAct>,
  id: OnboardingActId,
): OnboardingAct {
  const act = acts.find((candidate) => candidate.id === id);
  if (act === undefined) throw new Error(`no act with id ${id}`);
  return act;
}

describe("onboardingActsFor", () => {
  it("plays the full desktop tour when the host can scan sessions", () => {
    expect(onboardingActsFor(FULL_TOUR).map((act) => act.id)).toEqual([
      "task-tabs",
      "navigation",
      "task-context",
      "providers",
      "login-import",
      "agent-guide",
      "command-theme",
      "session-import",
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

  it("plays the mobile tour under the phone layout, capability aside", () => {
    const withScan = onboardingActsFor(PHONE_TOUR).map((act) => act.id);
    expect(withScan).toEqual([
      "mobile-tasks",
      "mobile-switcher",
      "task-context",
      "providers",
      "agent-guide",
    ]);
    // The phone tour never lists session-import, so the capability cannot
    // change its shape.
    expect(onboardingActsFor({ ...NO_IMPORTS, phoneLayout: true })).toBe(
      onboardingActsFor(PHONE_TOUR),
    );
  });

  it("numbers the eyebrow off the tour being shown, not the catalog", () => {
    // On a host with neither import, the tour ends on flow as its sixth act;
    // the catalog goes on to an eighth, the session-import last act.
    const shorterTour = onboardingActsFor(NO_IMPORTS);
    expect(actEyebrow(shorterTour[5], 5)).toBe("ACT 06 - FLOW");
    expect(actEyebrow(ONBOARDING_ACTS[7], 7)).toBe("ACT 08 - YOUR WORK");

    const mobileTour = onboardingActsFor(PHONE_TOUR);
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

    expect(actById(onboardingActsFor(PHONE_TOUR), "task-context")).toBe(
      desktopTaskContext,
    );
    expect(actById(onboardingActsFor(PHONE_TOUR), "providers")).toBe(
      desktopProviders,
    );
  });

  it("keeps the agent guide's copy and id, moving only its editor into the rail", () => {
    const desktopGuide = actById(onboardingActsFor(FULL_TOUR), "agent-guide");
    expect(desktopGuide.addon).toBeNull();

    expect(actById(onboardingActsFor(PHONE_TOUR), "agent-guide")).toEqual({
      ...desktopGuide,
      addon: "agent-guide",
    });
  });

  it("adds the login-import act after providers when the machine can import logins", () => {
    const acts = onboardingActsFor({
      phoneLayout: false,
      sessionImportAvailable: true,
      loginImportAvailable: true,
    });
    // Login-import follows providers; session-import is the tour's last act.
    const providersIndex = acts.findIndex((act) => act.id === "providers");
    expect(acts[providersIndex + 1].id).toBe("login-import");
    expect(acts[acts.length - 1].id).toBe("session-import");
  });

  it("drops the login-import act entirely when the machine cannot import logins", () => {
    const acts = onboardingActsFor({
      phoneLayout: false,
      sessionImportAvailable: true,
      loginImportAvailable: false,
    });
    expect(acts.map((act) => act.id)).not.toContain("login-import");
  });

  it("positions login-import independent of session-import's own availability", () => {
    const withSessionImport = onboardingActsFor({
      phoneLayout: false,
      sessionImportAvailable: true,
      loginImportAvailable: true,
    });
    const withoutSessionImport = onboardingActsFor({
      phoneLayout: false,
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
      phoneLayout: false,
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

  // The installed app on an iPad: the shell is still `isMobileApp()`, but the
  // window is desktop width, so the LAYOUT read must pick the desktop acts -
  // the ones that actually describe the tab strip and canvas it is showing.
  it("plays the desktop tour on a wide window regardless of the installed app", () => {
    const acts = onboardingActsFor({
      phoneLayout: false,
      sessionImportAvailable: true,
      loginImportAvailable: true,
    });
    expect(acts).toBe(ONBOARDING_ACTS);
    expect(acts[0].id).toBe("task-tabs");
  });

  it("ignores both import capabilities on the mobile tour", () => {
    expect(
      onboardingActsFor({
        phoneLayout: true,
        sessionImportAvailable: true,
        loginImportAvailable: true,
      }),
    ).toBe(
      onboardingActsFor({
        phoneLayout: true,
        sessionImportAvailable: false,
        loginImportAvailable: false,
      }),
    );
    expect(onboardingActsFor(PHONE_TOUR).map((act) => act.id)).not.toContain(
      "login-import",
    );
  });

  it("teaches the drawer and the switcher in place of desktop chrome", () => {
    const acts = onboardingActsFor(PHONE_TOUR);

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
