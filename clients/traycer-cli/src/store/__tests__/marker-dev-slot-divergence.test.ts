import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_DESKTOP_SLOT_ENV } from "@traycer-clients/shared/platform/dev-desktop-slot";
import { hostUpdateProgressMarkerPath } from "../paths";

// Pin the legacy marker's dev-slot divergence: the identity-plane marker is not under the CLI install home.

describe("legacy update-progress marker — dev-slot divergence (Ticket 07 §2.2)", () => {
  const original = process.env[DEV_DESKTOP_SLOT_ENV];

  beforeEach(() => {
    delete process.env[DEV_DESKTOP_SLOT_ENV];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[DEV_DESKTOP_SLOT_ENV];
    else process.env[DEV_DESKTOP_SLOT_ENV] = original;
  });

  it("a dev slot MOVES the marker the CLI writes", () => {
    const withoutSlot = hostUpdateProgressMarkerPath("dev");
    process.env[DEV_DESKTOP_SLOT_ENV] = "slot-a";
    const withSlot = hostUpdateProgressMarkerPath("dev");

    // The divergence itself. The host, polling with an explicit environment,
    // resolves the canonical `dev` slot and never consults this variable.
    expect(withSlot).not.toBe(withoutSlot);
    expect(withSlot).toContain("slot-a");
    expect(withoutSlot).not.toContain("slot-a");
  });

  it("two different slots write to two different markers", () => {
    process.env[DEV_DESKTOP_SLOT_ENV] = "slot-a";
    const a = hostUpdateProgressMarkerPath("dev");
    process.env[DEV_DESKTOP_SLOT_ENV] = "slot-b";
    const b = hostUpdateProgressMarkerPath("dev");

    // Stated separately from the test above because it is a different claim: the first says the slot matters, this says slots are distinguished from each other.
    // A derivation that collapsed every slot onto one path would pass the first and fail this.
    expect(a).not.toBe(b);
  });

  it.each(["production", "staging"] as const)(
    "%s is NOT slot-sensitive — the variable is ignored outside dev",
    (environment) => {
      const withoutSlot = hostUpdateProgressMarkerPath(environment);
      process.env[DEV_DESKTOP_SLOT_ENV] = "slot-a";
      const withSlot = hostUpdateProgressMarkerPath(environment);

      // The bound on the divergence, and the reason this matters: if a slot ever moved the PRODUCTION marker, a dev environment variable left set on an operator's machine would silently redirect the production handoff to a path the host does not poll.
      expect(withSlot).toBe(withoutSlot);
      expect(withSlot).not.toContain("slot-a");
    },
  );
});
