import { describe, expect, it } from "vitest";
import { negotiatedUsageServesLocalOnly } from "@/lib/usage-plane-admission";

describe("negotiatedUsageServesLocalOnly", () => {
  it("admits a host that negotiated host.usage.summary@2.0", () => {
    expect(negotiatedUsageServesLocalOnly({ major: 2, minor: 0 })).toBe(true);
  });

  it("refuses a host that only negotiated host.usage.summary@1.0", () => {
    expect(negotiatedUsageServesLocalOnly({ major: 1, minor: 0 })).toBe(false);
  });

  it("fails closed when the negotiated version is unknown", () => {
    expect(negotiatedUsageServesLocalOnly(null)).toBe(false);
  });

  it("fails closed when the host handshake says the method is absent", () => {
    expect(negotiatedUsageServesLocalOnly(false)).toBe(false);
  });
});
