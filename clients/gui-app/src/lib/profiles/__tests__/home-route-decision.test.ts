import { describe, expect, it } from "vitest";
import { shouldRedirectHomeToDraft } from "../home-route-decision";

describe("shouldRedirectHomeToDraft", () => {
  it("restored tabs + null profile → false", () => {
    expect(shouldRedirectHomeToDraft(true, null, 1)).toBe(false);
  });

  it("empty strip + active profile → true", () => {
    expect(shouldRedirectHomeToDraft(false, "profile-1", 1)).toBe(true);
  });

  it("empty strip + null profile → false (All projects owns /)", () => {
    expect(shouldRedirectHomeToDraft(false, null, 1)).toBe(false);
  });

  it("restored tabs + active profile → false", () => {
    expect(shouldRedirectHomeToDraft(true, "profile-1", 1)).toBe(false);
  });

  it("zero profiles → false even with active id / empty strip", () => {
    expect(shouldRedirectHomeToDraft(false, "stale-id", 0)).toBe(false);
  });
});
