import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAuth,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";

// The gate's only collaborators are the tab-scoped providers query and its
// force-refresh twin, plus a reconnect toast - stub all three so the test drives
// pure probe-status combinations.
const mocks = vi.hoisted(() => ({
  refresh: vi.fn(() => Promise.resolve()),
  providers: [] as ProviderCliState[],
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: () => ({ data: { providers: mocks.providers } }),
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
  };
}

function claudeState(auth: ProviderAuth): ProviderCliState {
  return providerState("claude-code", auth);
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
    const { result } = renderHook(() => useProviderReauthGate("claude", true));
    expect(result.current.signedOut).toBe(true);
    expect(result.current.providerId).toBe("claude-code");
  });

  it("maps OpenRouter to its API-key provider state", () => {
    mocks.providers = [providerState("openrouter", UNAUTH)];
    const { result } = renderHook(() =>
      useProviderReauthGate("openrouter", true),
    );
    expect(result.current.signedOut).toBe(true);
    expect(result.current.providerId).toBe("openrouter");
    expect(mocks.toastError).toHaveBeenCalledWith("OpenRouter is signed out");
  });

  it("does NOT flag signedOut on a transient unknown probe", () => {
    mocks.providers = [claudeState(UNKNOWN)];
    const { result } = renderHook(() => useProviderReauthGate("claude", true));
    expect(result.current.signedOut).toBe(false);
  });

  it("does NOT auto force-refresh on activate (would flicker the banner)", () => {
    mocks.providers = [claudeState(AUTHED)];
    renderHook(() => useProviderReauthGate("claude", true));
    // A bare force-refresh bypasses the host poison and re-runs the flaky
    // standalone probe, flipping a genuinely signed-out provider back to
    // `authenticated`. Re-checks are user-driven (the banner Refresh button) or
    // driven by the next failing run's poison - never automatic here.
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("fires one sign-out toast on the entering edge, not per render", () => {
    mocks.providers = [claudeState(UNAUTH)];
    const { rerender } = renderHook(() =>
      useProviderReauthGate("claude", true),
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
      useProviderReauthGate("claude", true),
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
      useProviderReauthGate("claude", true),
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
    const { result } = renderHook(() => useProviderReauthGate("claude", false));
    expect(result.current.signedOut).toBe(false);
  });
});
