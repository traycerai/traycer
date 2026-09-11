/**
 * Resolver-level coverage for `office-signs.ts` - the sign anchor projection
 * (F5), the LOD-0 sign/host-label gate (F10), and board roster filtering
 * (F11), all without a camera or a canvas in the way. The component's own
 * suite keeps one integration case per finding; these pin the rule itself so
 * a camera-only regression there cannot be mistaken for a projection defect
 * here, and vice versa.
 */
import { describe, expect, it } from "vitest";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import {
  officeBoardText,
  officeFloorSignsToDraw,
  officeSignCenterX,
  officeSignsToDraw,
} from "@/lib/comm-graph/office/office-signs";
import {
  OFFICE_TILE,
  type OfficeAgentStatus,
  type OfficeFloor,
  type OfficeLayout,
  type OfficeSign,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_VIEWS,
  type OfficeProjector,
} from "@/lib/comm-graph/office/views/office-view";

/** A projector that shifts every projected x by +2048px - the review's own F5 recipe. */
const SHIFTED_PROJECTOR: OfficeProjector = {
  project: (col, row) => ({
    x: 2048 + col * OFFICE_TILE,
    y: row * OFFICE_TILE,
  }),
  bounds: { x: 0, y: 0, width: 4096, height: 4096 },
  seatLift: () => 0,
};

function boardSign(
  overrides: Partial<OfficeSign> & { readonly agentIds: ReadonlyArray<string> },
): OfficeSign {
  return {
    kind: "board",
    tile: { col: 2, row: 2 },
    widthTiles: 2,
    text: "",
    ownerAgentId: null,
    hostId: null,
    ...overrides,
  };
}

function emptyFloor(overrides: Partial<OfficeFloor>): OfficeFloor {
  return {
    hostId: null,
    bounds: { col: 0, row: 0, cols: 16, rows: 16 },
    doorTile: { col: 0, row: 0 },
    lobbyTile: { col: 0, row: 1 },
    receptionTile: { col: 0, row: 2 },
    receptionQueueTiles: [],
    queueFacing: "down",
    corridorTiles: [],
    clockTile: { col: 15, row: 0 },
    stairsTile: { col: 4, row: 4 },
    errandSpots: [],
    cafeteria: null,
    gameRoom: null,
    areaSigns: [],
    amenities: [],
    ...overrides,
  };
}

function realObliqueSigns(viewId: "towers" | "building") {
  const epic = makeTestEpic("triage", 309, 1);
  const statusById = new Map(epic.statusById);
  const partition = partitionOfficePopulation({
    agents: epic.agents,
    statusById,
    previous: null,
  });
  const layout = OFFICE_VIEWS[viewId].plan({
    agents: epic.agents,
    partition,
    activityById: new Map(),
    occupancy: new Map(),
    needsCapacity: [],
    viewport: { width: 1040, height: 700 },
    previous: null,
  });
  const names = new Map(
    epic.agents.map((person) => [person.id, `Name ${person.id}`]),
  );
  return { epic, layout, names, statusById };
}

function realBoard(layout: OfficeLayout): OfficeSign {
  const boards = layout.signs.filter((sign) => sign.kind === "board");
  const largest = boards.reduce<OfficeSign | undefined>(
    (current, candidate) =>
      current === undefined ||
      candidate.agentIds.length > current.agentIds.length
        ? candidate
        : current,
    undefined,
  );
  const hq = layout.signs.find((sign) => sign.kind === "hq-board");
  const source =
    largest !== undefined && largest.agentIds.length > 3 ? largest : hq;
  if (source === undefined) throw new Error("expected a real board roster");
  return { ...source, kind: "board", ownerAgentId: null, widthTiles: 6 };
}

describe("officeSignsToDraw - F5 projected anchor", () => {
  it("puts a sign's anchor through the projector, not raw tile math", () => {
    const sign = boardSign({ agentIds: [] });
    const drawn = officeSignsToDraw({
      signs: [sign],
      visibleAgentIds: new Set(),
      statusById: new Map(),
      nameById: new Map(),
      hostNameById: new Map(),
      roleClaims: {},
      projector: SHIFTED_PROJECTOR,
      lod: 1,
    });
    expect(drawn).toHaveLength(1);
    const [resolved] = drawn;
    // Projected tile (2,2): x = 2048 + 2*16 = 2080, y = 2*16 = 32.
    expect(resolved.anchor).toEqual({ x: 2080, y: 32 });
    // Centre of a two-tile board hanging off that anchor: 2080 + 16 = 2096 -
    // the same value the review's own reproduction and the component's
    // integration case (plus its fixed camera) both pin.
    expect(officeSignCenterX(resolved)).toBe(2096);
  });
});

describe("officeSignsToDraw / officeFloorSignsToDraw - F10 LOD-0 gate", () => {
  it("draws no signs at all at LOD 0", () => {
    const sign = boardSign({ agentIds: [] });
    const resolved = officeSignsToDraw({
      signs: [sign],
      visibleAgentIds: new Set(),
      statusById: new Map(),
      nameById: new Map(),
      hostNameById: new Map(),
      roleClaims: {},
      projector: SHIFTED_PROJECTOR,
      lod: 0,
    });
    expect(resolved).toEqual([]);
  });

  it("draws no host/floor labels at LOD 0, even with two host floors", () => {
    const floors = [
      emptyFloor({ hostId: "host-a" }),
      emptyFloor({ hostId: "host-b" }),
    ];
    const hostNameById = new Map([
      ["host-a", "Host A"],
      ["host-b", "Host B"],
    ]);
    const atOverview = officeFloorSignsToDraw({
      floors,
      hostNameById,
      projector: SHIFTED_PROJECTOR,
      lod: 0,
    });
    expect(atOverview).toEqual([]);

    // Control: the same two floors at LOD 1 DO produce a label each, so the
    // LOD-0 case above is a real gate and not an empty-input coincidence.
    const atOffice = officeFloorSignsToDraw({
      floors,
      hostNameById,
      projector: SHIFTED_PROJECTOR,
      lod: 1,
    });
    expect(atOffice).toHaveLength(2);
  });
});

describe("officeBoardText - F11 roster filtering and width", () => {
  it("excludes a roster member that does not exist yet at the cursor, rather than counting it idle", () => {
    const sign = boardSign({
      agentIds: ["visible-owner", "future-member"],
      widthTiles: 6,
    });
    const statusById = new Map<string, OfficeAgentStatus>([
      ["visible-owner", "working"],
    ]);
    const text = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: new Set(["visible-owner"]),
      nameById: new Map(),
    });
    // Only the visible owner is counted: 1 doing, 0 waiting, 0 idle - not the
    // "1 doing, 0 waiting, 1 idle" the unfiltered roster would have produced
    // by defaulting the absent future member to idle.
    expect(text).toBe("1 doing · 0 waiting · 0 idle");
  });

  it("gives an HQ board a names ranking instead of the doing/waiting/idle counts", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ["a", "b", "c", "d", "e"],
      widthTiles: 2,
    });
    const statusById = new Map<string, OfficeAgentStatus>([
      ["a", "attention"],
      ["b", "working"],
      ["c", "idle"],
      ["d", "idle"],
      ["e", "idle"],
    ]);
    const nameById = new Map([
      ["a", "Alpha"],
      ["b", "Beta"],
      ["c", "Gamma"],
      ["d", "Delta"],
      ["e", "Epsilon"],
    ]);
    const ordinaryEquivalent = officeBoardText({
      sign: { ...sign, kind: "board" },
      statusById,
      visibleAgentIds: new Set(["a", "b", "c", "d", "e"]),
      nameById,
    });
    const hqText = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: new Set(["a", "b", "c", "d", "e"]),
      nameById,
    });
    expect(hqText).not.toBe(ordinaryEquivalent);
  });
});

for (const viewId of ["towers", "building"] as const) {
  describe(`${viewId} real board resolver regressions`, () => {
    it("draws no real sign text at overview lod", () => {
      const { epic, layout, names, statusById } = realObliqueSigns(viewId);
      expect(
        officeSignsToDraw({
          signs: layout.signs,
          visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
          statusById,
          nameById: names,
          hostNameById: new Map(),
          roleClaims: {},
          projector: OFFICE_VIEWS[viewId].painter.projector(layout),
          lod: 0,
        }),
      ).toEqual([]);
    });

    it("filters a real board roster at the cursor", () => {
      const { epic, layout, names, statusById } = realObliqueSigns(viewId);
      const board = realBoard(layout);
      const hidden = board.agentIds.at(-1);
      if (hidden === undefined) throw new Error("expected a board roster");
      const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
      visibleAgentIds.delete(hidden);
      const statuses = new Map(statusById);
      for (const agentId of board.agentIds) statuses.set(agentId, "working");
      statuses.set(hidden, "idle");
      const drawn = officeSignsToDraw({
        signs: [{ ...board, widthTiles: 6 }],
        visibleAgentIds,
        statusById: statuses,
        nameById: names,
        hostNameById: new Map(),
        roleClaims: {},
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(1);
      expect(drawn[0].text).toBe(
        `${board.agentIds.length - 1} doing · 0 waiting · 0 idle`,
      );
    });

    it("uses the width ladder for a real board instead of truncating its summary", () => {
      const { epic, layout, names, statusById } = realObliqueSigns(viewId);
      const board = realBoard(layout);
      const statuses = new Map(statusById);
      const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
      const roster = board.agentIds;
      const statusCycle: ReadonlyArray<OfficeAgentStatus> = [
        "working",
        "attention",
        "idle",
        "archived",
      ];
      for (let index = 0; index < roster.length; index += 1) {
        const agentId = roster[index];
        statuses.set(agentId, statusCycle[index % statusCycle.length]);
      }
      const counts = { doing: 0, waiting: 0, idle: 0, archived: 0 };
      for (const agentId of roster) {
        const status = statuses.get(agentId) ?? "idle";
        if (status === "working" || status === "background") counts.doing += 1;
        else if (status === "archived") counts.archived += 1;
        else if (status === "idle") counts.idle += 1;
        else counts.waiting += 1;
      }
      const drawn = officeSignsToDraw({
        signs: [
          { ...board, widthTiles: 6 },
          { ...board, widthTiles: 3 },
          { ...board, widthTiles: 1 },
        ],
        visibleAgentIds,
        statusById: statuses,
        nameById: names,
        hostNameById: new Map(),
        roleClaims: {},
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(3);
      expect(drawn[0].text).toBe(
        `${counts.doing} doing · ${counts.waiting} waiting · ${counts.idle} idle · ${counts.archived} archived`,
      );
      expect(drawn[1].text).toBe(
        `${counts.doing}D · ${counts.waiting}W · ${counts.idle}I · ${counts.archived}A`,
      );
      expect(drawn[2].text).toBe(
        `${counts.doing}D ${counts.waiting}W ${counts.idle}I ${counts.archived}A`,
      );
    });

    it("ranks the five hottest agents on a real HQ board", () => {
      const { epic, layout, names, statusById } = realObliqueSigns(viewId);
      const hq = layout.signs.find((sign) => sign.kind === "hq-board");
      if (hq === undefined) throw new Error("expected a real HQ board");
      const hottest = hq.agentIds.slice(0, 5);
      if (hottest.length !== 5) throw new Error("expected five HQ candidates");
      const statuses = new Map(statusById);
      const hqNames = new Map(names);
      for (const agentId of hq.agentIds) statuses.set(agentId, "idle");
      const heat: ReadonlyArray<OfficeAgentStatus> = [
        "background",
        "awaiting",
        "working",
        "failure",
        "attention",
      ];
      for (let index = 0; index < hottest.length; index += 1) {
        statuses.set(hottest[index], heat[index]);
        hqNames.set(hottest[index], `H${index}`);
      }
      const drawn = officeSignsToDraw({
        signs: [hq],
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: statuses,
        nameById: hqNames,
        hostNameById: new Map(),
        roleClaims: {},
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(1);
      expect(drawn[0].text).toBe("H4 · H3 · H2 · H1 · H0");
    });
  });
}

for (const viewId of ["towers", "building"] as const) {
  it(`${viewId} preserves ownerless aggregate text through the real resolver`, () => {
    const { epic, layout, names, statusById } = realObliqueSigns(viewId);
    const aggregate = layout.signs.filter(
      (sign) => sign.text === "Solo desks" || sign.text.startsWith("Bullpen ·"),
    );
    expect(aggregate.length).toBeGreaterThan(0);
    const owner = layout.signs.find(
      (sign) => sign.kind === "plate" && sign.ownerAgentId !== null,
    );
    if (owner === undefined || owner.ownerAgentId === null) {
      throw new Error("expected an owned real plate");
    }
    const renamed = new Map(names).set(owner.ownerAgentId, "Renamed owner");
    const drawn = officeSignsToDraw({
      signs: [...aggregate, owner],
      visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      statusById,
      nameById: renamed,
      hostNameById: new Map(),
      roleClaims: {},
      projector: OFFICE_VIEWS[viewId].painter.projector(layout),
      lod: 1,
    });
    expect(drawn).toHaveLength(aggregate.length + 1);
    for (const sign of aggregate) {
      const resolved = drawn.find((entry) => entry.sign === sign);
      if (resolved === undefined) throw new Error("expected aggregate sign");
      expect(resolved.text).toBe(sign.text);
      expect(resolved.sign.ownerAgentId).toBeNull();
    }
    const resolvedOwner = drawn.find((entry) => entry.sign === owner);
    if (resolvedOwner === undefined) throw new Error("expected owned plate");
    expect(resolvedOwner.text).toBe("Renamed owner");
  });
}
