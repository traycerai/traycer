/**
 * The `epic.subscribe@1` ↔ lanes mid-session replacement, asserted as a value.
 *
 * This is the path T6 declined by an approved scope split and the ticket makes
 * "an explicitly tested path". The seam's own doc says why it deserves a test
 * of its own rather than a line in a bigger one: *every long-lived tab hits this
 * exactly once*, which makes it the single most likely path to ship untested.
 *
 * Asserted on the ORDERED step list rather than on spy call order, because the
 * order IS the contract - a reset before a detach lets the outgoing set's next
 * frame land in the rebuilt replica, and an attach before the reset seeds a
 * replica that is about to be emptied. A test that read spies could pass with
 * the right calls in the wrong order.
 */
import { describe, expect, it } from "vitest";
import {
  MANIFEST_CHANGED_RESET,
  planEpicAdapterTransition,
} from "../epic-adapter-lifecycle";

describe("mid-session host upgrade: legacy -> lanes", () => {
  it("detaches superseded, resets manifest-changed, bumps, then attaches - in that order", () => {
    const transition = planEpicAdapterTransition("legacy", "lanes");

    expect(transition.steps).toEqual([
      { kind: "detach", arm: "legacy" },
      { kind: "reset", cause: MANIFEST_CHANGED_RESET },
      { kind: "bump-generation" },
      { kind: "attach", arm: "lanes" },
    ]);
    expect(transition.installed).toBe("lanes");
    expect(transition.fingerprint).toBe("epic-adapters:lanes");
  });

  it("resets with AUTHORITY provenance and the manifest-changed reason", () => {
    const [, reset] = planEpicAdapterTransition("legacy", "lanes").steps;
    // Not a client intent. The host's manifest changed under us, so a
    // `{origin: "client"}` cause here would put a fabricated provenance into
    // logs, telemetry and the replay harness, where nothing downstream could
    // tell it from a real authority event.
    expect(reset).toEqual({
      kind: "reset",
      cause: { origin: "authority", reason: "manifest-changed" },
    });
  });

  it("is symmetric - a host that stops serving the lanes replaces too", () => {
    const transition = planEpicAdapterTransition("lanes", "legacy");
    expect(transition.steps).toEqual([
      { kind: "detach", arm: "lanes" },
      { kind: "reset", cause: MANIFEST_CHANGED_RESET },
      { kind: "bump-generation" },
      { kind: "attach", arm: "legacy" },
    ]);
  });
});

describe("what must NOT be a replacement", () => {
  it("the first install detaches nothing, resets nothing and bumps nothing", () => {
    // A cold open is not a replacement. Emitting an authority reset before the
    // first frame would be a fabricated authority event on the most ordinary
    // path there is - and it would bump a generation nobody has observed.
    for (const arm of ["lanes", "legacy"] as const) {
      expect(planEpicAdapterTransition(null, arm).steps).toEqual([
        { kind: "attach", arm },
      ]);
    }
  });

  it("re-selecting the SAME arm costs nothing", () => {
    expect(planEpicAdapterTransition("lanes", "lanes").steps).toEqual([]);
    expect(planEpicAdapterTransition("legacy", "legacy").steps).toEqual([]);
  });

  it("an undecided verdict produces NO steps and holds what is installed", () => {
    // The reconnect window. `resetMethodSupport` clears the whole support map
    // on every reconnect, so a healthy reconnect on a lane host passes through
    // a moment where every lane method reads `"unknown"`. Emitting a
    // replacement there would tear the replica down and rebuild it twice for a
    // link that never changed.
    const held = planEpicAdapterTransition("lanes", "undecided");
    expect(held.steps).toEqual([]);
    expect(held.installed).toBe("lanes");
    expect(held.fingerprint).toBe("epic-adapters:lanes");
  });

  it("undecided with nothing installed attaches nothing at all", () => {
    // In particular it does not open `epic.subscribe@1` as a probe: the
    // status-lane open is the probe, and it is the runtime's first action.
    const cold = planEpicAdapterTransition(null, "undecided");
    expect(cold.steps).toEqual([]);
    expect(cold.installed).toBeNull();
    expect(cold.fingerprint).toBeNull();
  });
});

describe("the fingerprint moves only when the arm does", () => {
  it("is stable across a hold, and differs across a replacement", () => {
    const before = planEpicAdapterTransition("legacy", "undecided");
    const after = planEpicAdapterTransition("legacy", "legacy");
    expect(after.fingerprint).toBe(before.fingerprint);

    const replaced = planEpicAdapterTransition("legacy", "lanes");
    expect(replaced.fingerprint).not.toBe(before.fingerprint);
    // And a change in the fingerprint is exactly when steps appear.
    expect(before.steps).toEqual([]);
    expect(after.steps).toEqual([]);
    expect(replaced.steps.length).toBeGreaterThan(0);
  });

  it("never emits steps without moving the fingerprint, or vice versa", () => {
    // The invariant behind the whole design, over every reachable pair: a
    // replacement is exactly a fingerprint change. If these ever came apart,
    // either a replica would be rebuilt for nothing or a real upgrade would be
    // swapped in under a live replica.
    const arms = [null, "legacy", "lanes"] as const;
    const verdicts = ["legacy", "lanes", "undecided"] as const;
    for (const installed of arms) {
      const beforePrint =
        installed === null
          ? null
          : planEpicAdapterTransition(installed, installed).fingerprint;
      for (const verdict of verdicts) {
        const transition = planEpicAdapterTransition(installed, verdict);
        const fingerprintMoved = transition.fingerprint !== beforePrint;
        const isReplacement = transition.steps.some(
          (step) => step.kind === "reset",
        );
        // A reset happens iff the fingerprint moved AND something was
        // installed to replace. The first-install case moves the fingerprint
        // without a reset, which is the one deliberate asymmetry.
        expect(isReplacement).toBe(fingerprintMoved && installed !== null);
      }
    }
  });
});
