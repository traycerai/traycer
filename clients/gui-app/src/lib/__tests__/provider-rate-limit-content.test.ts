import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import {
  formatUnavailableReason,
  resolvePopoverProviderRateLimitState,
} from "@/lib/provider-rate-limit-content";

const READY: ProviderRateLimits = {
  provider: "kilocode",
  available: true,
  creditBalance: 10,
  passState: null,
};

const UNAVAILABLE: ProviderRateLimits = {
  provider: "codex",
  available: false,
  reason: "cli_not_found",
};

describe("formatUnavailableReason", () => {
  it("maps the Droid org-plan gate to plain language", () => {
    expect(formatUnavailableReason("insufficient_permissions")).toBe(
      "this account doesn't have permission to view usage",
    );
  });

  it("maps the CLI-missing reason", () => {
    expect(formatUnavailableReason("cli_not_found")).toBe(
      "the CLI isn't installed",
    );
  });
});

describe("resolvePopoverProviderRateLimitState", () => {
  it("is a cold load while the first fetch is in flight with no data", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: true,
      isFetching: true,
      isError: false,
      providerRateLimits: undefined,
    });
    expect(state.kind).toBe("cold");
  });

  it("is an error when the first fetch failed with no data", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: true,
      isFetching: false,
      isError: true,
      providerRateLimits: undefined,
    });
    expect(state.kind).toBe("error");
  });

  it("surfaces the provider's own unavailable reason", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: false,
      providerRateLimits: UNAVAILABLE,
    });
    expect(state).toEqual({ kind: "unavailable", reason: "cli_not_found" });
  });

  it("is ready and not degraded for a fresh available snapshot", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: false,
      providerRateLimits: READY,
    });
    expect(state).toEqual({ kind: "ready", data: READY, degraded: false });
  });

  it("is ready but degraded when a poll failed over last-known-good data", () => {
    const state = resolvePopoverProviderRateLimitState({
      isPending: false,
      isFetching: false,
      isError: true,
      providerRateLimits: READY,
    });
    expect(state).toEqual({ kind: "ready", data: READY, degraded: true });
  });
});
