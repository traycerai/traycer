/**
 * `officeMonitorAlphaFor` (`office-seat-alpha.ts`) used to be two private,
 * byte-identical `monitorAlphaFor` functions - one in `floor-painter.ts`, one
 * in `mission-control-painter.ts` - so the two views agreeing on how dim an
 * idle or archived screen is was a coincidence of two copies rather than a
 * fact either painter could not drift from. This pins the agreement directly,
 * against the two REAL painters, rather than against the shared function in
 * isolation.
 */
import { describe, expect, it } from "vitest";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentStatus,
  OfficeLayout,
  OfficeSeat,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_ARCHIVED_ALPHA,
  OFFICE_IDLE_MONITOR_ALPHA,
} from "@/lib/comm-graph/office/views/office-seat-alpha";
import { planFloor } from "@/lib/comm-graph/office/views/floor/floor-plan";
import { floorPainter } from "@/lib/comm-graph/office/views/floor/floor-painter";
import { MISSION_CONTROL_PAINTER } from "@/lib/comm-graph/office/views/mission-control/mission-control-painter";
import type {
  OfficeDeskState,
  OfficePainter,
  OfficePlanInput,
} from "@/lib/comm-graph/office/views/office-view";

const VIEWPORT = { width: 1280, height: 700 };

/**
 * A small, ordinary desk seat, planned once and reused by both painters
 * below. Neither `floorPainter.seatProps` nor `MISSION_CONTROL_PAINTER`'s own
 * `paintSeat` reads `layout` for an OCCUPIED, non-console, non-sheeted desk -
 * the branch under test - so a Floor-planned seat is a fair fixture for both;
 * what is under test is the shared alpha function, not either view's own
 * geometry.
 */
const EPIC = makeTestEpic("triage", 3, 1);
const LAYOUT = planFloor({
  agents: EPIC.agents,
  partition: partitionOfficePopulation({
    agents: EPIC.agents,
    statusById: EPIC.statusById,
    previous: null,
  }),
  occupancy: new Map(),
  needsCapacity: [],
  activityById: new Map(EPIC.agents.map((agent) => [agent.id, 0])),
  viewport: VIEWPORT,
  previous: null,
} satisfies OfficePlanInput);
/**
 * A narrowing THROUGH A FUNCTION, because a module-level `if (x === undefined)
 * throw` does not narrow `x` inside the function bodies below it - they close
 * over the declared type, so `SEAT` stayed `OfficeSeat | undefined` and only
 * the type-check saw it (the suite itself was green).
 */
function firstDeskSeat(layout: OfficeLayout): OfficeSeat {
  const seat = [...layout.seats.values()].find((one) => one.kind === "desk");
  if (seat === undefined)
    throw new Error("expected a desk seat in the fixture");
  return seat;
}

const SEAT = firstDeskSeat(LAYOUT);

function stateAt(status: OfficeAgentStatus): OfficeDeskState {
  return {
    agentId: "agent-desk",
    name: "agent-desk",
    accentId: null,
    status,
    // `sheeted: true` skips the monitor sprite entirely on both painters, so
    // it stays false - the alpha this file pins is drawn on a desk whose
    // owner is still there, only idle or archived in status.
    sheeted: false,
    openRequests: 0,
    screenFrame: 0,
    harnessId: null,
    modelTier: "medium",
  };
}

/** The seat's own monitor sprite's alpha, off the real painter's output. */
function monitorAlpha(
  painter: OfficePainter,
  status: OfficeAgentStatus,
): number | undefined {
  const drawables = painter.seatProps(LAYOUT, SEAT, stateAt(status), 2);
  const monitor = drawables.find(
    (entry) =>
      entry.drawable.kind === "sprite" &&
      entry.drawable.sprite.name.startsWith("monitor"),
  );
  if (monitor?.drawable.kind !== "sprite") {
    throw new Error(`expected a monitor sprite for status "${status}"`);
  }
  return monitor.drawable.alpha;
}

describe("officeMonitorAlphaFor agrees between floorPainter and MISSION_CONTROL_PAINTER", () => {
  it("dims an idle monitor to OFFICE_IDLE_MONITOR_ALPHA, dims an archived one to OFFICE_ARCHIVED_ALPHA, and leaves a working one undimmed - identically on both views", () => {
    expect(monitorAlpha(floorPainter, "idle")).toBe(OFFICE_IDLE_MONITOR_ALPHA);
    expect(monitorAlpha(MISSION_CONTROL_PAINTER, "idle")).toBe(
      OFFICE_IDLE_MONITOR_ALPHA,
    );

    expect(monitorAlpha(floorPainter, "archived")).toBe(OFFICE_ARCHIVED_ALPHA);
    expect(monitorAlpha(MISSION_CONTROL_PAINTER, "archived")).toBe(
      OFFICE_ARCHIVED_ALPHA,
    );

    // Not vacuous, and the control both dims above need: a working screen is
    // full strength on both, so the dimming above is the status, not a
    // painter that dims everything.
    expect(monitorAlpha(floorPainter, "working")).toBeUndefined();
    expect(monitorAlpha(MISSION_CONTROL_PAINTER, "working")).toBeUndefined();
  });
});
