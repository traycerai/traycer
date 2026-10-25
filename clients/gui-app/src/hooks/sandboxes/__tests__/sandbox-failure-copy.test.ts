import { describe, expect, it } from "vitest";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  sandboxCreateFailureMessage,
  sandboxFailureMessage,
} from "@/hooks/sandboxes/sandbox-failure-copy";
import { refusal } from "./sandbox-binding-fixture";

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
    message: null,
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

  it("says the unavailable failure's own reason, whatever it is", () => {
    expect(
      sandboxFailureMessage({
        kind: "unavailable",
        reason: "Sandboxes aren't available in staging builds.",
      }),
    ).toBe("Sandboxes aren't available in staging builds.");
  });

  it("words a rename authn cannot take as a retry, not the generic refusal", () => {
    expect(
      sandboxFailureMessage(refused("rename_unavailable", NO_DETAIL)),
    ).toBe("Couldn't rename the sandbox. Try again in a moment.");
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

  it("words a plan too small to run a sandbox", () => {
    expect(
      sandboxFailureMessage(
        refused("shape_not_offered", {
          reason: "provider-plan-too-small",
          shortfallMc: null,
        }),
      ),
    ).toBe("This account's sandbox plan can't run a sandbox yet.");
  });

  it("shows a full team's server sentence verbatim, and a fallback when it sends none", () => {
    const sentence = "Every pod of Alpha is full. Ask an admin to add one.";
    expect(
      sandboxFailureMessage({
        kind: "refused",
        status: 409,
        code: "team_pods_full",
        reason: null,
        shortfallMc: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: sentence,
      }),
    ).toBe(sentence);
    expect(sandboxFailureMessage(refused("team_pods_full", NO_DETAIL))).toBe(
      "Every team pod is full; ask an admin to add one.",
    );
  });

  it("falls back to the fixed team-pods-full sentence when the server's message is empty", () => {
    expect(
      sandboxFailureMessage({
        kind: "refused",
        status: 409,
        code: "team_pods_full",
        reason: null,
        shortfallMc: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: "",
      }),
    ).toBe("Every team pod is full; ask an admin to add one.");
  });

  it("treats a code that is an Object.prototype name as unknown, not as a lookup hit", () => {
    for (const code of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(sandboxFailureMessage(refused(code, NO_DETAIL))).toBe(
        "Traycer refused that request.",
      );
    }
  });

  it("never shows a message the server sends with any other code", () => {
    expect(
      sandboxFailureMessage({
        kind: "refused",
        status: 409,
        code: "sandbox_busy",
        reason: null,
        shortfallMc: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: "raw server text",
      }),
    ).toContain("stays awake");
  });

  it("says the server refused for a code this build does not know, never the raw code", () => {
    const message = sandboxFailureMessage(
      refused("something_from_the_future", NO_DETAIL),
    );
    expect(message).toBe("Traycer refused that request.");
    expect(message).not.toContain("something_from_the_future");
  });
});

describe("sandboxCreateFailureMessage", () => {
  it("names the picked team when the environment is not the caller's", () => {
    expect(
      sandboxCreateFailureMessage(
        refusal(404, "environment_not_found"),
        "acme",
      ),
    ).toBe("You are not a member of acme.");
  });

  it("falls back to the plain refusal copy for that code when no team was picked", () => {
    const failure = refusal(404, "environment_not_found");
    const message = sandboxCreateFailureMessage(failure, null);
    expect(message).toBe(sandboxFailureMessage(failure));
    expect(message).not.toContain("acme");
  });

  it("says Traycer could not check where the sandbox belongs when the environment check was unavailable", () => {
    expect(
      sandboxCreateFailureMessage(
        refusal(503, "environment_unavailable"),
        "acme",
      ),
    ).toBe(
      "Traycer couldn't check where this sandbox belongs. Try again in a moment.",
    );
    expect(
      sandboxCreateFailureMessage(
        refusal(503, "environment_unavailable"),
        null,
      ),
    ).toBe(
      "Traycer couldn't check where this sandbox belongs. Try again in a moment.",
    );
  });

  it("passes any other code through to the shared copy, team or not", () => {
    for (const code of [
      "insufficient_credit",
      "provider_unavailable",
      "something_from_the_future",
    ]) {
      const failure = refusal(402, code);
      expect(sandboxCreateFailureMessage(failure, "acme")).toBe(
        sandboxFailureMessage(failure),
      );
      expect(sandboxCreateFailureMessage(failure, null)).toBe(
        sandboxFailureMessage(failure),
      );
    }
  });

  it("passes a failure that is not a refusal through to the shared copy", () => {
    const failure: SandboxControlFailure = {
      kind: "network-error",
      detail: "the request never completed (TypeError)",
    };
    expect(sandboxCreateFailureMessage(failure, "acme")).toBe(
      "Couldn't reach Traycer. Try again in a moment.",
    );
  });
});
