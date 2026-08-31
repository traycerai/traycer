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
    });
    expect(copy.primary).toBe("Last seen: Downloading update to v1.9.0");
  });

  it("needsQualifiedMarker is FALSE for a retained-phase sentence — it already carries the qualification inline", () => {
    const copy = describeUpdateOperation({
      view: retainedView({}),
      hostName: "host-a",
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
    });
    expect(copy.primary).toBe("Downloading update to v1.9.0");
    expect(copy.needsQualifiedMarker).toBe(true);
  });

  it("a retained IDLE phase reads without a target version suffix, since idle names no target", () => {
    const copy = describeUpdateOperation({
      view: retainedView({ lastKnownKind: "idle", targetVersion: null }),
      hostName: "host-a",
    });
    expect(copy.primary).toBe("Last seen: Host is up to date");
  });

  it("a retained `unknown` lastKnownKind (unreachable through normal projection, but a table this switch must still cover) falls back to the generic sentence", () => {
    const copy = describeUpdateOperation({
      view: retainedView({ lastKnownKind: "unknown" }),
      hostName: "host-a",
    });
    expect(copy.primary).toBe("Update state unknown");
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
