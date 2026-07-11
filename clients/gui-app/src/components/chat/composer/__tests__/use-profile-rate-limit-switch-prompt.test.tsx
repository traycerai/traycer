import { renderHook } from "@testing-library/react";
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

import { useProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  rateLimitStatus: ProviderProfileRateLimitStatus,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
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

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
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
    profiles,
  };
}

describe("useProfileRateLimitSwitchPrompt", () => {
  beforeEach(() => {
    mocks.providers = [];
  });

  it("stays inert with fewer than 2 profiles even if somehow marked limited", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", null, true),
    );
    expect(result.current.limited).toBe(false);
    expect(result.current.alternatives).toEqual([]);
  });

  it("stays inert when the current profile is not limited", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "ok"),
        profile("work-uuid", "managed", "Work", "near_limit"),
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", null, true),
    );
    expect(result.current.limited).toBe(false);
  });

  it("offers the other non-limited, authenticated profile when the current one is near its limit", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "near_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    const { result, rerender } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", null, true),
    );
    const dismiss = result.current.dismiss;
    rerender();
    expect(result.current.limited).toBe(true);
    expect(result.current.dismiss).toBe(dismiss);
    expect(result.current.hardLimited).toBe(false);
    expect(result.current.current).toEqual({
      profileId: null,
      accentDotId: "ambient",
      label: "Terminal account",
      accentColor: null,
    });
    expect(result.current.alternatives).toEqual([
      {
        profileId: "work-uuid",
        accentDotId: "work-uuid",
        label: "Work",
        accentColor: null,
      },
    ]);
  });

  it("excludes a limited or unauthenticated alternative from the offer list", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        { ...profile("work-uuid", "managed", "Work", "hard_limit") },
        {
          ...profile("personal-uuid", "managed", "Personal", "ok"),
          auth: {
            status: "unauthenticated",
            badgeText: null,
            label: null,
            detail: null,
          },
        },
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", null, true),
    );
    expect(result.current.limited).toBe(false);
    expect(result.current.alternatives).toEqual([]);
  });

  it("reports hardLimited distinctly from near_limit", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", null, true),
    );
    expect(result.current.hardLimited).toBe(true);
  });

  it("stays inert when the composer is inactive", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt("claude", null, false),
    );
    expect(result.current.limited).toBe(false);
  });
});
