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
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_PADDING_X,
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

/**
 * A plate's width in the face it is ACTUALLY DRAWN IN, derived rather than
 * guessed.
 *
 * jsdom has no text shaping, so the width has to be computed - but it is
 * computed from the same declaration the renderer sets on the context. Every
 * face in `OFFICE_SIGN_MONOSPACE_STACK` advances 0.6em a character, and
 * `ctx.letterSpacing` counts towards `measureText` as well as towards the
 * painted glyphs, so the plate's real advance is 0.68em - 6.8px at
 * `OFFICE_SIGN_FONT_PX`, not the flat 6 an untracked face would give.
 *
 * That thirteen percent is not cosmetic. It is what separates a rung that fits
 * from one that overflows the room it names, and it is why the expectations
 * below are stated as "the rung this many pixels admits" rather than as a
 * character budget. Changing the font size or the tracking moves this number
 * and moves those expectations with it, which is the point of deriving it.
 */
const MONOSPACE_ADVANCE_EM = 0.6;
const CHAR_PX =
  OFFICE_SIGN_FONT_PX * (MONOSPACE_ADVANCE_EM + OFFICE_SIGN_LETTER_SPACING_EM);
const PLATE_PADDING_PX = OFFICE_SIGN_PADDING_X * 2;
function measure(text: string): number {
  return text.length * CHAR_PX + PLATE_PADDING_PX;
}

/** A board's own width on screen at zoom 1: sixteen pixels a tile. */
function boardWidthPx(widthTiles: number): number {
  return widthTiles * OFFICE_TILE;
}

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
      zoom: 1,
      measure,
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
      zoom: 1,
      measure,
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
      available: boardWidthPx(6),
      measure,
    });
    // Only the visible owner is counted: 1 doing, 0 waiting, 0 idle - not the
    // "1D · 0W · 1I" the unfiltered roster would have produced by defaulting
    // the absent future member to idle. Six tiles is ninety-six pixels, which
    // the spelt-out reading does not fit, so this is the abbreviated rung -
    // the counts are what the case is about, not the vocabulary.
    expect(text).toBe("1D · 0W · 0I");
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
      available: boardWidthPx(2),
      measure,
    });
    const hqText = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: new Set(["a", "b", "c", "d", "e"]),
      nameById,
      available: boardWidthPx(2),
      measure,
    });
    expect(hqText).not.toBe(ordinaryEquivalent);
  });
});

describe("officeBoardText - F11 five HQ names, laid out to the board", () => {
  /** The reviewer's own fixture: six agents, ordinary two-word names. */
  const ROSTER = ["a", "b", "c", "d", "e", "f"];
  const STATUS_BY_ID = new Map<string, OfficeAgentStatus>([
    ["a", "attention"],
    ["b", "failure"],
    ["c", "working"],
    ["d", "awaiting"],
    ["e", "background"],
    ["f", "idle"],
  ]);
  const NAME_BY_ID = new Map([
    ["a", "Alpha Build"],
    ["b", "Beta Queue"],
    ["c", "Gamma Store"],
    ["d", "Delta Auth"],
    ["e", "Epsilon Docs"],
    ["f", "Zeta Idle"],
  ]);

  it("names all five hottest agents on an eight-tile board, shortened to fit", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      widthTiles: 8,
    });
    const available = boardWidthPx(8);
    const text = officeBoardText({
      sign,
      statusById: STATUS_BY_ID,
      visibleAgentIds: new Set(ROSTER),
      nameById: NAME_BY_ID,
      available,
      measure,
    });

    // FIVE ENTRIES. The fifth-hottest used to be dropped whole because adding
    // its name overran a character budget; a board that omits an agent has
    // failed at the one thing it is for.
    expect(text.split(" ")).toEqual(["AB", "BQ", "GS", "DA", "ED"]);
    // Zeta Idle is sixth and stays off, which is the ranking working.
    expect(text).not.toContain("ZI");
    // And the chosen rung actually fits the room it names.
    expect(measure(text)).toBeLessThanOrEqual(available);
  });

  it("spells the names out when the board is wide enough for them", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      widthTiles: 48,
    });
    const text = officeBoardText({
      sign,
      statusById: STATUS_BY_ID,
      visibleAgentIds: new Set(ROSTER),
      nameById: NAME_BY_ID,
      available: boardWidthPx(48),
      measure,
    });
    // The ladder is chosen by width, not pinned to its narrowest rung: given
    // the pixels, the board says the names.
    expect(text).toBe(
      "Alpha Build · Beta Queue · Gamma Store · Delta Auth · Epsilon Docs",
    );
  });

  it("steps a six-tile count board down to a rung that fits its ninety-six pixels", () => {
    const sign = boardSign({ agentIds: ROSTER, widthTiles: 6 });
    const available = boardWidthPx(6);
    const text = officeBoardText({
      sign,
      statusById: STATUS_BY_ID,
      visibleAgentIds: new Set(ROSTER),
      nameById: NAME_BY_ID,
      available,
      measure,
    });

    expect(available).toBe(96);
    expect(measure(text)).toBeLessThanOrEqual(available);
    // And it had to step: the spelt-out reading of this same roster is nearly
    // three times the board, which is the overflow the finding measured.
    expect(measure("2 doing · 3 waiting · 1 idle")).toBeGreaterThan(available);
    expect(text).toBe("2D · 3W · 1I");
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
          zoom: 1,
          measure,
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
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(1);
      const counted = board.agentIds.length - 1;
      // The same counts the spelt-out reading would have carried - the hidden
      // member excluded rather than defaulted to idle - said at the rung a
      // six-tile board has the pixels for. What this case is about is WHO was
      // counted; the vocabulary is D55's ladder doing its own job.
      expect(drawn[0].text).toBe(`${counted}D · 0W · 0I`);
      // That rung is the one MEASUREMENT picks, not the one a character budget
      // would have. Six tiles is ninety-six pixels and the spelt-out reading
      // needs well over twice that, so the sentence is not withheld here to
      // keep an expectation green - it genuinely does not fit the room.
      const available = boardWidthPx(6);
      expect(measure(drawn[0].text)).toBeLessThanOrEqual(available);
      expect(measure(`${counted} doing · 0 waiting · 0 idle`)).toBeGreaterThan(
        available,
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
      const full = `${counts.doing} doing · ${counts.waiting} waiting · ${counts.idle} idle · ${counts.archived} archived`;
      const short = `${counts.doing}D · ${counts.waiting}W · ${counts.idle}I · ${counts.archived}A`;
      const compact = `${counts.doing}D ${counts.waiting}W ${counts.idle}I ${counts.archived}A`;
      // A board sized to each rung in turn: just wide enough for that one, and
      // therefore too narrow for the one above it. Derived rather than written
      // down, because the counts come off a REAL roster and a hard-coded width
      // would pin this case to one plan's population.
      const tilesFor = (text: string): number =>
        Math.ceil(measure(text) / OFFICE_TILE);
      const drawn = officeSignsToDraw({
        signs: [
          { ...board, widthTiles: tilesFor(full) },
          { ...board, widthTiles: tilesFor(short) },
          { ...board, widthTiles: tilesFor(compact) },
        ],
        visibleAgentIds,
        statusById: statuses,
        nameById: names,
        hostNameById: new Map(),
        roleClaims: {},
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(3);
      expect(drawn[0].text).toBe(full);
      expect(drawn[1].text).toBe(short);
      expect(drawn[2].text).toBe(compact);
      // Each board took the widest reading ITS pixels admit: the rung it got
      // fits, and the rung above it does not. Without the second half of that
      // pair the three expectations would also pass for a resolver that always
      // returned the narrowest reading it had.
      const widths = [full, short, compact].map((text) =>
        boardWidthPx(tilesFor(text)),
      );
      expect(measure(full)).toBeLessThanOrEqual(widths[0]);
      expect(measure(short)).toBeLessThanOrEqual(widths[1]);
      expect(measure(full)).toBeGreaterThan(widths[1]);
      expect(measure(compact)).toBeLessThanOrEqual(widths[2]);
      expect(measure(short)).toBeGreaterThan(widths[2]);
    });

    it("ranks the five hottest agents on a real HQ board, in the pixels that board actually has", () => {
      const { epic, layout, names, statusById } = realObliqueSigns(viewId);
      const hq = layout.signs.find((sign) => sign.kind === "hq-board");
      if (hq === undefined) throw new Error("expected a real HQ board");
      const hottest = hq.agentIds.slice(0, 5);
      if (hottest.length !== 5) throw new Error("expected five HQ candidates");
      const statuses = new Map(statusById);
      const hqNames = new Map(names);
      for (const agentId of hq.agentIds) statuses.set(agentId, "idle");
      // Coolest first, so the ranking has to REVERSE this to be right: an
      // implementation that kept roster order would read "PR MW ID OH LF"
      // backwards, and one that sorted by id would not produce it at all.
      const heat: ReadonlyArray<OfficeAgentStatus> = [
        "background",
        "awaiting",
        "working",
        "failure",
        "attention",
      ];
      // NAMES OF ORDINARY LENGTH. Two-letter seeds fit at every rung, so they
      // can only show that five things were listed - never that the board
      // chose a reading for the room it had. These are the lengths a real
      // roster carries, and at this board's width they do not fit spelt out.
      const written: ReadonlyArray<string> = [
        "Lena Fischer",
        "Omar Haddad",
        "Ines Duarte",
        "Marcus Webb",
        "Priya Raman",
      ];
      for (let index = 0; index < hottest.length; index += 1) {
        statuses.set(hottest[index], heat[index]);
        hqNames.set(hottest[index], written[index]);
      }
      // The board's OWN width, off the real plan - not a width reverse-derived
      // from the answer, which would make any rung the right one.
      const available = boardWidthPx(hq.widthTiles);
      const drawn = officeSignsToDraw({
        signs: [hq],
        visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
        statusById: statuses,
        nameById: hqNames,
        hostNameById: new Map(),
        roleClaims: {},
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(1);
      // Hottest first, all five, at the only rung this board has the room for.
      expect(drawn[0].text).toBe("PR MW ID OH LF");
      // And it is the WIDEST that fits, not merely one that does: the plate
      // the resolver chose is inside the board, and the rung above it is not.
      expect(measure(drawn[0].text)).toBeLessThanOrEqual(available);
      expect(measure("PR · MW · ID · OH · LF")).toBeGreaterThan(available);
      expect(measure("Priya · Marcus · Ines · Omar · Lena")).toBeGreaterThan(
        available,
      );
      // Every one of the five is still named, and named in descending heat -
      // the point of an HQ board is WHO needs the lead, so shortening may cost
      // letters and must never cost an identity.
      expect(drawn[0].text.split(" ")).toEqual(["PR", "MW", "ID", "OH", "LF"]);
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
      zoom: 1,
      measure,
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
