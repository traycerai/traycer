import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";
import {
  assessProfileRateLimit,
  effectiveProfileRateLimitSeverity,
  rateLimitScopeAffectsModel,
  rateLimitSeverityTier,
} from "../rate-limit-scope-match";

function model(slug: string, label: string): ModelOption {
  return {
    harnessId: "claude",
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

function profile(
  rateLimitStatus: ProviderProfile["rateLimitStatus"],
  rateLimitLimitedScopes: ProviderProfile["rateLimitLimitedScopes"],
): ProviderProfile {
  return {
    profileId: "p",
    kind: "managed",
    authType: "oauth",
    label: "P",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

const OPUS = model("opus[1m]", "Opus");

describe("rateLimitScopeAffectsModel", () => {
  it("treats a shared (null-family) scope as gating every model", () => {
    expect(rateLimitScopeAffectsModel(null, model("opus[1m]", "Opus"))).toBe(
      true,
    );
    expect(rateLimitScopeAffectsModel(null, model("haiku", "Haiku"))).toBe(
      true,
    );
  });

  it("matches provider family tokens against real catalog slugs", () => {
    const opus = model("opus[1m]", "Opus");
    const fable = model("claude-fable-5[1m]", "Fable");
    const sonnet = model("sonnet", "Sonnet");
    const versionedOpus = model("claude-opus-4-7", "Claude Opus 4.7");

    expect(rateLimitScopeAffectsModel("opus", opus)).toBe(true);
    expect(rateLimitScopeAffectsModel("opus", versionedOpus)).toBe(true);
    expect(rateLimitScopeAffectsModel("Fable", fable)).toBe(true);
    expect(rateLimitScopeAffectsModel("sonnet", sonnet)).toBe(true);

    expect(rateLimitScopeAffectsModel("Fable", opus)).toBe(false);
    expect(rateLimitScopeAffectsModel("opus", fable)).toBe(false);
    expect(rateLimitScopeAffectsModel("sonnet", opus)).toBe(false);
  });

  it("leaves a model with no scoped bucket unmatched by every named family", () => {
    const haiku = model("haiku", "Haiku");
    expect(rateLimitScopeAffectsModel("opus", haiku)).toBe(false);
    expect(rateLimitScopeAffectsModel("sonnet", haiku)).toBe(false);
    expect(rateLimitScopeAffectsModel("Fable", haiku)).toBe(false);
  });

  it("ignores numeric version tokens instead of cross-matching them", () => {
    // "Fable 5"'s "5" must not match claude-opus-4-5-style slugs.
    expect(
      rateLimitScopeAffectsModel("Fable 5", model("claude-opus-4-5", "Opus")),
    ).toBe(false);
    expect(
      rateLimitScopeAffectsModel(
        "Fable 5",
        model("claude-fable-5[1m]", "Fable"),
      ),
    ).toBe(true);
  });

  it("errs toward matching when a family carries no alphabetic token", () => {
    expect(rateLimitScopeAffectsModel("5", model("opus[1m]", "Opus"))).toBe(
      true,
    );
    expect(rateLimitScopeAffectsModel("--", model("opus[1m]", "Opus"))).toBe(
      true,
    );
  });

  it("does not match through provider-generic tokens", () => {
    // "Claude Opus" must not gate a Fable model just because every Claude
    // slug contains "claude" - that would both over-warn and wrongly reject
    // healthy destinations.
    expect(
      rateLimitScopeAffectsModel(
        "Claude Opus",
        model("claude-fable-5[1m]", "Fable"),
      ),
    ).toBe(false);
    expect(
      rateLimitScopeAffectsModel(
        "Claude Opus",
        model("claude-opus-4-7", "Claude Opus 4.7"),
      ),
    ).toBe(true);
    // A family that is ONLY generic tokens cannot be judged - errs toward
    // matching, same as the no-alphabetic-token guard.
    expect(
      rateLimitScopeAffectsModel("Claude", model("opus[1m]", "Opus")),
    ).toBe(true);
  });
});

describe("rateLimitSeverityTier", () => {
  it("orders not-limited < near_limit < hard_limit", () => {
    expect(rateLimitSeverityTier(null)).toBeLessThan(
      rateLimitSeverityTier("near_limit"),
    );
    expect(rateLimitSeverityTier("near_limit")).toBeLessThan(
      rateLimitSeverityTier("hard_limit"),
    );
  });
});

describe("effectiveProfileRateLimitSeverity", () => {
  it("falls back to the profile-level status when per-scope data is absent", () => {
    expect(
      effectiveProfileRateLimitSeverity(profile("near_limit", null), OPUS),
    ).toBe("near_limit");
    expect(
      effectiveProfileRateLimitSeverity(profile("hard_limit", null), OPUS),
    ).toBe("hard_limit");
    expect(
      effectiveProfileRateLimitSeverity(profile("ok", null), OPUS),
    ).toBeNull();
    expect(
      effectiveProfileRateLimitSeverity(profile("unknown", null), OPUS),
    ).toBeNull();
  });

  it("falls back to the profile-level status when no model is resolved", () => {
    expect(
      effectiveProfileRateLimitSeverity(
        profile("hard_limit", [{ family: "Fable", severity: "hard_limit" }]),
        null,
      ),
    ).toBe("hard_limit");
  });

  it("returns null when scopes exist but none gate the selected model", () => {
    expect(
      effectiveProfileRateLimitSeverity(
        profile("near_limit", [{ family: "Fable", severity: "near_limit" }]),
        OPUS,
      ),
    ).toBeNull();
  });

  it("returns null for an empty scope list even when the profile enum is limited", () => {
    expect(
      effectiveProfileRateLimitSeverity(profile("near_limit", []), OPUS),
    ).toBeNull();
  });

  it("reduces matching scopes to the worst severity", () => {
    expect(
      effectiveProfileRateLimitSeverity(
        profile("hard_limit", [
          { family: null, severity: "near_limit" },
          { family: "opus", severity: "hard_limit" },
        ]),
        OPUS,
      ),
    ).toBe("hard_limit");
    expect(
      effectiveProfileRateLimitSeverity(
        profile("near_limit", [
          { family: null, severity: "near_limit" },
          { family: "sonnet", severity: "hard_limit" },
        ]),
        OPUS,
      ),
    ).toBe("near_limit");
  });
});

describe("assessProfileRateLimit", () => {
  it("distinguishes unknown (no evidence) from known healthy", () => {
    // Never-read / stale / failed-probe gauge: profile-level enum "unknown".
    expect(assessProfileRateLimit(profile("unknown", null), OPUS)).toEqual({
      known: false,
    });
    // A successful read below every threshold: proven headroom.
    expect(assessProfileRateLimit(profile("ok", null), OPUS)).toEqual({
      known: true,
      severity: null,
    });
  });

  it("treats a scoped snapshot as known, with the selected model's severity", () => {
    expect(
      assessProfileRateLimit(
        profile("near_limit", [{ family: "Fable", severity: "near_limit" }]),
        OPUS,
      ),
    ).toEqual({ known: true, severity: null });
    expect(
      assessProfileRateLimit(
        profile("near_limit", [{ family: null, severity: "near_limit" }]),
        OPUS,
      ),
    ).toEqual({ known: true, severity: "near_limit" });
    expect(assessProfileRateLimit(profile("ok", []), OPUS)).toEqual({
      known: true,
      severity: null,
    });
  });

  it("falls back to the profile-level enum when scopes or the model are unavailable", () => {
    expect(assessProfileRateLimit(profile("hard_limit", null), OPUS)).toEqual({
      known: true,
      severity: "hard_limit",
    });
    expect(
      assessProfileRateLimit(
        profile("hard_limit", [{ family: "Fable", severity: "hard_limit" }]),
        null,
      ),
    ).toEqual({ known: true, severity: "hard_limit" });
    expect(assessProfileRateLimit(profile("unknown", null), null)).toEqual({
      known: false,
    });
  });
});
