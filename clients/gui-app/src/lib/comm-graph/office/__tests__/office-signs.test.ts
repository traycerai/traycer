/**
 * Resolver-level coverage for `office-signs.ts` - the sign anchor projection
 * (F5), the LOD-0 sign/host-label gate (F10), and board roster filtering
 * (F11), all without a camera or a canvas in the way. The component's own
 * suite keeps one integration case per finding; these pin the rule itself so
 * a camera-only regression there cannot be mistaken for a projection defect
 * here, and vice versa.
 */
import { describe, expect, it } from "vitest";
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
  type OfficeSign,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

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
