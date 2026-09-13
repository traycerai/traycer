import { describe, expect, it } from "vitest";
import { negotiatedActivityServesLocalOnly } from "../agent-activity-plane-admission";

describe("negotiatedActivityServesLocalOnly", () => {
  it("fails closed with no negotiated version", () => {
    expect(negotiatedActivityServesLocalOnly(null)).toBe(false);
  });

  it("fails closed below the local-only minor", () => {
    expect(negotiatedActivityServesLocalOnly({ major: 1, minor: 1 })).toBe(
      false,
    );
  });

  it("admits at the local-only minor", () => {
    expect(negotiatedActivityServesLocalOnly({ major: 1, minor: 2 })).toBe(
      true,
    );
  });

  it("admits above the local-only minor", () => {
    expect(negotiatedActivityServesLocalOnly({ major: 1, minor: 3 })).toBe(
      true,
    );
  });

  it("fails closed on a different major", () => {
    expect(negotiatedActivityServesLocalOnly({ major: 2, minor: 2 })).toBe(
      false,
    );
  });
});
