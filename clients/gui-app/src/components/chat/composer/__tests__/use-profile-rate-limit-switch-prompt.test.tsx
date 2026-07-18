import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import type { ModelOption } from "@/components/home/data/landing-options";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: (activity: { enabled: boolean }) =>
    activity.enabled
      ? { data: { providers: mocks.providers } }
      : { data: undefined },
}));

import {
  type ProfileRateLimitSwitchPrompt,
  useProfileRateLimitSwitchPrompt,
} from "../use-profile-rate-limit-switch-prompt";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";

function profile(input: {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
  readonly rateLimitStatus: ProviderProfileRateLimitStatus;
  readonly rateLimitLimitedScopes: ProviderProfile["rateLimitLimitedScopes"];
  readonly authenticated: boolean;
}): ProviderProfile {
  const {
    profileId,
    kind,
    label,
    rateLimitStatus,
    rateLimitLimitedScopes,
    authenticated,
  } = input;
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: authenticated ? "authenticated" : "unauthenticated",
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

const OPUS = model("opus[1m]", "Opus");
const FABLE = model("claude-fable-5[1m]", "Fable");

function visiblePrompt(prompt: ProfileRateLimitSwitchPrompt) {
  if (prompt.kind !== "visible") {
    throw new Error("Expected a visible rate-limit switch prompt");
  }
  return prompt;
}

function claudeState(
  profiles: ReadonlyArray<ProviderProfile>,
): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [...profiles],
  };
}

function currentPrompt(profileId: string | null) {
  return renderHook(() =>
    useProfileRateLimitSwitchPrompt("claude", profileId, null, true),
  );
}

function currentPromptForModel(
  profileId: string | null,
  selectedModel: ModelOption | null,
) {
  return renderHook(
    (props: { readonly selectedModel: ModelOption | null }) =>
      useProfileRateLimitSwitchPrompt(
        "claude",
        profileId,
        props.selectedModel,
        true,
      ),
    { initialProps: { selectedModel } },
  );
}

describe("useProfileRateLimitSwitchPrompt", () => {
  beforeEach(() => {
    mocks.providers = [];
    useRateLimitSwitchPromptDismissalsStore.setState({
      dismissedKeys: new Set<string>(),
    });
  });

  it.each([
    ["inactive", false, null, null],
    [
      "single profile",
      true,
      [
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          rateLimitStatus: "hard_limit",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
      ],
      null,
    ],
    [
      "missing current",
      true,
      [
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          rateLimitStatus: "hard_limit",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
      ],
      "missing",
    ],
    [
      "healthy current",
      true,
      [
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
      ],
      null,
    ],
  ] as const)("returns hidden for %s", (_name, active, profiles, profileId) => {
    mocks.providers = profiles === null ? [] : [claudeState(profiles)];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", profileId, null, active),
    );
    expect(result.current.kind).toBe("hidden");
  });

  it("projects a visible near-limit warning with ordered destinations and the first selectable primary", () => {
    const current = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Company",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const blocked = profile({
      profileId: "blocked",
      kind: "managed",
      label: "Blocked",
      rateLimitStatus: "hard_limit",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const unknown = profile({
      profileId: "unknown",
      kind: "managed",
      label: "Unknown",
      rateLimitStatus: "unknown",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const signedOut = profile({
      profileId: "signed-out",
      kind: "managed",
      label: "Signed out",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: false,
    });
    mocks.providers = [claudeState([current, blocked, unknown, signedOut])];

    const { result } = currentPrompt(null);
    expect(result.current).toMatchObject({
      kind: "visible",
      providerId: "claude-code",
      severity: "near_limit",
      current,
      profiles: [current, blocked, unknown, signedOut],
    });
    if (result.current.kind !== "visible") return;
    expect(
      result.current.destinations.map((entry) => entry.profile.label),
    ).toEqual(["Blocked", "Unknown", "Signed out"]);
    expect(
      result.current.destinations.map((entry) => entry.selectable),
    ).toEqual([false, true, false]);
    expect(result.current.primaryTarget?.profile.label).toBe("Unknown");
    expect(result.current.primaryTarget?.profileId).toBe("unknown");
  });

  it("keeps the warning visible with no selectable destination", () => {
    mocks.providers = [
      claudeState([
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Company",
          rateLimitStatus: "hard_limit",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
        profile({
          profileId: "blocked",
          kind: "managed",
          label: "Blocked",
          rateLimitStatus: "hard_limit",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
        profile({
          profileId: "signed-out",
          kind: "managed",
          label: "Signed out",
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          authenticated: false,
        }),
      ]),
    ];
    const { result } = currentPrompt(null);
    expect(result.current.kind).toBe("visible");
    if (result.current.kind !== "visible") return;
    expect(result.current.primaryTarget).toBeNull();
    expect(result.current.destinations).toHaveLength(2);
    expect(
      result.current.destinations.every((entry) => !entry.selectable),
    ).toBe(true);
  });

  it("reactively advances the primary target and hides after source recovery", () => {
    const source = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Company",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const first = profile({
      profileId: "first",
      kind: "managed",
      label: "First",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const second = profile({
      profileId: "second",
      kind: "managed",
      label: "Second",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    mocks.providers = [claudeState([source, first, second])];
    const { result, rerender } = currentPrompt(null);
    expect(result.current.kind).toBe("visible");
    if (result.current.kind !== "visible") return;
    expect(result.current.primaryTarget?.profileId).toBe("first");

    mocks.providers = [
      claudeState([
        source,
        { ...first, rateLimitStatus: "hard_limit" },
        second,
      ]),
    ];
    rerender();
    expect(visiblePrompt(result.current).primaryTarget?.profileId).toBe(
      "second",
    );

    mocks.providers = [
      claudeState([{ ...source, rateLimitStatus: "ok" }, first, second]),
    ];
    rerender();
    expect(result.current.kind).toBe("hidden");
  });

  it("uses a stable dismissal key and resurfaces when severity or choices change", () => {
    const source = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Company",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const first = profile({
      profileId: "first",
      kind: "managed",
      label: "First",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const second = profile({
      profileId: "second",
      kind: "managed",
      label: "Second",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    mocks.providers = [claudeState([source, first, second])];
    const { result, rerender } = currentPrompt(null);
    expect(result.current.kind).toBe("visible");
    if (result.current.kind !== "visible") return;
    const firstWarningKey = result.current.warningKey;
    act(() => result.current.dismiss());
    expect(result.current.kind).toBe("hidden");

    mocks.providers = [claudeState([source, first, second])];
    rerender();
    expect(result.current.kind).toBe("hidden");

    mocks.providers = [
      claudeState([
        { ...source, rateLimitStatus: "hard_limit" },
        first,
        second,
      ]),
    ];
    rerender();
    expect(visiblePrompt(result.current).warningKey).not.toBe(firstWarningKey);
  });

  it("resurfaces a dismissed warning when the selectable destination set changes, independent of severity", () => {
    const source = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Company",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const first = profile({
      profileId: "first",
      kind: "managed",
      label: "First",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    const second = profile({
      profileId: "second",
      kind: "managed",
      label: "Second",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: null,
      authenticated: true,
    });
    mocks.providers = [claudeState([source, first])];
    const { result, rerender } = currentPrompt(null);
    expect(result.current.kind).toBe("visible");
    if (result.current.kind !== "visible") return;
    const firstWarningKey = result.current.warningKey;
    act(() => result.current.dismiss());
    expect(result.current.kind).toBe("hidden");

    // Same severity, same destination set: stays dismissed.
    mocks.providers = [claudeState([source, first])];
    rerender();
    expect(result.current.kind).toBe("hidden");

    // Severity unchanged; the selectable destination set gained "second".
    // The warning must resurface with a new key even though severity
    // never moved.
    mocks.providers = [claudeState([source, first, second])];
    rerender();
    const resurfaced = visiblePrompt(result.current);
    expect(resurfaced.severity).toBe("near_limit");
    expect(resurfaced.warningKey).not.toBe(firstWarningKey);
  });

  it("shares dismissal across hook instances for the same warning", () => {
    mocks.providers = [
      claudeState([
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Company",
          rateLimitStatus: "near_limit",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          rateLimitLimitedScopes: null,
          authenticated: true,
        }),
      ]),
    ];
    const first = currentPrompt(null);
    const second = currentPrompt(null);
    expect(first.result.current.kind).toBe("visible");
    expect(second.result.current.kind).toBe("visible");
    act(() => {
      if (first.result.current.kind === "visible")
        first.result.current.dismiss();
    });
    expect(first.result.current.kind).toBe("hidden");
    expect(second.result.current.kind).toBe("hidden");
  });

  describe("model-scoped eligibility (the Fable-vs-Opus fix)", () => {
    const fableLimited = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Work",
      rateLimitStatus: "near_limit",
      rateLimitLimitedScopes: [{ family: "Fable", severity: "near_limit" }],
      authenticated: true,
    });
    const healthy = profile({
      profileId: "other",
      kind: "managed",
      label: "Other",
      rateLimitStatus: "ok",
      rateLimitLimitedScopes: [],
      authenticated: true,
    });

    it("hides a Fable-scoped warning when Opus is the selected model", () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const { result } = currentPromptForModel(null, OPUS);
      expect(result.current.kind).toBe("hidden");
    });

    it("shows a Fable-scoped warning when Fable is the selected model, naming the family", () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const { result } = currentPromptForModel(null, FABLE);
      const prompt = visiblePrompt(result.current);
      expect(prompt.severity).toBe("near_limit");
      expect(prompt.limitedFamilies).toEqual(["Fable"]);
    });

    it("shows a shared-window warning regardless of the selected model, with generic copy", () => {
      const sharedLimited = {
        ...fableLimited,
        rateLimitLimitedScopes: [
          { family: null, severity: "near_limit" as const },
        ],
      };
      mocks.providers = [claudeState([sharedLimited, healthy])];
      const { result } = currentPromptForModel(null, OPUS);
      const prompt = visiblePrompt(result.current);
      expect(prompt.severity).toBe("near_limit");
      expect(prompt.limitedFamilies).toEqual([]);
    });

    it("falls back to the profile-level status when per-scope data is unavailable (old host)", () => {
      const scopelessLimited = {
        ...fableLimited,
        rateLimitLimitedScopes: null,
      };
      mocks.providers = [claudeState([scopelessLimited, healthy])];
      const { result } = currentPromptForModel(null, OPUS);
      expect(visiblePrompt(result.current).severity).toBe("near_limit");
    });

    it("shows a scoped warning when no model is resolved (conservative fallback)", () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const { result } = currentPromptForModel(null, null);
      expect(visiblePrompt(result.current).severity).toBe("near_limit");
    });

    it("re-evaluates when the composer switches models", () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const { result, rerender } = currentPromptForModel(null, FABLE);
      expect(result.current.kind).toBe("visible");
      rerender({ selectedModel: OPUS });
      expect(result.current.kind).toBe("hidden");
    });

    it("names only the families at the effective severity and resurfaces when severity moves between the same families", () => {
      const mixed = {
        ...fableLimited,
        rateLimitStatus: "hard_limit" as const,
        rateLimitLimitedScopes: [
          { family: "Fable", severity: "hard_limit" as const },
          { family: "Fable 5", severity: "near_limit" as const },
        ],
      };
      mocks.providers = [claudeState([mixed, healthy])];
      const { result, rerender } = currentPromptForModel(null, FABLE);
      const prompt = visiblePrompt(result.current);
      expect(prompt.severity).toBe("hard_limit");
      // The near-limit "Fable 5" scope matches the model too, but the
      // hard-limit banner must not name it.
      expect(prompt.limitedFamilies).toEqual(["Fable"]);
      act(() => prompt.dismiss());
      expect(result.current.kind).toBe("hidden");

      // Same families, same overall severity - but the hard limit moved from
      // "Fable" to "Fable 5". The per-scope severity in the key resurfaces it.
      mocks.providers = [
        claudeState([
          {
            ...mixed,
            rateLimitLimitedScopes: [
              { family: "Fable", severity: "near_limit" as const },
              { family: "Fable 5", severity: "hard_limit" as const },
            ],
          },
          healthy,
        ]),
      ];
      rerender({ selectedModel: FABLE });
      const resurfaced = visiblePrompt(result.current);
      expect(resurfaced.severity).toBe("hard_limit");
      expect(resurfaced.limitedFamilies).toEqual(["Fable 5"]);
    });

    it("keeps a Fable-scoped dismissal from suppressing a later shared-window warning", () => {
      mocks.providers = [claudeState([fableLimited, healthy])];
      const { result, rerender } = currentPromptForModel(null, FABLE);
      act(() => visiblePrompt(result.current).dismiss());
      expect(result.current.kind).toBe("hidden");

      mocks.providers = [
        claudeState([
          {
            ...fableLimited,
            rateLimitLimitedScopes: [
              { family: "Fable", severity: "near_limit" as const },
              { family: null, severity: "near_limit" as const },
            ],
          },
          healthy,
        ]),
      ];
      rerender({ selectedModel: FABLE });
      expect(result.current.kind).toBe("visible");
    });
  });

  describe("destination tiers (suggest only strictly better profiles)", () => {
    function selectableLabels(prompt: ProfileRateLimitSwitchPrompt) {
      return visiblePrompt(prompt)
        .destinations.filter((entry) => entry.selectable)
        .map((entry) => entry.profile.label);
    }

    it("keeps a near-limit destination unselectable while the current profile is only near-limit", () => {
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Current",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "near_limit" }],
            authenticated: true,
          }),
          profile({
            profileId: "also-near",
            kind: "managed",
            label: "Also near",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "near_limit" }],
            authenticated: true,
          }),
        ]),
      ];
      const { result } = currentPromptForModel(null, OPUS);
      expect(selectableLabels(result.current)).toEqual([]);
    });

    it("offers a near-limit destination as a strictly better tier once the current profile is hard-limited", () => {
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Current",
            rateLimitStatus: "hard_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "hard_limit" }],
            authenticated: true,
          }),
          profile({
            profileId: "near",
            kind: "managed",
            label: "Near",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "near_limit" }],
            authenticated: true,
          }),
          profile({
            profileId: "also-hard",
            kind: "managed",
            label: "Also hard",
            rateLimitStatus: "hard_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "hard_limit" }],
            authenticated: true,
          }),
        ]),
      ];
      const { result } = currentPromptForModel(null, OPUS);
      expect(selectableLabels(result.current)).toEqual(["Near"]);
    });

    it("keeps a destination selectable when its only limit gates a family the selected model doesn't use", () => {
      mocks.providers = [
        claudeState([
          profile({
            profileId: "ambient",
            kind: "ambient",
            label: "Current",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: [{ family: null, severity: "near_limit" }],
            authenticated: true,
          }),
          profile({
            profileId: "fable-only",
            kind: "managed",
            label: "Fable only",
            rateLimitStatus: "near_limit",
            rateLimitLimitedScopes: [
              { family: "Fable", severity: "near_limit" },
            ],
            authenticated: true,
          }),
        ]),
      ];
      const { result } = currentPromptForModel(null, OPUS);
      expect(selectableLabels(result.current)).toEqual(["Fable only"]);
    });
  });
});
