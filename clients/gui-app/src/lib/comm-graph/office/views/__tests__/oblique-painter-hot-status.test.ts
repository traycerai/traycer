import { describe, expect, it, vi } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import {
  makeTestEpic,
  type OfficeTestEpic,
} from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentStatus,
  OfficeSize,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeDeskState, OfficePlanInput } from "../office-view";
import { BUILDING_VIEW, planBuilding } from "../oblique/oblique-plan";

/**
 * `vi.mock` is hoisted and file-scoped: it would apply to every case sharing
 * this file, not just the one that needs it. This suite exists solely to
 * hold the case that doctors the shared hot/cold classification, so that
 * `oblique-plan.test.ts` and the rest of the office suites keep running
 * against the genuine table. Nothing else should be added here that wants
 * production status semantics.
 */
vi.mock("@/lib/comm-graph/office/office-status", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/comm-graph/office/office-status")
    >();
  return {
    ...actual,
    isOfficeHotStatus: (status: OfficeAgentStatus | undefined) =>
      status === "awaiting" ? false : actual.isOfficeHotStatus(status),
  };
});

const VIEWPORTS: ReadonlyArray<OfficeSize> = [
  { width: 1280, height: 700 },
  { width: 680, height: 440 },
];

function populationFor(epic: OfficeTestEpic): OfficePopulation {
  return partitionOfficePopulation({
    agents: epic.agents,
    statusById: epic.statusById,
    previous: null,
  });
}

function initialInput(
  epic: OfficeTestEpic,
  viewport: OfficeSize,
): OfficePlanInput {
  return {
    agents: epic.agents,
    partition: populationFor(epic),
    occupancy: new Map(),
    needsCapacity: [],
    activityById: new Map(epic.agents.map((agent) => [agent.id, 0])),
    viewport,
    previous: null,
  };
}

function idleDeskState(agentId: string | null): OfficeDeskState {
  return {
    agentId,
    name: agentId,
    accentId: null,
    status: "idle",
    sheeted: false,
    openRequests: 0,
    screenFrame: 0,
    harnessId: null,
    modelTier: "medium",
  };
}

describe("oblique painters: hot-status predicate isolation", () => {
  it("follows the shared hot/cold predicate rather than a private idle/archived check", () => {
    const layout = planBuilding(
      initialInput(makeTestEpic("triage", 309, 1), VIEWPORTS[0]),
    );
    const desk = [...layout.desks.values()].find(
      (candidate) => candidate.kind === "desk",
    );
    if (desk === undefined) throw new Error("expected an occupied desk");
    const painter = BUILDING_VIEW.painter;
    const spriteFor = (modelTier: OfficeDeskState["modelTier"]): string => {
      const state: OfficeDeskState = {
        ...idleDeskState(desk.agentId),
        status: "awaiting",
        modelTier,
      };
      const monitor = painter
        .seatProps(layout, desk, state, 2)
        .find(
          (item) =>
            item.drawable.kind === "sprite" &&
            item.drawable.sprite.name.startsWith("monitor"),
        );
      if (monitor?.drawable.kind !== "sprite")
        throw new Error("expected a monitor sprite");
      return monitor.drawable.sprite.name;
    };
    expect(spriteFor("small")).toBe("monitor-small-off");
    expect(spriteFor("medium")).toBe("monitor-off");
    expect(spriteFor("large")).toBe("monitor-wide-off");
  });
});
