import { describe, expect, it } from "vitest";
import { shouldRedirectHomeToDraft } from "../home-route-decision";

describe("shouldRedirectHomeToDraft", () => {
  it("restored tabs + null profile → false", () => {
    expect(shouldRedirectHomeToDraft(true, null)).toBe(false);
  });

  it("empty strip + active profile → true", () => {
    expect(shouldRedirectHomeToDraft(false, "profile-1")).toBe(true);
  });

  it("empty strip + null profile → false (All projects owns /)", () => {
    expect(shouldRedirectHomeToDraft(false, null)).toBe(false);
  });

  it("restored tabs + active profile → false", () => {
    expect(shouldRedirectHomeToDraft(true, "profile-1")).toBe(false);
  });
});
