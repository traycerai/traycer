import { describe, expect, it } from "vitest";
import { providerRateLimitQueryOptions } from "@/hooks/host/provider-rate-limit-query-options";

describe("providerRateLimitQueryOptions", () => {
  it("opts an httpFetch provider into table-owned fixed polling and keeps TanStack's default refetchOnMount", () => {
    const { options } = providerRateLimitQueryOptions("openrouter", null);
    expect(options.enabled).toBe(true);
    expect(options.gcTime).toBe(Infinity);
    expect(options.poll).toBe(true);
    expect(options.retry).toBe(false);
    expect(options.refetchOnMount).toBe(true);
  });

  it("opts an ephemeralProcess provider out of observer polling and disables remount refetch", () => {
    const { options } = providerRateLimitQueryOptions("codex", null);
    expect(options.enabled).toBe(false);
    expect(options.gcTime).toBe(Infinity);
    expect(options.poll).toBe(false);
    expect(options.retry).toBe(false);
    expect(options.refetchOnMount).toBe(false);
  });
});
