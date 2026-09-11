/**
 * Auto's decision arithmetic, in isolation from the tile that calls it and the
 * canvas that feeds it. `decideOfficeView` takes exactly two inputs - the plan
 * input and a canvas box - and this suite pins the answer over that surface
 * only.
 */
import { describe, expect, it } from "vitest";
import { decideOfficeView } from "@/lib/comm-graph/office/office-auto";
import { OFFICE_LOD_OFFICE_ZOOM } from "@/lib/comm-graph/office/office-lod";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeSize,
} from "@/lib/comm-graph/office/office-types";
import type { OfficePlanInput } from "@/lib/comm-graph/office/views/office-view";

/** The tile's canvas box after chrome, on the recording's own epic. */
const FULL_CANVAS: OfficeSize = { width: 1040, height: 700 };

/**
 * Built the way the scene builds it - from `partitionOfficePopulation`, not a
 * stub - matching the pattern `office-plans.test.ts` uses for the same input
 * type.
 */
function planInputFor(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
}): OfficePlanInput {
  const { agents, statusById } = args;
  return {
    agents,
    partition: partitionOfficePopulation({
      agents,
      statusById,
      previous: null,
    }),
    occupancy: new Map<string, string>(),
    needsCapacity: [],
    activityById: new Map<string, number>(),
    viewport: FULL_CANVAS,
    previous: null,
  };
}

function triageInput(count: number, seed: number): OfficePlanInput {
  const epic = makeTestEpic("triage", count, seed);
  return planInputFor({ agents: epic.agents, statusById: epic.statusById });
}

describe("decideOfficeView", () => {
  it("picks Floor for a small epic on a large tile", () => {
    const decision = decideOfficeView(triageInput(12, 1), FULL_CANVAS);
    expect(decision.view).toBe("floor");
    const floorFit = decision.fits.find((fit) => fit.view === "floor");
    expect(floorFit?.zoom).toBeGreaterThanOrEqual(OFFICE_LOD_OFFICE_ZOOM);
  });

  it("picks Towers where it reaches office detail and Floor does not", () => {
    const decision = decideOfficeView(triageInput(40, 1), FULL_CANVAS);
    expect(decision.view).toBe("towers");
    const floorFit = decision.fits.find((fit) => fit.view === "floor");
    const towersFit = decision.fits.find((fit) => fit.view === "towers");
    expect(floorFit?.zoom).toBeLessThan(OFFICE_LOD_OFFICE_ZOOM);
    expect(towersFit?.zoom).toBeGreaterThanOrEqual(OFFICE_LOD_OFFICE_ZOOM);
  });

  it("falls back to Building when neither candidate reaches office detail, without measuring Building", () => {
    // The recording's own shape: 309 agents at 1040x700 reaches office detail
    // on neither Floor nor Towers (Towers lands around 0.68x).
    const decision = decideOfficeView(triageInput(309, 1), FULL_CANVAS);
    expect(decision.view).toBe("building");
    // Only Floor and Towers are candidates, tried in that order - Building is
    // the fallback name, never a measured entry.
    expect(decision.fits.map((fit) => fit.view)).toEqual(["floor", "towers"]);
    const towersFit = decision.fits.find((fit) => fit.view === "towers");
    expect(towersFit?.zoom).toBeLessThan(OFFICE_LOD_OFFICE_ZOOM);
    // A tolerance band, not exact float equality: this is a packing result,
    // and pinning it to the float would flake on the next geometry change.
    expect(towersFit?.zoom).toBeGreaterThan(0.68 * 0.9);
    expect(towersFit?.zoom).toBeLessThan(0.68 * 1.1);
  });

  it("carries both measured zooms and the agent count on the decision", () => {
    const decision = decideOfficeView(triageInput(309, 1), FULL_CANVAS);
    expect(decision.agents).toBe(309);
    expect(decision.fits).toHaveLength(2);
    for (const fit of decision.fits) {
      expect(fit.zoom).toBeGreaterThan(0);
    }
  });

  it("measures against the canvas box it is given, not a size of its own", () => {
    // The same input, offered a smaller box, can land on a different view -
    // this is the "measured after chrome" claim: the canvas the office
    // actually gets, not the tile's own size.
    const input = triageInput(40, 1);
    const full = decideOfficeView(input, FULL_CANVAS);
    expect(full.view).toBe("towers");

    const halved: OfficeSize = {
      width: FULL_CANVAS.width / 2,
      height: FULL_CANVAS.height / 2,
    };
    const half = decideOfficeView(input, halved);
    expect(half.view).toBe("building");
  });

  it("falls back to Building on a zero-size canvas, where every fit is 0", () => {
    // The canvas's own gate (`measuredBox.width/height <= 0`) is supposed to
    // keep this from ever reaching a real probe, but `decideOfficeView`
    // itself has to answer something rather than divide by zero or throw.
    const decision = decideOfficeView(triageInput(12, 1), {
      width: 0,
      height: 0,
    });
    expect(decision.view).toBe("building");
    for (const fit of decision.fits) {
      expect(fit.zoom).toBe(0);
    }
  });
});
