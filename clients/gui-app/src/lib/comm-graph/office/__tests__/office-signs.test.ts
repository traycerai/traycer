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
  compareHeat,
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_PADDING_X,
  OFFICE_SIGN_PLATE_MAX_CHARS,
  nameTagTextThatFits,
  officeBoardText,
  officeBoardWidthPx,
  officeFloorSignsToDraw,
  officePlateWidthPx,
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

/**
 * FIXUP 7's OWN INVARIANT, shared between the sweep (below) and the real
 * 309 Building case: the HQ board's ladder no longer has a rung of
 * manufactured initials, because the third `nameRungs` element it used to
 * letter with is gone. The ticket wrote down two regexes for this and both
 * are approximations - narrowed here to what the ladder is actually allowed
 * to produce:
 *
 * - `\w` matches digits as well as letters, so the ticket's
 *   `/^(\w( |$))+$/` also matches the legitimate bare-total rung ("5",
 *   "309"). Narrowed to `[A-Za-z]` so a digit can never trip it.
 * - `/^\w{2,5}$/` likewise matches "309". Narrowed to `[A-Za-z]{2,5}`.
 * - Neither regex catches the removed ` · `-joined shape ("R · T · L"), so
 *   that gets its own check: every ` · `-separated part is a single letter.
 * - "No isolated single letters" cannot be taken literally either - the
 *   required COUNTS rung IS "2D · 3W · 0I", whose D/W/I are isolated
 *   letters that must stay legal. The honest rule is narrower: a letter may
 *   stand alone only when a digit is attached to it. `ISOLATED_LETTER`
 *   encodes exactly that - a letter neither preceded by a digit nor part of
 *   a longer letter-run trips it.
 */
const ALL_SINGLE_LETTERS_SPACED = /^([A-Za-z]( |$))+$/;
const ALL_SINGLE_LETTERS_RUN = /^[A-Za-z]{2,5}$/;
const ISOLATED_LETTER = /(?:^|[^0-9A-Za-z])[A-Za-z](?![A-Za-z])/;

function isAllDotSeparatedSingleLetters(text: string): boolean {
  const parts = text.split(" · ");
  return parts.length > 1 && parts.every((part) => /^[A-Za-z]$/.test(part));
}

/**
 * `null` when `text` is not a manufactured-initials shape; a message quoting
 * `text` and naming which shape it took otherwise. Returning the message
 * rather than a bare boolean is the point: `expect(x).toBe(false)` prints
 * only "expected true to be false", which names neither the width that broke
 * nor the string the board actually produced, while `expect(offense).toBeNull()`
 * prints the message - the offending text and the rule it broke - straight
 * into the failure.
 */
function manufacturedInitialsOffense(text: string): string | null {
  if (ALL_SINGLE_LETTERS_SPACED.test(text)) {
    return `"${text}" is single letters separated by spaces`;
  }
  if (ALL_SINGLE_LETTERS_RUN.test(text)) {
    return `"${text}" is single letters run together`;
  }
  if (isAllDotSeparatedSingleLetters(text)) {
    return `"${text}" is single letters separated by " · "`;
  }
  if (ISOLATED_LETTER.test(text)) {
    return `"${text}" has a letter standing alone with no digit attached`;
  }
  return null;
}

/** A run of letters this long is a name, never an abbreviation. */
const NAME_LETTER_RUN = /[A-Za-z]{3,}/;

/**
 * THE POSITIVE INVARIANT, as an offender message rather than a boolean for
 * the same reason as `manufacturedInitialsOffense` above: every rung the new
 * ladder can produce either spells a name (a letter-run of three or more
 * characters), or says a number (a digit, from the counts or the bare-total
 * tail), or is the overflow glyph or the empty string the tail always ends
 * on. `null` when `text` satisfies that; a message quoting `text` otherwise.
 */
function unacceptableBoardRungReason(text: string): string | null {
  if (
    text === "" ||
    text === "…" ||
    NAME_LETTER_RUN.test(text) ||
    /\d/.test(text)
  ) {
    return null;
  }
  return `"${text}" is neither a name, a number, the overflow glyph, nor empty`;
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

  it("fixup 7: agrees with an ordinary board's counts at the board's own eight tiles, and only differs once a name rung fits", () => {
    // EIGHT TILES, the width a real HQ board has. `nameRungs` no longer has
    // an initials rung to fall to, so these one-word names give the SAME two
    // name rungs twice over - "Alpha · Beta · Gamma · Delta · Epsilon"
    // (38 chars, 266.4px) as both written and first names - and neither fits
    // 128px. The ladder falls straight to the roster's counts, which is
    // exactly what an ordinary `board` over the same roster would say: this
    // is the fixup's own point, not a coincidence.
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ["a", "b", "c", "d", "e"],
      widthTiles: 8,
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
    const visibleAgentIds = new Set(["a", "b", "c", "d", "e"]);
    const writtenNamesJoined = "Alpha · Beta · Gamma · Delta · Epsilon";

    const ordinaryAtEight = officeBoardText({
      sign: { ...sign, kind: "board" },
      statusById,
      visibleAgentIds,
      nameById,
      available: boardWidthPx(8),
      measure,
    });
    const hqAtEight = officeBoardText({
      sign,
      statusById,
      visibleAgentIds,
      nameById,
      available: boardWidthPx(8),
      measure,
    });
    expect(hqAtEight).toBe("1D · 1W · 3I");
    expect(hqAtEight).toBe(ordinaryAtEight);
    expect(measure(writtenNamesJoined)).toBeGreaterThan(boardWidthPx(8));

    // GIVEN THE PIXELS FOR NAMES the two boards diverge again: the written
    // names' own rung fits at seventeen tiles (272px against its 266.4px;
    // sixteen tiles' 256px does not), and only the HQ board uses it - an
    // ordinary `board` never letters names at any width.
    const wideTiles = Math.ceil(measure(writtenNamesJoined) / OFFICE_TILE);
    const ordinaryAtWide = officeBoardText({
      sign: { ...sign, kind: "board", widthTiles: wideTiles },
      statusById,
      visibleAgentIds,
      nameById,
      available: boardWidthPx(wideTiles),
      measure,
    });
    const hqAtWide = officeBoardText({
      sign: { ...sign, widthTiles: wideTiles },
      statusById,
      visibleAgentIds,
      nameById,
      available: boardWidthPx(wideTiles),
      measure,
    });
    expect(hqAtWide).toBe(writtenNamesJoined);
    expect(ordinaryAtWide).not.toBe(hqAtWide);
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

  it("fixup 7: names all five hottest agents once the first-names rung fits, never dropping the fifth", () => {
    // EIGHT TILES no longer letters these five names - the ladder falls to
    // the roster's counts there instead (see the "agrees ... at the board's
    // own eight tiles" case above). This pins the other half of the fixup's
    // promise: at a width wide enough for the FIRST-NAMES rung, all five are
    // still named, never four-plus-a-drop.
    const firstNamesJoined = "Alpha · Beta · Gamma · Delta · Epsilon";
    const wideTiles = Math.ceil(measure(firstNamesJoined) / OFFICE_TILE);
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      widthTiles: wideTiles,
    });
    const available = boardWidthPx(wideTiles);
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
    expect(text).toBe(firstNamesJoined);
    // Zeta Idle is sixth and stays off, which is the ranking working.
    expect(text).not.toContain("Zeta");
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

    it("fixup 7: counts a real HQ board at its own pixels, and ranks the five hottest by name once a name rung fits", () => {
      const { epic, layout, names, statusById } = realObliqueSigns(viewId);
      const hq = layout.signs.find((sign) => sign.kind === "hq-board");
      if (hq === undefined) throw new Error("expected a real HQ board");
      const hottest = hq.agentIds.slice(0, 5);
      if (hottest.length !== 5) throw new Error("expected five HQ candidates");
      const statuses = new Map(statusById);
      const hqNames = new Map(names);
      for (const agentId of hq.agentIds) statuses.set(agentId, "idle");
      // Coolest first, so the ranking has to REVERSE this to be right: an
      // implementation that kept roster order would read the names
      // backwards, and one that sorted by id would not produce this order at
      // all.
      const heat: ReadonlyArray<OfficeAgentStatus> = [
        "background",
        "awaiting",
        "working",
        "failure",
        "attention",
      ];
      // NAMES OF ORDINARY LENGTH - the lengths a real roster carries, and at
      // this board's own width they do not fit as first names, let alone
      // written out.
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
      const visibleAgentIds = new Set(epic.agents.map((person) => person.id));
      // THE BOARD'S OWN WIDTH, off the real plan - not a width reverse-derived
      // from the answer, which would make any rung the right one. Neither
      // name rung fits it, so the ladder falls to the roster's counts rather
      // than lettering initials - "PR MW ID OH LF" was the removed initials
      // rung this case used to pin.
      const available = boardWidthPx(hq.widthTiles);
      const drawnAtOwnWidth = officeSignsToDraw({
        signs: [hq],
        visibleAgentIds,
        statusById: statuses,
        nameById: hqNames,
        hostNameById: new Map(),
        roleClaims: {},
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawnAtOwnWidth).toHaveLength(1);
      expect(drawnAtOwnWidth[0].text).toMatch(/\d/);
      expect(manufacturedInitialsOffense(drawnAtOwnWidth[0].text)).toBeNull();
      expect(measure(drawnAtOwnWidth[0].text)).toBeLessThanOrEqual(available);
      const firstNamesJoined = "Priya · Marcus · Ines · Omar · Lena";
      expect(measure(firstNamesJoined)).toBeGreaterThan(available);

      // GIVEN THE PIXELS FOR FIRST NAMES the same roster still ranks hottest
      // first and keeps all five identities - the point of an HQ board.
      const wideTiles = Math.ceil(measure(firstNamesJoined) / OFFICE_TILE);
      const drawnWide = officeSignsToDraw({
        signs: [{ ...hq, widthTiles: wideTiles }],
        visibleAgentIds,
        statusById: statuses,
        nameById: hqNames,
        hostNameById: new Map(),
        roleClaims: {},
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawnWide).toHaveLength(1);
      expect(drawnWide[0].text).toBe(firstNamesJoined);
    });
  });
}

for (const viewId of ["towers", "building"] as const) {
  it(`${viewId} preserves ownerless aggregate text through the real resolver, and re-letters an owned plate from its CURRENT name`, () => {
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
    // OWNERLESS PLATES ARE NEVER RE-LETTERED FROM AN OWNER. `ownerAgentId` is
    // `null` on every aggregate sign, so the resolver has nothing to look
    // "Renamed owner" up by - each still comes down ITS OWN ladder (rule 3).
    // Towers' solo plates at this population are wide enough to hold "Solo
    // desks" whole at every rung; Building's bullpen plates are rule 3's own
    // reproduction - narrower than the plan's " live solos" wording but wide
    // enough for the count, which the ladder drops last rather than first.
    for (const sign of aggregate) {
      const resolved = drawn.find((entry) => entry.sign === sign);
      if (resolved === undefined) throw new Error("expected aggregate sign");
      expect(resolved.sign.ownerAgentId).toBeNull();
      if (viewId === "towers") {
        expect(resolved.text).toBe("Solo desks");
      } else {
        expect(sign.text.startsWith("Bullpen · ")).toBe(true);
        expect(sign.text.endsWith(" live solos")).toBe(true);
        expect(resolved.text).toBe(sign.text.replace(" live solos", ""));
      }
    }
    // AN OWNED PLATE IS RE-LETTERED FROM THE CURRENT NAME, NOT THE PLAN'S: the
    // sign was written at plan time from whoever led that room then, and the
    // resolver derives its ladder from `nameById` at the CURSOR instead
    // (`plateRungsFor`'s `"name"` case). This plate is two tiles wide, so the
    // ladder has nowhere to go but initials - "Ro" are "Renamed owner"'s,
    // which only the LIVE name can have produced: the plan's own text here
    // (`owner.text`, asserted below to differ) never contained an "o" in that
    // position for the ladder to have found by accident.
    const resolvedOwner = drawn.find((entry) => entry.sign === owner);
    if (resolvedOwner === undefined) throw new Error("expected owned plate");
    expect(owner.widthTiles).toBe(2);
    expect(owner.text).not.toBe("Renamed owner");
    expect(resolvedOwner.text).toBe("Ro");
  });
}

describe("officeBoardText - fixup 3 F11 the ladder never overflows its board", () => {
  const FIVE = ["a", "b", "c", "d", "e"];
  const visible = new Set(FIVE);

  /**
   * The reviewer's first reproduction: five SINGLE-WORD names on the eight-tile
   * board a real HQ has. The old ladder held every one-word name whole at all
   * three rungs, so the separators were the only width it could give back, and
   * the widest reading was also the narrowest: 212.61px against 128.
   */
  it("fixup 7: counts rather than lettering initials when five single-word names don't fit an eight-tile board", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: FIVE,
      widthTiles: 8,
    });
    const statusById = new Map<string, OfficeAgentStatus>([
      ["a", "attention"],
      ["b", "failure"],
      ["c", "working"],
      ["d", "awaiting"],
      ["e", "background"],
    ]);
    const nameById = new Map([
      ["a", "Alpha"],
      ["b", "Beta"],
      ["c", "Gamma"],
      ["d", "Delta"],
      ["e", "Epsilon"],
    ]);
    const available = boardWidthPx(8);
    const text = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: visible,
      nameById,
      available,
      measure,
    });
    // Both name rungs are the SAME string for one-word names - "Alpha · Beta
    // · Gamma · Delta · Epsilon", 266.4px against these 128 - so neither
    // fits and the ladder falls straight to the roster's counts: doing (c,
    // e), waiting (a, b, d), none idle. The removed third rung this case
    // used to pin, "A · B · G · D · E", is gone.
    expect(text).toBe("2D · 3W · 0I");
    expect(measure(text)).toBeLessThanOrEqual(available);
    expect(measure("Alpha · Beta · Gamma · Delta · Epsilon")).toBeGreaterThan(
      available,
    );
  });

  /**
   * The reviewer's other two: zoom 0.7, the included lower boundary of lod 1,
   * where every rung the ladder had ran wider than the board.
   */
  it("steps a six-tile count board below its last rung at the 0.7 zoom boundary", () => {
    const sign = boardSign({
      kind: "board",
      agentIds: ["a", "b", "c", "d"],
      widthTiles: 6,
    });
    const statusById = new Map<string, OfficeAgentStatus>([
      ["a", "working"],
      ["b", "attention"],
      ["c", "idle"],
      ["d", "archived"],
    ]);
    const available = boardWidthPx(6) * 0.7;
    const text = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: new Set(["a", "b", "c", "d"]),
      nameById: new Map(),
      available,
      measure,
    });
    // Separator-free, and every one of the four numbers still said: a letter
    // after each count is what lets the separators go without ambiguity.
    expect(text).toBe("1D1W1I1A");
    expect(measure(text)).toBeLessThanOrEqual(available);
    // What the old last rung was, and that it did not fit these 67.2px.
    expect(measure("1D 1W 1I 1A")).toBeGreaterThan(available);
  });

  it("fixup 7: steps a five-name HQ board to its counts rung at the 0.7 zoom boundary", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: FIVE,
      widthTiles: 8,
    });
    const statusById = new Map<string, OfficeAgentStatus>([
      ["a", "attention"],
      ["b", "failure"],
      ["c", "working"],
      ["d", "awaiting"],
      ["e", "background"],
    ]);
    const nameById = new Map([
      ["a", "Priya Raman"],
      ["b", "Marcus Webb"],
      ["c", "Ines Duarte"],
      ["d", "Omar Haddad"],
      ["e", "Lena Fischer"],
    ]);
    const available = boardWidthPx(8) * 0.7;
    const text = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: visible,
      nameById,
      available,
      measure,
    });
    // Neither name rung fits at these 89.6px - the first-names rung alone,
    // "Priya · Marcus · Ines · Omar · Lena", measures well over twice that -
    // so the ladder falls to the roster's counts: doing (c, e), waiting (a,
    // b, d), none idle. The old last rung here, "PRMWIDOHLF" (ten initials
    // run together), is gone along with the rung it came from.
    expect(text).toBe("2D · 3W · 0I");
    expect(measure(text)).toBeLessThanOrEqual(available);
    expect(measure("Priya · Marcus · Ines · Omar · Lena")).toBeGreaterThan(
      available,
    );
  });

  /**
   * The guarantee itself, at the worst case a real office can present: the
   * narrowest board any plan emits, at the lowest zoom lod 1 includes.
   */
  it("fits the narrowest board at the lowest zoom, whatever the roster", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: FIVE,
      widthTiles: 2,
    });
    const statusById = new Map<string, OfficeAgentStatus>(
      FIVE.map((id) => [id, "working"] as const),
    );
    const nameById = new Map(
      FIVE.map((id) => [id, "Bartholomew Fitzwilliam"] as const),
    );
    const available = boardWidthPx(2) * 0.7;
    const text = officeBoardText({
      sign,
      statusById,
      visibleAgentIds: visible,
      nameById,
      available,
      measure,
    });
    // Two tiles at 0.7 is 22.4px, which holds one character and its padding.
    // Nothing about these five names can be said in it, and the board says so
    // rather than painting over the room next door.
    expect(measure(text)).toBeLessThanOrEqual(available);
    expect(text.length).toBeLessThanOrEqual(2);
  });
});

/**
 * Fixup 7 (finding L2): the HQ board used to letter its way down PAST the
 * first-names rung into manufactured initials - " · "-joined, then spaced,
 * then run together - and a real HQ board is eight tiles, which at office
 * zoom (0.92x) is well under the first-names rung's own width for any real
 * roster. The live sitting read `R R R R R` / `T T T T L` off the top
 * storey, which names nobody and reads as a rendering fault. The fix drops
 * that rung entirely: below first names the ladder falls to the roster's
 * COUNTS, `boardRenderings(countRoster(roster, statusById))` - the same
 * reading, over the same roster, that an ordinary `board` already gives.
 */
describe("officeBoardText - fixup 7: the HQ board never letters manufactured initials", () => {
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
  const visible = new Set(ROSTER);

  /**
   * THE SWEEP. `hqBoardText`'s ladder used to hand a too-narrow board four
   * rungs in a row that name nobody - " · "-joined initials, spaced
   * initials, run-together initials - between the first-names rung and the
   * bare total. Those rungs are gone: the ladder is now written names, first
   * names, then straight to the roster's counts. Sweeping every width from
   * the written names' own pixels down to nothing crosses every width the
   * old ladder used to answer with initials (roughly 90px-260px for this
   * five-name fixture), and none of the strings this ladder returns may take
   * that shape.
   */
  it("never emits a manufactured-initials rung, at any width from the written names down to zero", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      widthTiles: 8,
    });
    // The top five by heat (a-e; f is sixth and stays off), written out in
    // full and " · "-joined - the widest rung the ladder has.
    const writtenNamesJoined =
      "Alpha Build · Beta Queue · Gamma Store · Delta Auth · Epsilon Docs";
    const widestPx = measure(writtenNamesJoined);
    const seen = new Set<string>();
    // COLLECTED RATHER THAN ASSERTED IN THE LOOP, the way this directory's
    // `office-board-fit.test.ts` collects its overflow offenders: a bare
    // `expect(...).toBe(false)` inside a sweep prints "expected true to be
    // false" and names neither the width that broke nor what the board said
    // there, which leaves the next reader to re-derive the whole sweep by
    // hand. Each offender carries its own width and reading instead.
    const offenders: string[] = [];
    for (let available = widestPx; available >= 0; available -= 4) {
      const text = officeBoardText({
        sign,
        statusById: STATUS_BY_ID,
        visibleAgentIds: visible,
        nameById: NAME_BY_ID,
        available,
        measure,
      });
      seen.add(text);
      const reason =
        manufacturedInitialsOffense(text) ?? unacceptableBoardRungReason(text);
      if (reason !== null)
        offenders.push(`at ${available}px available: ${reason}`);
    }
    expect(offenders).toEqual([]);
    // THE SWEEP WAS NOT VACUOUS: it actually crossed a rung change, and both
    // a name rung and a counts rung appeared among what it saw.
    expect(seen.size).toBeGreaterThan(1);
    expect([...seen].some((text) => NAME_LETTER_RUN.test(text))).toBe(true);
    expect([...seen].some((text) => /\d/.test(text))).toBe(true);
  });

  /**
   * The real 309 Building plan, at Office zoom - the exact shape the live
   * sitting found the finding in. `realObliqueSigns` names every agent
   * `Name <id>`, so the first-names rung is five copies of the literal word
   * "Name"; even that measures wider than the board's own pixels at 0.92,
   * so the fall to counts here is not an artifact of unusually long names.
   */
  it("never letters initials on the real 309 Building's HQ board at Office zoom, and its first-names rung genuinely doesn't fit", () => {
    const { epic, layout, names, statusById } = realObliqueSigns("building");
    const hq = layout.signs.find((sign) => sign.kind === "hq-board");
    if (hq === undefined) throw new Error("expected a real HQ board");
    const drawn = officeSignsToDraw({
      signs: [hq],
      visibleAgentIds: new Set(epic.agents.map((person) => person.id)),
      statusById,
      nameById: names,
      hostNameById: new Map(),
      roleClaims: {},
      projector: OFFICE_VIEWS.building.painter.projector(layout),
      lod: 1,
      zoom: 0.92,
      measure,
    });
    expect(drawn).toHaveLength(1);
    const text = drawn[0].text;
    // A digit: the counts rung this width falls to, over a real 309-agent
    // roster. Asserted with `toMatch` rather than on a boolean so a failure
    // prints the reading the board actually drew at Office zoom.
    expect(text).toMatch(/\d/);
    expect(manufacturedInitialsOffense(text)).toBeNull();

    // IT HAD TO STEP, not merely landed on a rung that happens to have a
    // digit in it.
    const firstNamesJoined = "Name · Name · Name · Name · Name";
    const available = officeBoardWidthPx(hq, 0.92);
    expect(measure(firstNamesJoined)).toBeGreaterThan(available);
  });

  /**
   * Rule 1 says the counts are over the board's WHOLE cursor-filtered
   * roster, not over the five-or-fewer named agents - "the same ids an
   * ordinary `board` counts". Every other case in this file happens to use a
   * roster where all five hottest are also all the agents on the board, so
   * roster and named coincide and an implementation that counted only the
   * five names would still pass them. This fixture's sixth agent, "f", is
   * what tells the two apart: idle, sixth-hottest, never named on this
   * board - but still ON it.
   */
  it("counts the whole roster, not just the five agents it names", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      widthTiles: 8,
    });
    const available = boardWidthPx(8);
    const text = officeBoardText({
      sign,
      statusById: STATUS_BY_ID,
      visibleAgentIds: visible,
      nameById: NAME_BY_ID,
      available,
      measure,
    });
    // Written names (456.8px) and first names (266.4px) both overflow these
    // 128px, so the ladder falls to counts. Counting only the five named
    // agents (a-e) would give "2D · 3W · 0I" - "f"'s idle status never
    // counted. Counting the whole roster (a-f), the rule this case pins,
    // gives "2D · 3W · 1I" instead: doing (c, e), waiting (a, b, d), idle
    // (f).
    expect(text).toBe("2D · 3W · 1I");
    expect(measure(text)).toBeLessThanOrEqual(available);
  });

  /**
   * The same distinction at the ladder's own tail. The removed rung used to
   * end `lastResortRungs(named.length)` - always the number of NAMES, "5"
   * here whatever the roster held. `boardRenderings`'s own tail counts the
   * roster `hqBoardText` counts with instead - six, not five - because a
   * rung whose whole job is "how many are on this board" must not undercount
   * the one member it never got a chance to name.
   */
  it("the bare-total tail says the roster's total, not the number of names", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      widthTiles: 8,
    });
    // Narrow enough that only the bare total fits - the run-together counts
    // rung "2D3W1I" measures 48.8px and a lone digit measures 14.8px, so
    // 20px sits between the two.
    const available = 20;
    const text = officeBoardText({
      sign,
      statusById: STATUS_BY_ID,
      visibleAgentIds: visible,
      nameById: NAME_BY_ID,
      available,
      measure,
    });
    expect(text).toBe("6");
    expect(measure(text)).toBeLessThanOrEqual(available);
    expect(measure("2D3W1I")).toBeGreaterThan(available);
  });
});

/**
 * CR2: `hqBoardText` used to slice the top five BY HEAT first, then drop any
 * of the five missing from `nameById` - so an unnamed agent inside the top
 * five cost the board a name rather than handing its slot to the next
 * hottest agent who actually has one. The doc comment at `hqBoardText`
 * ("All five are listed whatever the width") is the spec; this is what holds
 * the code to it.
 */
describe("officeBoardText - CR2 an unnamed agent in the top five does not cost the board a name", () => {
  /**
   * Six agents, each a DISTINCT heat so the ranking cannot be mistaken for an
   * id tie-break: attention through idle, one status apart, in roster order.
   * "c" sits third-hottest - inside the top five - and is missing from
   * `nameById` on purpose; "f" is sixth-hottest and named, so it is the one
   * promotion has to find.
   */
  const ROSTER = ["a", "b", "c", "d", "e", "f"];
  const STATUS_BY_ID = new Map<string, OfficeAgentStatus>([
    ["a", "attention"],
    ["b", "failure"],
    ["c", "working"],
    ["d", "awaiting"],
    ["e", "background"],
    ["f", "idle"],
  ]);
  /** "c" has no entry - the unnamed agent inside the top five. */
  const NAME_BY_ID = new Map([
    ["a", "Alpha One"],
    ["b", "Beta Two"],
    ["d", "Delta Four"],
    ["e", "Epsilon Five"],
    ["f", "Zeta Six"],
  ]);

  it("promotes the sixth-hottest NAMED agent into the slot the unnamed fifth leaves open", () => {
    const sign = boardSign({
      kind: "hq-board",
      agentIds: ROSTER,
      // Wide enough that the ladder spells every name out - this case is
      // about WHICH five are chosen, not how far they get abbreviated.
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

    // FIVE NAMES. Today the board stops at four - "c" cost the board its own
    // slot instead of handing it to "f" - which is exactly the defect this
    // case exists to catch.
    expect(text.split(" · ")).toHaveLength(5);
    // The promoted agent is actually among them, not merely a count that
    // happens to reach five some other way.
    expect(text).toContain("Zeta Six");
  });
});

describe("compareHeat - the comparator contract", () => {
  const statusById = new Map<string, OfficeAgentStatus>([
    ["a", "attention"],
    ["b", "idle"],
  ]);

  /**
   * An id against itself. The sort at the HQ board's heart is entitled to act
   * on whatever this answers, so answering 1 here makes the order of a roster
   * carrying a duplicate implementation-defined - and that is a property of
   * the engine's sort, not of the office, so the rule is stated here rather
   * than through a board whose text cannot show it either way.
   */
  it("answers zero for an id compared with itself", () => {
    expect(compareHeat("a", "a", statusById)).toBe(0);
    expect(compareHeat("b", "b", statusById)).toBe(0);
  });

  it("still orders hotter first and breaks remaining ties by id", () => {
    // "a" is attention, "b" is idle: heat decides, whichever way round it is
    // asked, and the two answers are opposite rather than both positive.
    expect(compareHeat("a", "b", statusById)).toBeLessThan(0);
    expect(compareHeat("b", "a", statusById)).toBeGreaterThan(0);
    // Equal heat, different ids: the id decides, and still antisymmetrically.
    const tied = new Map<string, OfficeAgentStatus>([
      ["x", "idle"],
      ["y", "idle"],
    ]);
    expect(compareHeat("x", "y", tied)).toBeLessThan(0);
    expect(compareHeat("y", "x", tied)).toBeGreaterThan(0);
  });
});

/**
 * Fixup 6, rule 1 (finding M2): `officeFloorSignsToDraw` used to gate on
 * `floors.length <= 1`, so a host holding several floors got a label on
 * EVERY ONE of them - `host-a` x9 and `host-b` x10 down the two towers,
 * `Unattributed` x21 down the thousand-agent Building. The plan already
 * paints the name once, across the building's own `host` sign at its foot;
 * the fix is grouping by HOST rather than counting floors, so a stack gets
 * no per-storey label at all and only a host that holds exactly one floor
 * (every host on Floor, Campus and City) keeps one.
 */
describe("officeFloorSignsToDraw - fixup 6 rule 1: one host label per building, not per storey", () => {
  it("draws none of the old per-storey labels on a real two-host Towers or Building - the name lives on the foot sign instead", () => {
    for (const viewId of ["towers", "building"] as const) {
      const epic = makeTestEpic("two-hosts", 400, 1);
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
      // An oblique storey stack: the shape the finding measured. Sixty floors
      // on Towers, twenty-eight on Building at this population - a two-digit
      // multiple of "one label per storey", not a coincidence a smaller
      // fixture could pass by accident.
      expect(layout.floors.length).toBeGreaterThan(20);
      const hostNameById = new Map([
        ["host-a", "Host A"],
        ["host-b", "Host B"],
      ]);
      const floorSigns = officeFloorSignsToDraw({
        floors: layout.floors,
        hostNameById,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(floorSigns).toEqual([]);
      // The name is not gone - it moved. Both hosts still get exactly one
      // `host` sign each, across the whole building's foot, and that sign
      // resolves through the ordinary resolver with the host's own name.
      const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
      expect(hostSigns).toHaveLength(2);
      const drawnHostSigns = officeSignsToDraw({
        signs: hostSigns,
        visibleAgentIds: new Set(epic.agents.map((agent) => agent.id)),
        statusById,
        nameById: new Map(),
        hostNameById,
        roleClaims: {},
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS[viewId].painter.projector(layout),
        lod: 1,
      });
      expect(drawnHostSigns.map((entry) => entry.text).sort()).toEqual([
        "Host A",
        "Host B",
      ]);
    }
  });

  it("still labels each host once on a view that never stacks a host's floors, in a pure two-floor fixture", () => {
    // Floor, Campus and City give every host exactly one floor apiece, so
    // this is the group-of-one branch: `emptyFloor` pins it without a real
    // packer's geometry in the way.
    const floors = [
      emptyFloor({ hostId: "host-a" }),
      emptyFloor({ hostId: "host-b" }),
    ];
    const hostNameById = new Map([
      ["host-a", "Host A"],
      ["host-b", "Host B"],
    ]);
    const signs = officeFloorSignsToDraw({
      floors,
      hostNameById,
      projector: SHIFTED_PROJECTOR,
      lod: 1,
    });
    expect(signs).toHaveLength(2);
    expect(signs.map((sign) => sign.text).sort()).toEqual(["Host A", "Host B"]);
  });

  it("still labels each host once on a real Floor plan with two hosts", () => {
    const epic = makeTestEpic("two-hosts", 40, 1);
    const statusById = new Map(epic.statusById);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById,
      previous: null,
    });
    const layout = OFFICE_VIEWS.floor.plan({
      agents: epic.agents,
      partition,
      activityById: new Map(),
      occupancy: new Map(),
      needsCapacity: [],
      viewport: { width: 1040, height: 700 },
      previous: null,
    });
    // The rule this case pins: Floor packs one floor PER HOST, so every group
    // in `officeFloorSignsToDraw`'s host map has exactly one member and the
    // group-of-one branch fires for both, the same as it always did.
    expect(layout.floors).toHaveLength(2);
    const hostNameById = new Map([
      ["host-a", "Host A"],
      ["host-b", "Host B"],
    ]);
    const signs = officeFloorSignsToDraw({
      floors: layout.floors,
      hostNameById,
      projector: OFFICE_VIEWS.floor.painter.projector(layout),
      lod: 1,
    });
    expect(signs).toHaveLength(2);
    expect(signs.map((sign) => sign.text).sort()).toEqual(["Host A", "Host B"]);
  });
});

/**
 * Fixup 6, rule 3 (finding L1): the resolver used to hand the renderer the
 * plan's literal text unconditionally, so a bullpen plate's `Bullpen · 9 live
 * solos` (22 characters) went in whole and the RENDERER's own twelve-char
 * budget (`OFFICE_SIGN_PLATE_MAX_CHARS`, `truncateSign` in the canvas) cut it
 * to `BULLPEN · 9…` - the count is the part that got cut, because it sits
 * after everything else in the string being trimmed. That assertion would
 * have passed before this fixup too: the ellipsis was never the resolver's to
 * add or withhold. What is actually new is that the RESOLVER now steps the
 * reading down itself, so nothing it hands the renderer is left for that
 * budget to cut - proven here by size (the character budget) and by pixels
 * (the plate's own tiles), never by the ellipsis the renderer alone decides.
 */
describe("officeSignsToDraw - fixup 6 rule 3: bullpen and solo plates come down rungs, never mid-word", () => {
  it("keeps the count and drops only ` live solos` on real wide bullpen plates, within both the character budget and the pod's own pixels", () => {
    for (const { shape, count } of [
      { shape: "two-hosts", count: 400 },
      { shape: "many-roots", count: 1000 },
    ] as const) {
      const epic = makeTestEpic(shape, count, 1);
      const statusById = new Map(epic.statusById);
      const partition = partitionOfficePopulation({
        agents: epic.agents,
        statusById,
        previous: null,
      });
      const layout = OFFICE_VIEWS.building.plan({
        agents: epic.agents,
        partition,
        activityById: new Map(),
        occupancy: new Map(),
        needsCapacity: [],
        viewport: { width: 1040, height: 700 },
        previous: null,
      });
      const wideBullpens = layout.signs.filter(
        (sign) =>
          sign.kind === "plate" &&
          sign.text.startsWith("Bullpen · ") &&
          sign.text.endsWith(" live solos") &&
          sign.widthTiles === 18,
      );
      expect(wideBullpens.length).toBeGreaterThan(0);
      const names = new Map(epic.agents.map((agent) => [agent.id, agent.name]));
      const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
      const drawn = officeSignsToDraw({
        signs: wideBullpens,
        visibleAgentIds,
        statusById,
        nameById: names,
        hostNameById: new Map(),
        roleClaims: {},
        zoom: 1,
        measure,
        projector: OFFICE_VIEWS.building.painter.projector(layout),
        lod: 1,
      });
      expect(drawn).toHaveLength(wideBullpens.length);
      for (const entry of drawn) {
        // What the base commit handed the renderer for this exact plate -
        // over budget on its own, which is what made the renderer's cut land
        // mid-number rather than never happening at all.
        expect(entry.sign.text.length).toBeGreaterThan(
          OFFICE_SIGN_PLATE_MAX_CHARS,
        );
        // THE COUNT SURVIVES; ONLY THE WORDS AFTER IT ARE DROPPED - rule 3's
        // own ladder drops "Bullpen · N live solos" to "Bullpen · N" before
        // it drops the number, so the plate still says how many.
        expect(entry.text).toBe(entry.sign.text.replace(" live solos", ""));
        expect(entry.text.length).toBeLessThanOrEqual(
          OFFICE_SIGN_PLATE_MAX_CHARS,
        );
        expect(measure(entry.text)).toBeLessThanOrEqual(
          entry.sign.widthTiles * OFFICE_TILE,
        );
      }
    }
  });

  it("falls all the way to `BP` on a bullpen too narrow for even the bare word, never a reading cut mid-word", () => {
    const epic = makeTestEpic("two-hosts", 400, 1);
    const statusById = new Map(epic.statusById);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById,
      previous: null,
    });
    const layout = OFFICE_VIEWS.building.plan({
      agents: epic.agents,
      partition,
      activityById: new Map(),
      occupancy: new Map(),
      needsCapacity: [],
      viewport: { width: 1040, height: 700 },
      previous: null,
    });
    const narrowBullpen = layout.signs.find(
      (sign) =>
        sign.kind === "plate" &&
        sign.text.startsWith("Bullpen") &&
        sign.widthTiles === 2,
    );
    if (narrowBullpen === undefined) {
      throw new Error(
        "expected two-hosts/400 Building to place a two-tile bullpen plate",
      );
    }
    const names = new Map(epic.agents.map((agent) => [agent.id, agent.name]));
    const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
    const drawn = officeSignsToDraw({
      signs: [narrowBullpen],
      visibleAgentIds,
      statusById,
      nameById: names,
      hostNameById: new Map(),
      roleClaims: {},
      zoom: 1,
      measure,
      projector: OFFICE_VIEWS.building.painter.projector(layout),
      lod: 1,
    });
    expect(drawn).toHaveLength(1);
    // `BP`, not `Bul…` or any other cut of a word this plate had no room for.
    expect(drawn[0].text).toBe("BP");
    const available = officePlateWidthPx(narrowBullpen.widthTiles, 1);
    expect(measure("Bullpen")).toBeGreaterThan(available);
    expect(measure("BP")).toBeLessThanOrEqual(available);
  });

  /**
   * Towers' own population never seats a solo bench narrow enough to force
   * this ladder past its first rung - every real solo plate here has the
   * pixels for "Solo desks" whole - so the narrower two rungs are pinned on a
   * plate carrying the exact ladder `roomRungs` (`oblique-plan.ts`) declares
   * for Towers, exercised through the real resolver rather than a copy of it.
   */
  it("steps a solo-desks plate through its own ladder as the pod narrows", () => {
    const rungs = ["Solo desks", "Solos", "SD"];
    const widthsAndExpected: ReadonlyArray<readonly [number, string]> = [
      [18, "Solo desks"],
      [3, "Solos"],
      [2, "SD"],
    ];
    for (const [widthTiles, expected] of widthsAndExpected) {
      const sign: OfficeSign = {
        kind: "plate",
        tile: { col: 0, row: 0 },
        widthTiles,
        text: "Solo desks",
        ownerAgentId: null,
        hostId: null,
        agentIds: [],
        rungs,
      };
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
      expect(drawn[0].text).toBe(expected);
    }
  });
});

describe("nameTagTextThatFits - fixup 8 the tag ladder: written, clipped, first word, initials, nothing", () => {
  /**
   * The tag's OWN face - `LABEL_FONT` in the renderer, 10px monospace,
   * untracked and unpadded - not the plate's (bold, tracked, padded) `measure`
   * above. Every face in the monospace stack advances 0.6em a character, so
   * ten pixels is six a character with nothing added, which is the same
   * arithmetic the canvas suite's `modelledTextWidth` uses for this face.
   */
  function tagMeasure(text: string): number {
    return text.length * 6;
  }

  it("rung 1: returns the name as written when the budget admits it whole", () => {
    const name = "Alpha Sitter"; // 12 chars * 6px = 72px
    expect(tagMeasure(name)).toBe(72);
    expect(
      nameTagTextThatFits({ name, widthPx: 72, measure: tagMeasure }),
    ).toBe(name);
  });

  it("rung 2: clips to an ellipsis when the written name overflows but a 9-character prefix fits", () => {
    const name = "Orchestrator"; // 12 chars, one word
    // Written: 72px. Not admitted at 60px.
    expect(tagMeasure(name)).toBeGreaterThan(60);
    // "Orchestra…" is 10 chars = 60px, and is the LONGEST prefix (>= 6 kept
    // characters) this budget admits: "Orchestrat…" (11 chars) is 66px.
    expect(
      nameTagTextThatFits({ name, widthPx: 60, measure: tagMeasure }),
    ).toBe("Orchestra…");
  });

  it("rung 3: falls to the first word when the written name and every clip overflow", () => {
    const name = "Alpha Sitter";
    // 32px admits "Alpha" (5 * 6 = 30) but not "Alpha Sitter" (72) and not
    // any clip: the narrowest clip this floor allows keeps 6 characters,
    // "Alpha " -> trimmed to "Alpha" (5, under the floor) the moment the
    // trailing space is dropped, so rung 2 never has a candidate here.
    expect(
      nameTagTextThatFits({ name, widthPx: 32, measure: tagMeasure }),
    ).toBe("Alpha");
  });

  it("rung 4: falls to initials when even the first word overflows", () => {
    const name = "Alpha Sitter";
    // 16px (one tile at zoom 1): "Alpha" (30) overflows, "AS" (12) fits.
    expect(
      nameTagTextThatFits({ name, widthPx: 16, measure: tagMeasure }),
    ).toBe("AS");
  });

  it("the six-character floor: a budget that would admit only a five-character clip skips rung 2 and lands on the first word", () => {
    const name = "Ada Blackwellstein";
    // Every clip this ladder will TRY keeps at least 6 characters, so its
    // narrowest candidate is "Ada Bl…" (7 chars) at 42px. A 40px budget
    // admits nothing narrower than that - a 5-character clip, "Ada B…" at
    // 36px, would fit, but the floor never offers it - so rung 2 fails
    // outright and the ladder falls all the way to the first word.
    expect(
      nameTagTextThatFits({ name, widthPx: 40, measure: tagMeasure }),
    ).toBe("Ada");
  });

  it("never returns a one-letter initials set: a hyphenated single word's lone initial is refused even when it would fit", () => {
    const name = "team-4-member-1"; // one word: no spaces to split on.
    // "t" alone is 6px and would fit comfortably at 20px, but a single
    // initial is not a rung - the ladder has nowhere else to go, so it
    // returns null rather than a floor of identical single letters.
    expect(tagMeasure("t")).toBeLessThanOrEqual(20);
    expect(
      nameTagTextThatFits({ name, widthPx: 20, measure: tagMeasure }),
    ).toBeNull();
  });

  it("a hyphenated single word over a one-tile budget draws no tag at all", () => {
    const name = "team-6-member-1";
    // 16px (one tile at zoom 1): the written name overflows, its only "first
    // word" IS the written name (no rung 3), and its initials are the single
    // letter "t" (no rung 4 either). Nothing is left to draw.
    expect(
      nameTagTextThatFits({ name, widthPx: 16, measure: tagMeasure }),
    ).toBeNull();
  });
});
