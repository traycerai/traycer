import { describe, expect, it, vi } from "vitest";

describe("HostCompatibilityContext", () => {
  it("retains one context across Fast Refresh module generations", async () => {
    const providerGeneration = await import("@/lib/host/compatibility-state");

    vi.resetModules();

    const hookGeneration = await import("@/lib/host/compatibility-state");

    expect(providerGeneration.HostCompatibilityContext).toBe(
      hookGeneration.HostCompatibilityContext,
    );
  });
});
