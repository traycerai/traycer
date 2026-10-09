import { describe, expect, it } from "vitest";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";

function refused(
  code: string,
  detail: {
    readonly reason: string | null;
    readonly shortfallMc: number | null;
  },
): SandboxControlFailure {
  return {
    kind: "refused",
    status: 400,
    code,
    reason: detail.reason,
    shortfallMc: detail.shortfallMc,
    newRateMcPerHour: null,
    currentAwakeBurnMcPerHour: null,
  };
}

const NO_DETAIL = { reason: null, shortfallMc: null };

describe("sandboxFailureMessage", () => {
  it("tells an unauthorized failure to sign in and a network error to retry, never echoing detail", () => {
    expect(sandboxFailureMessage({ kind: "unauthorized" })).toBe(
      "Sign in again to try that.",
    );
    const message = sandboxFailureMessage({
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    });
    expect(message).toBe("Couldn't reach Traycer. Try again in a moment.");
    expect(message).not.toContain("TypeError");
  });

  it("words the frozen and busy refusals the card and the tile surface", () => {
    expect(
      sandboxFailureMessage(refused("sandbox_frozen", NO_DETAIL)),
    ).toContain("credits ran out");
    expect(sandboxFailureMessage(refused("sandbox_busy", NO_DETAIL))).toContain(
      "stays awake",
    );
    expect(
      sandboxFailureMessage(refused("sandbox_transition_conflict", NO_DETAIL)),
    ).toContain("changing state");
    expect(sandboxFailureMessage(refused("sandbox_not_found", NO_DETAIL))).toBe(
      "This sandbox no longer exists.",
    );
    expect(
      sandboxFailureMessage(refused("verb_not_available", NO_DETAIL)),
    ).toBe("This action isn't available yet.");
  });

  it("names the credits to add when the gate knows the shortfall and not when it does not", () => {
    expect(
      sandboxFailureMessage(
        refused("insufficient_credit", {
          reason: "denied",
          shortfallMc: 7_000,
        }),
      ),
    ).toBe(
      "Your credits don't cover an hour of this sandbox. Add 7.00 credits and try again.",
    );
    expect(
      sandboxFailureMessage(
        refused("insufficient_credit", { reason: "denied", shortfallMc: null }),
      ),
    ).toBe("Your credits don't cover an hour of this sandbox.");
  });

  it("rounds the credits to add UP, so the retry is not refused again by a rounded-down top-up", () => {
    expect(
      sandboxFailureMessage(
        refused("insufficient_credit", {
          reason: "denied",
          shortfallMc: 10_100,
        }),
      ),
    ).toBe(
      "Your credits don't cover an hour of this sandbox. Add 11 credits and try again.",
    );
  });

  it("reads the gate's other verdicts as what they are", () => {
    expect(
      sandboxFailureMessage(
        refused("insufficient_credit", {
          reason: "unverified",
          shortfallMc: 50,
        }),
      ),
    ).toContain("couldn't confirm your credit balance");
    expect(
      sandboxFailureMessage(
        refused("insufficient_credit", {
          reason: "unsupported-subscription",
          shortfallMc: null,
        }),
      ),
    ).toBe("Your plan doesn't include sandboxes.");
  });

  it("words each shape bound and falls back for an unknown one", () => {
    expect(
      sandboxFailureMessage(
        refused("shape_not_offered", {
          reason: "disk-out-of-range",
          shortfallMc: null,
        }),
      ),
    ).toBe("That disk size is outside what's offered.");
    expect(
      sandboxFailureMessage(
        refused("shape_not_offered", {
          reason: "new-bound",
          shortfallMc: null,
        }),
      ),
    ).toBe("That size is outside what's offered.");
  });

  it("says the server refused for a code this build does not know, never the raw code", () => {
    const message = sandboxFailureMessage(
      refused("something_from_the_future", NO_DETAIL),
    );
    expect(message).toBe("Traycer refused that request.");
    expect(message).not.toContain("something_from_the_future");
  });
});
