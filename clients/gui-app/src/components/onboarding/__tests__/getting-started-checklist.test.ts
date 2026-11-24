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
    secretsOffered: true,
    thisComputersMove: "unknown",
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

  it("invites the move while this computer's settings are not in Personal", () => {
    const notMoved = facts({
      ...ALL_BUT_CREDITS,
      thisComputersMove: "not_moved",
    });
    expect(gettingStartedVisibleCards(notMoved).map((card) => card.id)).toEqual(
      ["provider", "task", "secret", "move", "install"],
    );
    expect(gettingStartedGuideIsComplete(notMoved)).toBe(false);
  });

  it("checks the move off once this computer's settings are in Personal", () => {
    const moved = facts({ ...ALL_BUT_CREDITS, thisComputersMove: "moved" });
    expect(gettingStartedVisibleCards(moved).map((card) => card.id)).toContain(
      "move",
    );
    expect(gettingStartedGuideIsComplete(moved)).toBe(true);
  });

  it("leaves the move out where this computer cannot answer it", () => {
    // No local host, a host without the method, or a read that failed: a card
    // nobody can finish would hold the checklist open for ever.
    expect(
      gettingStartedVisibleCards(ALL_BUT_CREDITS).map((card) => card.id),
    ).not.toContain("move");
  });

  it("leaves the Secrets step out where the pick offers no Secrets page, and counts the rest", () => {
    const withoutSecrets = facts({
      ...ALL_BUT_CREDITS,
      hasSecret: false,
      secretsOffered: false,
    });
    expect(
      gettingStartedVisibleCards(withoutSecrets).map((card) => card.id),
    ).toEqual(["provider", "task", "install"]);
    expect(gettingStartedGuideIsComplete(withoutSecrets)).toBe(true);
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
