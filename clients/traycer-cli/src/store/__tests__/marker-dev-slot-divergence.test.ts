import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_DESKTOP_SLOT_ENV } from "@traycer-clients/shared/platform/dev-desktop-slot";
import { hostUpdateProgressMarkerPath } from "../paths";

// Ticket 07 §2.2 — PIN the legacy marker's dev-slot divergence. Deliberately
// a pin and NOT a refactor: the marker is scheduled for deletion (§2.1), and
// refactoring a file on its way out costs more than it protects.
//
// ## The divergence, stated exactly
//
// `update-progress.json` is mirrored **by contract, not by import** between
// `clients/traycer-cli/src/store/paths.ts` (the writer) and
// `traycer-host/src/paths.ts` (the poller). The two resolve the same path by
// two DIFFERENT mechanisms:
//
//  - the CLI consults `devDesktopSlotForEnvironment(environment, process.env)`
//    and returns a dev-run subdir when a slot is active;
//  - the host honours its `--host-data-dir` override ONLY for
//    `environment === undefined` (its own slot). For an explicit environment it
//    deliberately returns the canonical baked slot.
//
// So in a dev slot the writer's path comes from `process.env` and the reader's
// from a runtime override set by the dev identity-pool walk. **They agree only
// by coincidence of configuration.**
//
// This is the second-copy-of-a-policy class that produced round 2's finding in
// Ticket 05: two independent derivations of one fact, differing in a case
// nobody enumerated. Recorded that way on purpose.
//
// ## What this file does and does not assert
//
// It pins the CLI side only. Asserting the host's rule here would require
// either importing the host package - which the no-host-package-import
// boundary forbids - or restating its rule in this file, which would be a
// THIRD copy of the very policy whose duplication is the bug. So the host's
// rule is quoted above as prose, and what is pinned below is the property that
// makes the divergence possible: the writer's marker path is slot-sensitive,
// and only for `dev`.
//
// If someone makes the CLI side slot-insensitive (or makes production
// slot-sensitive), these fail - which is the signal that the writer moved
// underneath a reader that did not.

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

    // Stated separately from the test above because it is a different claim:
    // the first says the slot matters, this says slots are distinguished from
    // each other. A derivation that collapsed every slot onto one path would
    // pass the first and fail this.
    expect(a).not.toBe(b);
  });

  it.each(["production", "staging"] as const)(
    "%s is NOT slot-sensitive — the variable is ignored outside dev",
    (environment) => {
      const withoutSlot = hostUpdateProgressMarkerPath(environment);
      process.env[DEV_DESKTOP_SLOT_ENV] = "slot-a";
      const withSlot = hostUpdateProgressMarkerPath(environment);

      // The bound on the divergence, and the reason this matters: if a slot
      // ever moved the PRODUCTION marker, a dev environment variable left set
      // on an operator's machine would silently redirect the production
      // handoff to a path the host does not poll.
      expect(withSlot).toBe(withoutSlot);
      expect(withSlot).not.toContain("slot-a");
    },
  );
});
