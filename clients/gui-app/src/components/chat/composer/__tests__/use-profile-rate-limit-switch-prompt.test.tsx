import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";

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
  readonly authenticated: boolean;
}): ProviderProfile {
  const { profileId, kind, label, rateLimitStatus, authenticated } = input;
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
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

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
    useProfileRateLimitSwitchPrompt("claude", profileId, true),
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
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
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
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          authenticated: true,
        }),
      ],
      null,
    ],
  ] as const)("returns hidden for %s", (_name, active, profiles, profileId) => {
    mocks.providers = profiles === null ? [] : [claudeState(profiles)];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", profileId, active),
    );
    expect(result.current.kind).toBe("hidden");
  });

  it("projects a visible near-limit warning with ordered destinations and the first selectable primary", () => {
    const current = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Company",
      rateLimitStatus: "near_limit",
      authenticated: true,
    });
    const blocked = profile({
      profileId: "blocked",
      kind: "managed",
      label: "Blocked",
      rateLimitStatus: "hard_limit",
      authenticated: true,
    });
    const unknown = profile({
      profileId: "unknown",
      kind: "managed",
      label: "Unknown",
      rateLimitStatus: "unknown",
      authenticated: true,
    });
    const signedOut = profile({
      profileId: "signed-out",
      kind: "managed",
      label: "Signed out",
      rateLimitStatus: "ok",
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
          authenticated: true,
        }),
        profile({
          profileId: "blocked",
          kind: "managed",
          label: "Blocked",
          rateLimitStatus: "hard_limit",
          authenticated: true,
        }),
        profile({
          profileId: "signed-out",
          kind: "managed",
          label: "Signed out",
          rateLimitStatus: "ok",
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
      authenticated: true,
    });
    const first = profile({
      profileId: "first",
      kind: "managed",
      label: "First",
      rateLimitStatus: "ok",
      authenticated: true,
    });
    const second = profile({
      profileId: "second",
      kind: "managed",
      label: "Second",
      rateLimitStatus: "ok",
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
      authenticated: true,
    });
    const first = profile({
      profileId: "first",
      kind: "managed",
      label: "First",
      rateLimitStatus: "ok",
      authenticated: true,
    });
    const second = profile({
      profileId: "second",
      kind: "managed",
      label: "Second",
      rateLimitStatus: "ok",
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
      authenticated: true,
    });
    const first = profile({
      profileId: "first",
      kind: "managed",
      label: "First",
      rateLimitStatus: "ok",
      authenticated: true,
    });
    const second = profile({
      profileId: "second",
      kind: "managed",
      label: "Second",
      rateLimitStatus: "ok",
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
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
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
});
