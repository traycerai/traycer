import { describe, expect, it } from "vitest";
import {
  describeUpdateOperation,
  operationProgressBytes,
  operationProgressPercent,
  showsProgressBar,
} from "@/components/home/host-update-operation-copy";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

// G4: the retained-phase copy. `describeUpdateOperation` is the one place a
// `lastKnownKind` becomes the "Last seen: …" sentence, and
// `needsQualifiedMarker` must be false for it — the sentence already carries
// the qualification, and a caller appending its own "(last known)" would say
// the same thing twice.

function retainedView(overrides: Partial<FleetUpdateView>): FleetUpdateView {
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    kind: "unknown",
    qualified: true,
    lastKnownKind: "downloading",
    lastObservedAtMs: 1_000,
    targetVersion: "1.9.0",
    ...overrides,
  };
}

describe("describeUpdateOperation — retained last-known phase copy", () => {
  it('reads "Last seen: Downloading update to v…" for a retained downloading phase', () => {
    const copy = describeUpdateOperation({
      view: retainedView({}),
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Last seen: Downloading update to v1.9.0");
  });

  it("needsQualifiedMarker is FALSE for a retained-phase sentence — it already carries the qualification inline", () => {
    const copy = describeUpdateOperation({
      view: retainedView({}),
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.needsQualifiedMarker).toBe(false);
  });

  it('a bare unknown with NO retained phase reads the generic "Update state unknown" and DOES need the marker', () => {
    const copy = describeUpdateOperation({
      view: {
        ...UNKNOWN_FLEET_UPDATE_VIEW,
        qualified: true,
      },
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Update state unknown");
    expect(copy.needsQualifiedMarker).toBe(true);
  });

  it("a LIVE qualified view (e.g. indeterminate liveness) still needs the marker — carriesQualificationInline requires kind === 'unknown'", () => {
    const copy = describeUpdateOperation({
      view: {
        ...UNKNOWN_FLEET_UPDATE_VIEW,
        kind: "downloading",
        qualified: true,
        targetVersion: "1.9.0",
      },
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Downloading update to v1.9.0");
    expect(copy.needsQualifiedMarker).toBe(true);
  });

  it("a retained IDLE phase reads without a target version suffix, since idle names no target", () => {
    const copy = describeUpdateOperation({
      view: retainedView({ lastKnownKind: "idle", targetVersion: null }),
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Last seen: Host is up to date");
  });

  it("a retained `unknown` lastKnownKind (unreachable through normal projection, but a table this switch must still cover) falls back to the generic sentence", () => {
    const copy = describeUpdateOperation({
      view: retainedView({ lastKnownKind: "unknown" }),
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Update state unknown");
  });
});

// The coarse `updateProgress` marker's own view kind. `updating` is the
// marker's whole vocabulary for "in flight, phase unknown" — the legacy
// `traycer host update` path names no finer phase, so the sentence must not
// pretend to one either.
describe("describeUpdateOperation — the coarse 'updating' kind", () => {
  it('with no target version, reads "Updating host"', () => {
    const copy = describeUpdateOperation({
      view: {
        ...UNKNOWN_FLEET_UPDATE_VIEW,
        kind: "updating",
        qualified: false,
        progress: { kind: "indeterminate", bytes: null, totalBytes: null },
      },
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Updating host");
  });

  it('with a target version, reads "Updating host to v<target>"', () => {
    const copy = describeUpdateOperation({
      view: {
        ...UNKNOWN_FLEET_UPDATE_VIEW,
        kind: "updating",
        qualified: false,
        targetVersion: "2.1.0",
        progress: { kind: "indeterminate", bytes: null, totalBytes: null },
      },
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.primary).toBe("Updating host to v2.1.0");
  });

  it("showsProgressBar is true for an updating view with indeterminate progress", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "updating",
      qualified: false,
      progress: { kind: "indeterminate", bytes: null, totalBytes: null },
    };
    expect(showsProgressBar(view)).toBe(true);
  });
});

// G5: measured byte progress must render independently of percentage — both
// bytes-only and percent+bytes — and never on the `none` arm.
describe("operationProgressBytes / operationProgressPercent", () => {
  it("bytes-only (percent absent): operationProgressBytes renders, operationProgressPercent is null", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "downloading",
      progress: {
        kind: "indeterminate",
        bytes: 80_000_000,
        totalBytes: 200_000_000,
      },
    };
    expect(operationProgressPercent(view)).toBeNull();
    expect(operationProgressBytes(view)).not.toBeNull();
  });

  it("percent + bytes both present: both render", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "downloading",
      progress: {
        kind: "determinate",
        percent: 42.4,
        bytes: 80_000_000,
        totalBytes: 200_000_000,
      },
    };
    expect(operationProgressPercent(view)).toBe(42);
    expect(operationProgressBytes(view)).not.toBeNull();
  });

  it("progress.kind: 'none' renders neither, regardless of any stray bytes value", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "idle",
      progress: { kind: "none" },
    };
    expect(operationProgressPercent(view)).toBeNull();
    expect(operationProgressBytes(view)).toBeNull();
  });

  it("no bytes measured at all: operationProgressBytes is null", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "downloading",
      progress: { kind: "indeterminate", bytes: null, totalBytes: null },
    };
    expect(operationProgressBytes(view)).toBeNull();
  });
});

// showsProgressBar: shared by the banner and the Overview card. A live
// operation draws the bar; a RETAINED phase ("Last seen: …") must not — an
// animated indeterminate bar is a present-tense claim no amount of qualifying
// copy beside it withdraws. The measured numbers still render regardless
// (that is `operationProgressBytes`/`operationProgressPercent`, unaffected by
// this predicate).
describe("showsProgressBar", () => {
  it("a LIVE indeterminate operation shows the bar", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "downloading",
      progress: { kind: "indeterminate", bytes: 80_000_000, totalBytes: null },
    };
    expect(showsProgressBar(view)).toBe(true);
  });

  it("a RETAINED (unknown + lastKnownKind) view with measured bytes shows NO bar, even though the byte text still renders", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "unknown",
      qualified: true,
      lastKnownKind: "downloading",
      lastObservedAtMs: 1_000,
      progress: {
        kind: "indeterminate",
        bytes: 80_000_000,
        totalBytes: 200_000_000,
      },
    };
    expect(showsProgressBar(view)).toBe(false);
    // The numbers are a different question and are unaffected by this gate.
    expect(operationProgressBytes(view)).not.toBeNull();
  });

  it("progress.kind: 'none' never shows a bar", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "idle",
      progress: { kind: "none" },
    };
    expect(showsProgressBar(view)).toBe(false);
  });

  it("waiting-for-work never shows a bar even with progress present — a live parked bar would read as a stall", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "waiting-for-work",
      progress: { kind: "indeterminate", bytes: null, totalBytes: null },
    };
    expect(showsProgressBar(view)).toBe(false);
  });

  it("a LIVE determinate operation shows the bar", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "downloading",
      progress: {
        kind: "determinate",
        percent: 42,
        bytes: null,
        totalBytes: null,
      },
    };
    expect(showsProgressBar(view)).toBe(true);
  });
});

/**
 * The CLI-FLOOR substitution on a work park, observed on real hardware: an
 * rc-era CLI in the slot, the host sitting `Online · Idle`, and the card
 * reading "Update waits for 0 sessions to finish" while the host's reconciler
 * refused the resume every tick. Nothing was finishing because nothing was
 * running — the park was waiting for a CLI that could carry the release.
 *
 * This is the copy TABLE's half. Whether a given surface passes `true` is a
 * separate fact about that surface, pinned where it is decided:
 * `host-overview-operation-card.test.tsx` for the Overview (which reads the
 * region's own floor finding) and the banner's suites for the `false` it
 * always passes.
 */
describe("describeUpdateOperation — a work park under an unmet CLI floor", () => {
  function parkView(blockingSessionCount: number | null): FleetUpdateView {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "waiting-for-work",
      qualified: false,
      targetVersion: "1.3.0-rc.3",
      blockingSessionCount,
    };
  }

  it("names the command-line tools and points at installation help, NOT the session count", () => {
    const copy = describeUpdateOperation({
      view: parkView(0),
      hostName: "host-a",
      cliFloorBlocked: true,
    });
    expect(copy.primary).toBe(
      "Update waits for Traycer's command-line tools to be updated — see installation help",
    );
    // The half that is the actual defect. A sentence naming the tools would
    // pass the assertion above even if it still also claimed a session count,
    // and "waits for 0 sessions" is the specific claim that sent people
    // looking for work to finish that did not exist.
    expect(copy.primary).not.toContain("session");
    // The accessible label is built from the same sentence, so a screen reader
    // gets the substitution too rather than the one rendering that quietly
    // kept reading the old branch.
    expect(copy.accessibleLabel).toBe(`host-a: ${copy.primary}`);
  });

  it("a positive session count does NOT keep the count sentence — the floor outranks it", () => {
    // Deliberate, and the one place this decision is visible. Even with real
    // live work, finishing it does not resume this park: no CLI on that
    // machine can carry the release. Naming the sessions would send someone to
    // close them for nothing, and the sentence would then flip to the tools
    // one anyway the moment the last session ended.
    expect(
      describeUpdateOperation({
        view: parkView(2),
        hostName: "host-a",
        cliFloorBlocked: true,
      }).primary,
    ).toBe(
      "Update waits for Traycer's command-line tools to be updated — see installation help",
    );
  });

  it("with the floor MET, the count sentence is untouched", () => {
    expect(
      describeUpdateOperation({
        view: parkView(0),
        hostName: "host-a",
        cliFloorBlocked: false,
      }).primary,
    ).toBe("Update waits for 0 sessions to finish");
    expect(
      describeUpdateOperation({
        view: parkView(null),
        hostName: "host-a",
        cliFloorBlocked: false,
      }).primary,
    ).toBe("Update waits for work to finish");
  });

  it("substitutes on the WORK park only — an unmet floor annotates no other phase", () => {
    // The guard on the flag becoming a general "this host is floored" marker.
    // A download in flight is not blocked by a floor the summary walk found on
    // some other candidate, and `waiting-to-activate` names a RESTART into
    // bytes that are already placed — which no CLI upgrade unblocks, so
    // substituting there would trade one wrong sentence for another.
    expect(
      describeUpdateOperation({
        view: { ...parkView(0), kind: "downloading" },
        hostName: "host-a",
        cliFloorBlocked: true,
      }).primary,
    ).toBe("Downloading update to v1.3.0-rc.3");
    expect(
      describeUpdateOperation({
        view: { ...parkView(0), kind: "waiting-to-activate" },
        hostName: "host-a",
        cliFloorBlocked: true,
      }).primary,
    ).toBe("Update installed — restart host to finish");
  });

  it("a RETAINED work park carries the substitution too, under the last-seen prefix", () => {
    // `phaseSentence` is shared by the live and retained paths on purpose, so
    // this needs no arm of its own — but it is worth a pin, because the
    // alternative (substituting only live) is the kind of split that lets one
    // of two renderings of the same fact drift.
    expect(
      describeUpdateOperation({
        view: {
          ...parkView(0),
          kind: "unknown",
          lastKnownKind: "waiting-for-work",
          qualified: true,
        },
        hostName: "host-a",
        cliFloorBlocked: true,
      }).primary,
    ).toBe(
      "Last seen: Update waits for Traycer's command-line tools to be updated — see installation help",
    );
  });
});

// Q11. The sentence itself, at the module that owns it — the Overview card's
// suite pins that the card MOUNTS it, which is a different failure.
describe("describeUpdateOperation — finalizing-record", () => {
  function finalizingView(targetVersion: string | null): FleetUpdateView {
    return {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      kind: "finalizing-record",
      qualified: false,
      attemptId: "attempt-1",
      targetVersion,
    };
  }

  it("states a FACT, not an action in progress", () => {
    // Was "Finalizing the update record." — present-continuous, and wrong:
    // nothing is in progress, the next update RUN concludes the record, and
    // this card has no expiry of its own. A claim of ongoing work would get
    // falser the longer it stayed on screen. The closing clause is what makes
    // the fact bearable — it says nothing is owed of the reader.
    expect(
      describeUpdateOperation({
        view: finalizingView("2.1.0"),
        hostName: "host-a",
        cliFloorBlocked: false,
      }).primary,
    ).toBe(
      "Updated to v2.1.0. The update record is still open; the next update reconciles it.",
    );
  });

  it("drops the version suffix when the host named no target, rather than reading 'to v.'", () => {
    // The `to === ""` arm, which nothing else exercises.
    expect(
      describeUpdateOperation({
        view: finalizingView(null),
        hostName: "host-a",
        cliFloorBlocked: false,
      }).primary,
    ).toBe(
      "Updated. The update record is still open; the next update reconciles it.",
    );
  });

  it("is announced POLITELY and needs no qualified marker", () => {
    // `assertive` is reserved for `failed`. Interrupting a screen-reader user
    // with alert semantics to tell them their update succeeded is the failure
    // treatment arriving through the accessibility channel alone — which is
    // exactly the split this module's `assertive` flag was added to close.
    const copy = describeUpdateOperation({
      view: finalizingView("2.1.0"),
      hostName: "host-a",
      cliFloorBlocked: false,
    });
    expect(copy.assertive).toBe(false);
    expect(copy.needsQualifiedMarker).toBe(false);
    expect(copy.accessibleLabel).toBe(`host-a: ${copy.primary}`);
  });
});
