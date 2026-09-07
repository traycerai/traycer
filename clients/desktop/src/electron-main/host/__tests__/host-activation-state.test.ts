import { describe, expect, it } from "vitest";
import { deriveActivationState } from "../host-state";


describe("deriveActivationState", () => {
  it("reports `unavailable` whenever no host is running, whatever is installed", () => {
    // The #916 shape: a perfectly good install whose host is simply dead.
    expect(deriveActivationState("1.1.9", null)).toBe("unavailable");
    // And with nothing installed either - still just "no live runtime".
    expect(deriveActivationState(null, null)).toBe("unavailable");
  });

  it("reports `activated` only when the running runtime matches the installed one", () => {
    expect(deriveActivationState("1.1.9", "1.1.9")).toBe("activated");
  });

  it("reports `pendingActivation` when a different runtime is live", () => {
    // Equality-only, never SemVer-ordered: a downgrade is still "pending".
    expect(deriveActivationState("1.1.10", "1.1.9")).toBe("pendingActivation");
    expect(deriveActivationState("1.1.9", "1.1.10")).toBe("pendingActivation");
  });

  it("reports `activationUnknown` when something runs but nothing is installed", () => {
    expect(deriveActivationState(null, "1.1.9")).toBe("activationUnknown");
  });
});
