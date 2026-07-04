import { describe, expect, it } from "vitest";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";

describe("providerRateLimitQueryOptions", () => {
  it("gives an httpFetch provider its own refetchInterval and keeps TanStack's default refetchOnMount", () => {
    const { options } = providerRateLimitQueryOptions("openrouter");
    expect(options?.refetchInterval).toBe(5 * 60 * 1000);
    expect(options?.refetchOnMount).toBe(true);
  });

  it("disables both refetchInterval and refetchOnMount for an ephemeralProcess provider", () => {
    const { options } = providerRateLimitQueryOptions("codex");
    expect(options?.refetchInterval).toBe(false);
    expect(options?.refetchOnMount).toBe(false);
  });
});
