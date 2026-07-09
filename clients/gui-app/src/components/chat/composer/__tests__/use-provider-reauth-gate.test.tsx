import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAuth,
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";

// The gate's only collaborators are the tab-scoped providers query and its
// force-refresh twin, plus a reconnect toast - stub all three so the test drives
// pure probe-status combinations.
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(() => Promise.resolve()),
  // `undefined` simulates a `providers.list` query that hasn't settled yet
  // (the genuine "still loading" signal); an array simulates a settled
  // response, empty or not.
  providers: [] as ProviderCliState[] | undefined,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: () =>
    mocks.providers === undefined
      ? { data: undefined }
      : { data: { providers: mocks.providers } },
}));
vi.mock("@/hooks/providers/use-tab-refresh-providers", () => ({
  useTabRefreshProviders: () => mocks.refresh,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { useProviderReauthGate } from "../use-provider-reauth-gate";

const AUTHED: ProviderAuth = {
  status: "authenticated",
  badgeText: null,
  label: null,
  detail: null,
};
const UNAUTH: ProviderAuth = {
  status: "unauthenticated",
  badgeText: null,
  label: null,
  detail: null,
};
const UNKNOWN: ProviderAuth = {
  status: "unknown",
  badgeText: null,
  label: null,
  detail: null,
};

function providerState(
  providerId: ProviderId,
  auth: ProviderAuth,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth,
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

function claudeState(auth: ProviderAuth): ProviderCliState {
  return providerState("claude-code", auth);
}

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  authStatus: ProviderAuth["status"],
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: { status: authStatus, badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function claudeStateWithProfiles(
  profiles: ProviderProfile[],
): ProviderCliState {
  return { ...claudeState(AUTHED), profiles };
}

describe("useProviderReauthGate", () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.toastError.mockClear();
    mocks.providers = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("flags signedOut on a definitive unauthenticated probe", () => {
    mocks.providers = [claudeState(UNAUTH)];
    const { result } = renderHook(() =>
      useProviderReauthGate("claude", null, true, "authoritative"),
    );
    expect(result.current.signedOut).toBe(true);
    expect(result.current.providerId).toBe("claude-code");
  });

  it("maps OpenRouter to its API-key provider state", () => {
    mocks.providers = [providerState("openrouter", UNAUTH)];
    const { result } = renderHook(() =>
      useProviderReauthGate("openrouter", null, true, "authoritative"),
    );
    expect(result.current.signedOut).toBe(true);
    expect(result.current.providerId).toBe("openrouter");
    expect(mocks.toastError).toHaveBeenCalledWith("OpenRouter is signed out");
  });

  it("does NOT flag signedOut on a transient unknown probe", () => {
    mocks.providers = [claudeState(UNKNOWN)];
    const { result } = renderHook(() =>
      useProviderReauthGate("claude", null, true, "authoritative"),
    );
    expect(result.current.signedOut).toBe(false);
  });

  it("does NOT auto force-refresh on activate (would flicker the banner)", () => {
    mocks.providers = [claudeState(AUTHED)];
    renderHook(() =>
      useProviderReauthGate("claude", null, true, "authoritative"),
    );
    // A bare force-refresh bypasses the host poison and re-runs the flaky
    // standalone probe, flipping a genuinely signed-out provider back to
    // `authenticated`. Re-checks are user-driven (the banner Refresh button) or
    // driven by the next failing run's poison - never automatic here.
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("fires one sign-out toast on the entering edge, not per render", () => {
    mocks.providers = [claudeState(UNAUTH)];
    const { rerender } = renderHook(() =>
      useProviderReauthGate("claude", null, true, "authoritative"),
    );
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("Claude Code is signed out");
    // Still signed out on a re-render -> no duplicate toast (latched on provider).
    rerender();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it("clears signedOut and toasts once the probe confirms authenticated", () => {
    mocks.providers = [claudeState(UNAUTH)];
    const { result, rerender } = renderHook(() =>
      useProviderReauthGate("claude", null, true, "authoritative"),
    );
    expect(result.current.signedOut).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);

    // Reconnect: the probe flips to authenticated -> the gate clears and the
    // success toast fires exactly once.
    mocks.providers = [claudeState(AUTHED)];
    rerender();
    expect(result.current.signedOut).toBe(false);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not phantom-fire the success toast through a transient unknown", () => {
    mocks.providers = [claudeState(UNAUTH)];
    const { rerender } = renderHook(() =>
      useProviderReauthGate("claude", null, true, "authoritative"),
    );
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    // A token paste makes the host re-probe, emitting a transient `unknown`
    // before the verdict; the success toast must wait for `authenticated`.
    mocks.providers = [claudeState(UNKNOWN)];
    rerender();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    mocks.providers = [claudeState(AUTHED)];
    rerender();
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("stays inert when the composer is inactive", () => {
    mocks.providers = [claudeState(UNAUTH)];
    const { result } = renderHook(() =>
      useProviderReauthGate("claude", null, false, "authoritative"),
    );
    expect(result.current.signedOut).toBe(false);
  });

  describe("per-profile reasons", () => {
    it("flags profile_missing when the committed profileId isn't among active profiles (removed/tombstoned/seeded-stale)", () => {
      mocks.providers = [
        claudeStateWithProfiles([
          profile("ambient", "ambient", "Terminal account", "authenticated"),
          profile("work-uuid", "managed", "Work", "authenticated"),
        ]),
      ];
      const { result } = renderHook(() =>
        useProviderReauthGate(
          "claude",
          "removed-profile-uuid",
          true,
          "authoritative",
        ),
      );
      expect(result.current.signedOut).toBe(true);
      expect(result.current.reason).toBe("profile_missing");
      expect(result.current.profileLabel).toBeNull();
    });

    it("flags profile_unauthenticated when the matched profile's own auth is signed out", () => {
      mocks.providers = [
        claudeStateWithProfiles([
          profile("ambient", "ambient", "Terminal account", "authenticated"),
          profile("work-uuid", "managed", "Work", "unauthenticated"),
        ]),
      ];
      const { result } = renderHook(() =>
        useProviderReauthGate("claude", "work-uuid", true, "authoritative"),
      );
      expect(result.current.signedOut).toBe(true);
      expect(result.current.reason).toBe("profile_unauthenticated");
      expect(result.current.profileLabel).toBe("Work");
    });

    it("does NOT block send for a healthy managed profile just because ambient is signed out", () => {
      // The provider-level `auth` (ambient's own probe) is unauthenticated, but
      // the composer's committed profile is a DIFFERENT, healthy managed one -
      // the gate must read that profile's own status, not the provider-level one.
      mocks.providers = [
        {
          ...claudeState(UNAUTH),
          profiles: [
            profile(
              "ambient",
              "ambient",
              "Terminal account",
              "unauthenticated",
            ),
            profile("work-uuid", "managed", "Work", "authenticated"),
          ],
        },
      ];
      const { result } = renderHook(() =>
        useProviderReauthGate("claude", "work-uuid", true, "authoritative"),
      );
      expect(result.current.signedOut).toBe(false);
      expect(result.current.reason).toBeNull();
    });

    it("stays inert for a non-null profileId while providers.list hasn't settled yet (unsettled - never false-positives an undetermined profile)", () => {
      mocks.providers = undefined;
      const { result } = renderHook(() =>
        useProviderReauthGate(
          "claude",
          "some-profile-uuid",
          true,
          "authoritative",
        ),
      );
      expect(result.current.signedOut).toBe(false);
      expect(result.current.reason).toBeNull();
    });

    it("ticket 07 round 2: blocks send for a non-null profileId once providers.list SETTLES on no profiles for this provider (flag off / old host) - a settled empty list means 'no support', not 'unknown'", () => {
      // `claudeState` defaults `profiles: []` - the provider HAS responded,
      // just with no multi-profile support (old host, or a new host with the
      // flag off / an unsupported provider). Preserving the pin here would
      // silently run the account on ambient while the chat artifact still
      // claimed the managed profile - this must block send and offer the
      // confirm-first ambient fallback instead (never a silent switch).
      mocks.providers = [claudeState(AUTHED)];
      const { result } = renderHook(() =>
        useProviderReauthGate(
          "claude",
          "some-profile-uuid",
          true,
          "authoritative",
        ),
      );
      expect(result.current.signedOut).toBe(true);
      expect(result.current.reason).toBe("profile_missing");
      expect(result.current.profileLabel).toBeNull();
    });

    it("never toasts for a profile-specific reason (only the ambient provider_unauthenticated toast fires)", () => {
      mocks.providers = [
        claudeStateWithProfiles([
          profile("ambient", "ambient", "Terminal account", "authenticated"),
          profile("work-uuid", "managed", "Work", "unauthenticated"),
        ]),
      ];
      renderHook(() =>
        useProviderReauthGate("claude", "work-uuid", true, "authoritative"),
      );
      expect(mocks.toastError).not.toHaveBeenCalled();
    });
  });

  describe("authoritative gates ONLY profile_missing, never profile_unauthenticated", () => {
    it("a non-authoritative selection whose pin EXISTS but is itself unauthenticated still shows the banner and blocks send", () => {
      // Prong 2 (`useComposerToolbarStore`'s seed validation) already nulls
      // out a non-existent fallback pin before it ever reaches this gate, so
      // a non-authoritative `profileId` that still resolves to a real row
      // here is a CONFIRMED-EXISTING profile, not a guess. Suppressing this
      // would silently let a turn dispatch on a signed-out profile and only
      // surface the banner after it failed host-side mid-send.
      mocks.providers = [
        claudeStateWithProfiles([
          profile("ambient", "ambient", "Terminal account", "authenticated"),
          profile("work-uuid", "managed", "Work", "unauthenticated"),
        ]),
      ];
      const { result } = renderHook(() =>
        useProviderReauthGate("claude", "work-uuid", true, "fallback"),
      );
      expect(result.current.signedOut).toBe(true);
      expect(result.current.reason).toBe("profile_unauthenticated");
      expect(result.current.profileLabel).toBe("Work");
    });

    it("sibling control: a non-authoritative selection whose pin is settled-ABSENT stays silent (profile_missing is the one reason authoritative gates)", () => {
      mocks.providers = [
        claudeStateWithProfiles([
          profile("ambient", "ambient", "Terminal account", "authenticated"),
          profile("work-uuid", "managed", "Work", "authenticated"),
        ]),
      ];
      const { result } = renderHook(() =>
        useProviderReauthGate(
          "claude",
          "removed-profile-uuid",
          true,
          "fallback",
        ),
      );
      expect(result.current.signedOut).toBe(false);
      expect(result.current.reason).toBeNull();
    });
  });
});
