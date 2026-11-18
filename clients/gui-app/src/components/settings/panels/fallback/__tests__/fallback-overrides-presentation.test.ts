import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import {
  describeOverride,
  overrideActionOrder,
  overrideRungAfterNotify,
} from "@/components/settings/panels/fallback/fallback-overrides-presentation";

const LADDER: readonly FallbackRungKind[] = [
  "profile",
  "tier",
  "wait",
  "notify",
];

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    ladder: [...LADDER],
    ...overrides,
  };
}

describe("describeOverride", () => {
  it("lists eligible steps in stored order, then a notify stop", () => {
    expect(describeOverride(policy({}), "rate_limit").steps).toEqual([
      "Another account",
      "Equivalent model",
      "Wait for reset",
      "Notify if needed",
    ]);
  });

  it("drops steps the reason cannot use", () => {
    expect(describeOverride(policy({}), "model_unavailable").steps).toEqual([
      "Equivalent model",
      "Notify if needed",
    ]);
  });

  it("puts a brief retry first only on transient reasons with a non-empty saved sequence", () => {
    expect(describeOverride(policy({}), "provider_unavailable").steps).toEqual([
      "Brief retry",
      "Equivalent model",
      "Notify if needed",
    ]);
    expect(
      describeOverride(
        policy({ reasonOverrides: { provider_unavailable: ["notify"] } }),
        "provider_unavailable",
      ).steps,
    ).toEqual(["Brief retry", "Notify if needed"]);
  });

  it("does not promise a retry for an explicit off or an empty sequence", () => {
    const values: readonly ("off" | FallbackRungKind[])[] = ["off", []];
    for (const value of values) {
      const described = describeOverride(
        policy({ reasonOverrides: { provider_unavailable: value } }),
        "provider_unavailable",
      );
      expect(described.steps).not.toContain("Brief retry");
    }
  });

  it("an explicit off describes disabled recovery; the note may name retry only to negate it", () => {
    const described = describeOverride(
      policy({ reasonOverrides: { provider_unavailable: "off" } }),
      "provider_unavailable",
    );
    expect(described.steps).toEqual(["Notify you"]);
    expect(described.note).toMatch(/Recovery is disabled/);
    expect(described.note).toMatch(
      /No automatic switching, waiting, or brief retry/,
    );
  });

  it("connection failure with the normal plan retries then notifies, with no switching steps", () => {
    const described = describeOverride(
      policy({}),
      "provider_connection_failed",
    );
    expect(described.steps).toEqual(["Brief retry", "Notify if needed"]);
    expect(described.note).toMatch(/Brief retry, then notify you/);
  });

  it("connection failure without notify in the narrowed sequence has no Brief retry", () => {
    const described = describeOverride(
      policy({ ladder: ["profile", "tier"] }),
      "provider_connection_failed",
    );
    expect(described.steps).not.toContain("Brief retry");
  });

  it("an outage whose saved sequence has only ineligible rungs has no Brief retry", () => {
    const described = describeOverride(
      policy({ reasonOverrides: { provider_unavailable: ["profile"] } }),
      "provider_unavailable",
    );
    expect(described.steps).not.toContain("Brief retry");
  });

  it("all-off on a non-transient reason is notify only, with no countdown", () => {
    const described = describeOverride(
      policy({ reasonOverrides: { rate_limit: ["notify"] } }),
      "rate_limit",
    );
    expect(described.steps).toEqual(["Notify you"]);
    expect(described.note).toMatch(/No countdown to cancel/);
    expect(described.steps.join(" ")).not.toMatch(/retry/i);
  });

  it("excludes steps after an early notify from the steps", () => {
    const described = describeOverride(
      policy({ ladder: ["profile", "notify", "tier", "wait"] }),
      "rate_limit",
    );
    expect(described.steps).toEqual(["Another account", "Notify if needed"]);
  });

  it("does not invent a notify stop the saved sequence never had beyond the closing one", () => {
    const described = describeOverride(
      policy({ ladder: ["profile", "tier"] }),
      "auth",
    );
    expect(described.steps).toEqual([
      "Another account",
      "Equivalent model",
      "Notify if needed",
    ]);
    expect(described.note).toMatch(/only after sign-out is confirmed/);
  });

  it("billing always notifies and says so", () => {
    const described = describeOverride(policy({}), "billing");
    expect(described.steps.at(-1)).toBe("Always notify you");
    expect(described.note).toMatch(/always notify you/i);
  });

  it("excluded reasons only notify", () => {
    const described = describeOverride(policy({}), "context_exhausted");
    expect(described.steps).toEqual(["Notify you"]);
    expect(described.note).not.toBeNull();
  });
});

describe("overrideRungAfterNotify", () => {
  it("is true only for a rung that sits after notify in the effective sequence", () => {
    const early = policy({ ladder: ["profile", "notify", "tier", "wait"] });
    expect(overrideRungAfterNotify(early, "rate_limit", "tier")).toBe(true);
    expect(overrideRungAfterNotify(early, "rate_limit", "wait")).toBe(true);
    expect(overrideRungAfterNotify(early, "rate_limit", "profile")).toBe(false);
  });

  it("is false with notify last, with no notify, and for an off row", () => {
    expect(overrideRungAfterNotify(policy({}), "rate_limit", "wait")).toBe(
      false,
    );
    expect(
      overrideRungAfterNotify(
        policy({ ladder: ["profile", "tier"] }),
        "rate_limit",
        "tier",
      ),
    ).toBe(false);
    expect(
      overrideRungAfterNotify(
        policy({ reasonOverrides: { rate_limit: "off" } }),
        "rate_limit",
        "tier",
      ),
    ).toBe(false);
  });

  it("reads a per-reason override rather than the base ladder", () => {
    const withOverride = policy({
      reasonOverrides: { rate_limit: ["notify", "profile"] },
    });
    expect(overrideRungAfterNotify(withOverride, "rate_limit", "profile")).toBe(
      true,
    );
    expect(overrideRungAfterNotify(withOverride, "billing", "profile")).toBe(
      false,
    );
  });

  it("is false for a rung absent from the sequence", () => {
    expect(
      overrideRungAfterNotify(
        policy({ reasonOverrides: { rate_limit: ["notify"] } }),
        "rate_limit",
        "wait",
      ),
    ).toBe(false);
  });
});

describe("overrideActionOrder", () => {
  it("keeps the stored order first and appends absent eligible actions in display order", () => {
    const order = overrideActionOrder(
      policy({
        reasonOverrides: { rate_limit: ["wait", "profile", "notify"] },
      }),
      "rate_limit",
      LADDER,
    );
    expect(order).toEqual(["wait", "profile", "tier"]);
  });

  it("keeps a turned-off middle action in place when the plan order already agrees", () => {
    const order = overrideActionOrder(
      policy({
        reasonOverrides: { rate_limit: ["profile", "wait", "notify"] },
      }),
      "rate_limit",
      LADDER,
    );
    expect(order).toEqual(["profile", "tier", "wait"]);
  });

  it("keeps the plan position for a disabled action after the base ladder loses it", () => {
    const order = overrideActionOrder(
      policy({ ladder: ["profile", "wait", "notify"] }),
      "rate_limit",
      LADDER,
    );
    expect(order).toEqual(["profile", "tier", "wait"]);
  });

  it("uses display order for an off row and never returns ineligible rungs or notify", () => {
    expect(
      overrideActionOrder(
        policy({ reasonOverrides: { billing: "off" } }),
        "billing",
        LADDER,
      ),
    ).toEqual(["profile", "tier"]);
    expect(
      overrideActionOrder(policy({}), "model_unavailable", LADDER),
    ).toEqual(["tier"]);
  });

  it("does not reorder an older custom sequence when merely computed", () => {
    const stored = policy({
      reasonOverrides: { rate_limit: ["tier", "profile", "notify"] },
    });
    expect(overrideActionOrder(stored, "rate_limit", LADDER)).toEqual([
      "tier",
      "profile",
      "wait",
    ]);
  });
});
