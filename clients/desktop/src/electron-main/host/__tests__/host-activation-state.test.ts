import { describe, expect, it } from "vitest";
import { deriveActivationState } from "../host-state";

// `activation` is what `runLaunchHostConvergeReconcile` switches on at launch,
// and oss #913 made `"unavailable"` run `convergeReady`. The load-bearing fact
// - which nothing tested directly - is what "unavailable" actually MEANS.
//
// It is not "the service is unregistered" and not a Windows constant. It is
// derived purely from `runningRuntimeVersion === null`: NO HOST IS RUNNING.
// That is why the crashed-host-at-launch case (OSS #916, where the desktop
// logged `launch converge has no activation debt { activation: 'unavailable' }`
// against a host that had crash-aborted 12 hours earlier) reaches the same
// recovery arm as a reinstall that dropped the registration.
//
// If this ever narrows to "unregistered", a crashed host silently stops being
// converged at launch and #916 regresses without any converge test failing.

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
