import { describe, expect, it } from "vitest";
import { parseLandingTerminalTabRef } from "@/stores/home/landing-panel-store";

function baseTabJson(): Record<string, unknown> {
  return {
    instanceId: "landing-term-1",
    sessionId: "sess-1",
    hostId: "host-1",
    cwd: "~",
    name: "Reasonix sign-in",
    titleSource: "manual",
  };
}

describe("parseLandingTerminalTabRef provider-login origin", () => {
  it("keeps origin and a valid originProviderId for a provider-login tab", () => {
    const parsed = parseLandingTerminalTabRef({
      ...baseTabJson(),
      origin: "provider-login",
      originProviderId: "reasonix",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.origin).toBe("provider-login");
    expect(parsed?.originProviderId).toBe("reasonix");
  });

  it("keeps origin but drops originProviderId for an unknown provider id string", () => {
    const parsed = parseLandingTerminalTabRef({
      ...baseTabJson(),
      origin: "provider-login",
      originProviderId: "not-a-real-provider",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.origin).toBe("provider-login");
    expect(parsed).not.toHaveProperty("originProviderId");
  });

  it("adds neither origin nor originProviderId for a tab with no origin", () => {
    const parsed = parseLandingTerminalTabRef(baseTabJson());
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("origin");
    expect(parsed).not.toHaveProperty("originProviderId");
  });
});
