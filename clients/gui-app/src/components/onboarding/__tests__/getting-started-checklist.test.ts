import { describe, expect, it } from "vitest";
import {
  gettingStartedGuideIsComplete,
  gettingStartedVisibleCards,
  type GettingStartedFacts,
} from "@/components/onboarding/getting-started-checklist";

function facts(overrides: Partial<GettingStartedFacts>): GettingStartedFacts {
  return {
    providerSetUp: false,
    hasTask: false,
    hasSecret: false,
    hasSecondPersonalComputer: false,
    sandboxStaged: false,
    creditsAboveZero: false,
    ...overrides,
  };
}

const ALL_BUT_CREDITS: GettingStartedFacts = facts({
  providerSetUp: true,
  hasTask: true,
  hasSecret: true,
  hasSecondPersonalComputer: true,
});

describe("gettingStartedGuideIsComplete", () => {
  it("is complete without credits when no sandbox is staged in this window", () => {
    expect(gettingStartedGuideIsComplete(ALL_BUT_CREDITS)).toBe(true);
    expect(
      gettingStartedVisibleCards(ALL_BUT_CREDITS).map((card) => card.id),
    ).toEqual(["provider", "task", "secret", "install"]);
  });

  it("keeps the credits step visible and incomplete while a sandbox is staged and the balance is zero", () => {
    const staged = facts({
      ...ALL_BUT_CREDITS,
      sandboxStaged: true,
      creditsAboveZero: false,
    });
    expect(gettingStartedGuideIsComplete(staged)).toBe(false);
    expect(gettingStartedVisibleCards(staged).map((card) => card.id)).toEqual([
      "provider",
      "task",
      "secret",
      "install",
      "credits",
    ]);
  });

  it("is complete once a staged sandbox's credits balance is above zero and every other step is done", () => {
    expect(
      gettingStartedGuideIsComplete(
        facts({
          ...ALL_BUT_CREDITS,
          sandboxStaged: true,
          creditsAboveZero: true,
        }),
      ),
    ).toBe(true);
  });
});
