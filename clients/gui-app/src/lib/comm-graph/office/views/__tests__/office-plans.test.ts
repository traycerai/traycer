/**
 * The invariants the view contract promises hold of EVERY registered view's
 * plan - run once per entry in `OFFICE_VIEW_IDS`, which is exactly the point:
 * a view registered tomorrow inherits this whole suite for free.
 *
 * Folds in `office-layout-contract.test.ts` (deleted), which pinned these
 * against `layoutOffice` directly before the view seam existed. Every case
 * folded from it is named in its own comment below.
 */
import { describe, expect, it } from "vitest";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import {
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_NARROW_PLATE_MAX_CHARS,
  OFFICE_SIGN_PADDING_X,
  OFFICE_SIGN_PLATE_MAX_CHARS,
  officeCivicSignText,
  officeSignCenterX,
  officeSignsToDraw,
} from "@/lib/comm-graph/office/office-signs";
import { OFFICE_LOD_CLOSEUP_ZOOM } from "@/lib/comm-graph/office/office-lod";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import {
  ARCHIVE_SIGN_WIDTH_TILES,
  civicCapacityFor,
} from "@/lib/comm-graph/office/office-layout";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeErrandKind,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeLayout,
  type OfficeCivicKind,
  type OfficeCivicRoom,
  type OfficeCivicTally,
  type OfficeRect,
  type OfficeSceneInput,
  type OfficeSign,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeViewId,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_VIEW_IDS,
  OFFICE_VIEWS,
  type OfficePainter,
  type OfficePlanInput,
  type OfficeProjector,
} from "@/lib/comm-graph/office/views/office-view";

/**
 * WHICH ART A PLATE HANGS OFF, as the renderer's `signSpriteFor` answers it: a
 * two-tile board for the signs that name an area or a room, a one-tile plate for
 * a pod's, and nothing for a team board. It decides how far below the sign's own
 * tile the lettering's baseline drops, so a screen-space comparison needs it.
 */
function plateArtFor(kind: OfficeSign["kind"]): OfficeSpriteName | null {
  if (
    kind === "room" ||
    kind === "area" ||
    kind === "host" ||
    kind === "civic"
  ) {
    return "sign";
  }
  if (kind === "pod" || kind === "plate") return "pod-plate";
  return null;
}

function isWalkable(layout: OfficeLayout, tile: OfficeTilePos): boolean {
  return layout.walkable[tile.row]?.[tile.col];
}

/** A frame wide enough that nothing in the layout is culled by the viewport. */
function frameOverLayout(
  scene: OfficeScene,
  projector: OfficeProjector,
): OfficeFrame {
  const { bounds } = projector;
  const worldRect = {
    x: bounds.x - 4096,
    y: bounds.y - 4096,
    width: bounds.width + 8192,
    height: bounds.height + 8192,
  };
  return scene.frame(2, worldRect);
}

/**
 * Where an agent's own CHARACTER is actually drawn, from the frame's hit
 * regions - a seat region is desk-sized, so a character region is the one
 * with `OFFICE_CHARACTER_HEIGHT`. `null` when nothing drew that agent.
 */
function characterRectOf(
  frame: OfficeFrame,
  agentId: string,
): OfficeRect | null {
  // F4 gives `worldHitRegions` one region PER DRAWABLE PART, not one per
  // seat - so on a `world` painter (Campus, City) a seat's furniture parts
  // sit in this same array now. `character` is the only 20px-tall sprite in
  // `SPRITE_SIZES`, but a `block` drawable can be any height, so the width
  // is pinned too; and if more than one region still matches, that is a
  // silent ambiguity this helper must not paper over by taking the first.
  const matches = frame.hitRegions.filter(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.rect.height === OFFICE_CHARACTER_HEIGHT &&
      candidate.rect.width === OFFICE_CHARACTER_WIDTH,
  );
  if (matches.length > 1) {
    throw new Error(`more than one character-shaped hit region for ${agentId}`);
  }
  return matches.length === 0 ? null : matches[0].rect;
}

function floorBandContains(floor: OfficeFloor, row: number): boolean {
  return row >= floor.bounds.row && row < floor.bounds.row + floor.bounds.rows;
}

function withinRect(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

/**
 * Every field a plan is allowed to see, built the way the scene builds it -
 * from `partitionOfficePopulation` rather than a stub, so the partition a
 * plan reads is the real thing every other consumer reads too.
 */
function planInputFor(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly overrides: Partial<OfficePlanInput>;
}): OfficePlanInput {
  const { agents, statusById, overrides } = args;
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
    viewport: { width: 1040, height: 700 },
    previous: null,
    ...overrides,
  };
}

function sceneInputFor(args: {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly partition: OfficePlanInput["partition"];
}): OfficeSceneInput {
  const { agents, statusById, partition } = args;
  return {
    agents,
    visibleAgentIds: new Set(agents.map((agent) => agent.id)),
    statusById,
    partition,
    activityById: new Map<string, number>(),
    viewport: { width: 1040, height: 700 },
    openRequestsByReceiver: new Map<string, number>(),
    pulse: null,
    pulseKey: null,
    stepMs: 0,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: true,
    feedSettled: false,
  };
}

import {
  CIVIC_KINDS,
  CIVIC_ROADS_EXPECTED,
  CIVIC_ROOMS_EXPECTED,
} from "@/lib/comm-graph/office/__tests__/civic-rooms-expected";

/**
 * THE POPULATIONS EVERY VIEW'S CONTRACT IS READ AT - three round ones, and a
 * fourth that is here for a measurement.
 *
 * `12`, `309` and `1000` are the small, large and ceiling fixtures the rest of
 * the office suites use, and they were the whole list. `15` is the KNIFE-EDGE
 * POPULATION: the smallest at which City's `CITY_CIVIC_CLEARANCE_ROWS = 2` is
 * load-bearing for the plate rule this suite owns.
 *
 * MEASURED, and the gap is the point. Cutting that clearance to one row
 * overprints a district's lowest lot plate on its hospital plate by 2.8 px at
 * office zoom - at 15-21, 50-52 and 100 agents on a 2..60, 80, 100, 150, 200,
 * 309, 500, 700, 1,000 sweep, and at NONE of 12, 309 or 1,000. So with three
 * round populations this suite passed all 330 cases under that mutant and the
 * rule it exists to guard was pinned nowhere but City's own structural case
 * (`expected 48 to be less than or equal to 47`). A rule this suite states and
 * cannot fail is not a pin.
 *
 * WHY THE SMALLEST INSTANCE rather than the widest margin: the overprints are
 * all the same pair at the same 2.8 px, so no instance is a stronger witness
 * than another, and 15 is the cheapest to plan - a fourth population costs
 * every view every case in this block. Measured: 6.98s against 7.20s for the
 * three, because the cost of this suite is the 1,000-agent column.
 *
 * `city-plan.ts`'s own note at `CITY_CIVIC_CLEARANCE_ROWS` still reads "the
 * shared plate case stays green under that mutant". That was true of the three
 * populations and is what this fourth one is here to stop being true; the note
 * describes the measurement that was taken, not the state of this suite.
 */
const TRIAGE_SCALES: ReadonlyArray<number> = [12, 15, 309, 1000];

/**
 * How much screen-space overlap between two plate backings is not an overlap.
 *
 * Flat rather than scaled by zoom or by plate size: what it absorbs is a
 * floating-point residual on an EXACT abutment, which has no size of its own to
 * be proportional to - and the zooms sampled here are two, so a flat CSS pixel
 * is a claim about those two rather than about the zoom range. The measurement
 * that picks the number, and the reason tangency is legitimate here at all, is
 * at the use site.
 */
const TOUCH_TOLERANCE_PX = 0.01;

describe.each(OFFICE_VIEW_IDS)("%s view", (viewId) => {
  const view = OFFICE_VIEWS[viewId];

  describe.each(TRIAGE_SCALES)("triage at %i agents", (n) => {
    const epic = makeTestEpic("triage", n, 1);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    const agentIds = new Set(epic.agents.map((agent) => agent.id));

    /**
     * A ROOM THAT SAYS IT IS WALLED HAS A BACK WALL, in every view.
     *
     * `enclosure` is read by the isometric painter alone today, so the OTHER
     * views' values would be declarations nobody checks - and an unchecked
     * declaration drifts. This is the one direction that can be checked from the
     * plan itself: a walled room's first bounds row is its back wall, so every
     * tile of it is blocked.
     *
     * THE REVERSE IS NOT ASSERTED and must not be. An open room's perimeter is
     * blocked by its own FURNITURE - Campus's reception counter is two blocked
     * tiles and no wall - and reading that as a wall is the defect this field
     * exists to prevent. A test that pinned it would pin the bug.
     *
     * The counts are the other half. Without them a view that quietly turned
     * every room open would satisfy the implication vacuously, and this case is
     * the only place the values are read at all. Measured: the Floor walls its
     * infirmary and its waiting room, Campus its sick bay and its records hut,
     * and the three views whose civic rooms stand on an open plaza or in one
     * hall wall nothing.
     */
    it("walls exactly the civic rooms that say they are walled", () => {
      const civic = layout.floors.flatMap((floor) => floor.civic);
      if (!CIVIC_ROOMS_EXPECTED[viewId]) {
        expect(civic.length).toBe(0);
        return;
      }
      expect(civic.length).toBeGreaterThan(0);

      const walledPerStorey: Readonly<Record<OfficeViewId, number>> = {
        floor: 2,
        towers: 0,
        building: 0,
        "mission-control": 0,
        campus: 2,
        // Its hospital and its warehouse. The bus stop is a shelter on a
        // pavement, and the police station is the park's own counter.
        city: 2,
      };
      const storeys = layout.floors.filter((floor) => floor.civic.length > 0);
      const walled = civic.filter((room) => room.enclosure === "walled");
      expect(walled.length).toBe(walledPerStorey[viewId] * storeys.length);

      for (const room of walled) {
        for (
          let col = room.bounds.col;
          col < room.bounds.col + room.bounds.cols;
          col += 1
        ) {
          expect(
            layout.walkable[room.bounds.row]?.[col],
            `${viewId} ${room.kind} back wall open at col ${String(col)}`,
          ).not.toBe(true);
        }
      }
    });

    it("plans civic rooms exactly where the table says it should", () => {
      const enrolled = CIVIC_ROOMS_EXPECTED[viewId];
      const withRooms = layout.floors.filter((floor) => floor.civic.length > 0);

      if (!enrolled) {
        // The only way into the civic layer is the table. A view that started
        // planning rooms without being enrolled reddens here rather than
        // shipping half a layer in silence.
        expect(withRooms).toEqual([]);
        for (const floor of layout.floors) expect(floor.road).toBeNull();
        return;
      }

      // PER BUILDING, not per storey. A view may keep one set of rooms for a
      // whole host - the oblique views put them on the plaza storey and give
      // every other storey `civic: []` - so what is owed is that each host has
      // a storey carrying the four rooms, and that every agent's host is one
      // of them.
      expect(withRooms.length).toBeGreaterThan(0);
      const hostsWithRooms = new Set<string | null>();
      const wantsRoad = CIVIC_ROADS_EXPECTED[viewId];
      for (const floor of withRooms) {
        expect([...floor.civic].map((room) => room.kind).sort()).toEqual(
          [...CIVIC_KINDS].sort(),
        );
        hostsWithRooms.add(floor.hostId);
        // A street where the second table says so, and NO street where it does
        // not - Mission control is one amphitheatre and nothing drives into a
        // hall. A view without a road may not name a kerb either, so losing a
        // road cannot pass by having nothing left to misplace.
        if (wantsRoad) expect(floor.road).not.toBeNull();
        else {
          expect(floor.road).toBeNull();
          for (const room of floor.civic) expect(room.kerbTile).toBeNull();
        }
      }
      for (const floor of layout.floors) {
        expect(hostsWithRooms.has(floor.hostId)).toBe(true);
      }

      // Capacity is the contract's, from the one exported formula, so a view
      // that sized its own ward differently is a view that disagrees with the
      // seat book about how many people fit.
      for (const floor of withRooms) {
        const here = epic.agents.filter(
          (agent) => agent.hostId === floor.hostId,
        ).length;
        const bounds = civicCapacityFor(here);
        const seatsOf = (kind: OfficeCivicKind): number => {
          const room = floor.civic.find((entry) => entry.kind === kind);
          return room === undefined ? 0 : room.seatIds.length;
        };
        expect(seatsOf("infirmary")).toBe(bounds.beds);
        expect(seatsOf("waiting-room")).toBe(bounds.chairs);
        // C5 and C7: a door with a counter and a counter with a queue. Neither
        // is a room anybody sits down in.
        expect(seatsOf("archive")).toBe(0);
        expect(seatsOf("help-desk")).toBe(0);
      }

      // Every civic seat is a real registered seat, of the kind its room
      // implies, naming its own room back.
      for (const floor of withRooms) {
        for (const room of floor.civic) {
          for (const seatId of room.seatIds) {
            const seat = layout.seats.get(seatId);
            expect(seat).toBeDefined();
            if (seat === undefined) continue;
            expect(seat.civicRoomId).toBe(room.civicRoomId);
            expect(seat.kind).toBe(
              room.kind === "infirmary" ? "bed" : "lounge",
            );
          }
        }
      }
    });

    /**
     * HOW EACH VIEW SIZES A CIVIC PLATE, declared because both rules are right
     * and neither is derivable from the other.
     *
     * `frontage` is the original: a plate spans from its own tile to the room's
     * right edge, so a sixteen-bed ward letters across sixteen tiles. Five views
     * do this.
     *
     * `fixed` is City's, and City's own geometry forces it. A plate is centred
     * over the tiles it spans, so a frontage-wide plate on a seventeen-column ward
     * hangs its lettering eight tiles INTO the district - which is where the lot
     * plates are. Measured with City on the frontage rule, sweeping every
     * population from 8 to 140 and then 160, 200, 250, 309, 400, 500, 700 and
     * 1,000: 48 overprints, every one the same pair - a lot plate four columns
     * right and six rows above the hospital's sign, `col + row` two apart, 1.2 to
     * 8.4 px deep at office zoom. Campus takes none in the same sweep, because its
     * bench row widens its whole shelf and its ward's plate therefore centres over
     * its own band.
     *
     * SIX IS NOT A ROUND NUMBER, it is the reading: `OFFICE_TILE` is 16, so six
     * tiles are 154 px at close-up against City's longest rung at 137. The width
     * is asserted as a literal here rather than imported, because a pin that
     * evaluates the plan's own constant is not a pin.
     */
    const CIVIC_PLATE_RULE: Readonly<
      Record<OfficeViewId, "frontage" | "fixed">
    > = {
      floor: "frontage",
      towers: "frontage",
      building: "frontage",
      "mission-control": "frontage",
      campus: "frontage",
      city: "fixed",
    };
    const CITY_PLATE_TILES = 6;

    /** A tally with something in every room, so no counter reads empty. */
    const FULL_TALLY: OfficeCivicTally = {
      occupiedByRoom: new Map(
        layout.floors
          .flatMap((floor) => floor.civic)
          .map((room) => [room.civicRoomId, 1]),
      ),
      archivedByHost: new Map(
        layout.floors.map((floor) => [floor.hostId, 3] as const),
      ),
    };
    /** Wider than any plate a view hangs: the reading with room to spare. */
    const GENEROUS_TILES = 64;
    const plateMeasure = (text: string): number =>
      text.length *
        OFFICE_SIGN_FONT_PX *
        (0.6 + OFFICE_SIGN_LETTER_SPACING_EM) +
      OFFICE_SIGN_PADDING_X * 2;

    it("hangs one readable plate on each civic room, overprinting nothing", () => {
      if (!CIVIC_ROOMS_EXPECTED[viewId]) return;
      const civicSigns = layout.signs.filter((sign) => sign.kind === "civic");
      const rooms = layout.floors.flatMap((floor) => floor.civic);
      expect(rooms.length).toBeGreaterThan(0);
      expect(civicSigns.length).toBe(rooms.length);

      for (const room of rooms) {
        const plate = civicSigns.find(
          (sign) => sign.civicRoomId === room.civicRoomId,
        );
        // ONE PLATE PER ROOM, carrying the room's id. The id is how the renderer
        // reads a live counter off the room under the cursor instead of the text
        // the plan happened to bake in, so a plate without one is a dead label.
        if (plate === undefined) {
          throw new Error(`${room.kind} has no plate`);
        }
        expect(plate.tile).toEqual(room.signTile);
        expect(plate.text).toBe(room.name);
        if (CIVIC_PLATE_RULE[viewId] === "fixed") {
          // ONE WIDTH FOR ALL FOUR, the records door included: see the table.
          expect(plate.widthTiles).toBe(CITY_PLATE_TILES);
          expect(plate.tile.col).toBeGreaterThanOrEqual(0);
          expect(plate.tile.col + plate.widthTiles).toBeLessThanOrEqual(
            layout.cols,
          );
          // AND IT KEEPS EVERY RUNG THE RESOLVER HAS, which is what the width
          // was chosen for. Asked at close-up, where the counter exists at all
          // (`OFFICE_SIGN_COUNTER_LOD`), the reading on this plate is the reading
          // it would give with the whole world to letter in.
          //
          // ASSERTED FOR THIS VIEW ONLY, and deliberately not for the others: a
          // plate narrower than its reading is the LADDER WORKING, and four views
          // already ship one. Measured over all six views at 12, 309 and 1,000 -
          // 72 rooms, seven of which drop their count at close-up:
          //
          //   Towers        12    waiting-room  4 tiles  `Waiting room`
          //   Building      12    waiting-room  4 tiles  `Waiting room`
          //   Mission ctrl  12    infirmary     4 tiles  `Medbay`
          //   Mission ctrl  all   waiting-room  2 tiles  `Gallery`
          //   Campus        12    waiting-room  4 tiles  `Benches`
          //
          // Two corrections to the first wording of this comment, which said
          // "two and three tiles wide" and put every drop "at 12 agents": the
          // widths are FOUR and two, and the Gallery drops at EVERY population,
          // not only the smallest. What City may not do is lose a count on a
          // seventeen-column ward, and that is what this pins.
          const readingAt = (widthTiles: number): string =>
            officeCivicSignText({
              room,
              tally: FULL_TALLY,
              lod: 2,
              widthTiles,
              zoom: OFFICE_LOD_CLOSEUP_ZOOM,
              measure: plateMeasure,
            }).text;
          expect(readingAt(plate.widthTiles)).toBe(readingAt(GENEROUS_TILES));
        } else if (room.kind === "archive") {
          // WIDER THAN THE ROOM, on purpose: C5's archive is a DOOR, one tile,
          // and a one-tile plate holds no word. The constant is shared so that
          // every FRONTAGE view's records door is labelled the same width; the
          // fixed-width view plates its door like its other three, wider.
          expect(plate.widthTiles).toBe(ARCHIVE_SIGN_WIDTH_TILES);
          // Whichever way the view hangs it - rightwards from the door in the
          // Floor and the plazas, leftwards to END at it in the hall, whose door
          // is three columns from the back wall - the plate is on the plan.
          expect(plate.tile.col).toBeGreaterThanOrEqual(0);
          expect(plate.tile.col + plate.widthTiles).toBeLessThanOrEqual(
            layout.cols,
          );
        } else {
          // A PLATE IS AS WIDE AS THE ROOM IT NAMES. This is what decides how
          // much of the reading survives - the resolver measures the room's word
          // and its counter against the plate's own pixels - and `> 0` was the
          // hole a ward spanning sixteen tiles and plated with two went through.
          //
          // WHERE THE PLATE HANGS DECIDES WHICH READING APPLIES, and the two are
          // not the same expression. Anchored INSIDE the room, the plate spans
          // from its own tile to the room's right edge and may not letter past
          // it. Anchored OUTSIDE - Campus hangs the front desk's plate at the
          // district's gate, columns from the counter it names - it carries the
          // room's own frontage at its anchor, because the run from the anchor to
          // the room is not a frontage: for that plate it was five tiles of open
          // courtyard. That case also has to be written out rather than folded
          // into one formula, because a single `bounds.col + bounds.cols -
          // tile.col` is what the plan itself would compute, and a pin that
          // evaluates the implementation's own expression is not a pin.
          const anchorInside =
            plate.tile.col >= room.bounds.col &&
            plate.tile.col < room.bounds.col + room.bounds.cols;
          expect(plate.widthTiles).toBe(
            anchorInside
              ? room.bounds.col + room.bounds.cols - plate.tile.col
              : room.bounds.cols,
          );
          if (anchorInside) {
            // The inset plate's own defect, stated as the edge it may not cross.
            expect(plate.tile.col + plate.widthTiles).toBe(
              room.bounds.col + room.bounds.cols,
            );
          }
          expect(plate.widthTiles).toBeGreaterThan(0);
        }
      }

      // AND NO PLATE PRINTS OVER ANOTHER. A plate wider than its room is the one
      // way this layer can reach a neighbour's lettering, so the check is every
      // civic plate against EVERY sign sharing its row - a host plate and a room
      // plate are as unreadable under an overprint as another civic one.
      for (const plate of civicSigns) {
        for (const other of layout.signs) {
          if (other === plate) continue;
          if (other.tile.row !== plate.tile.row) continue;
          const clear =
            other.tile.col >= plate.tile.col + plate.widthTiles ||
            plate.tile.col >= other.tile.col + other.widthTiles;
          expect(
            clear,
            `${plate.kind} "${plate.text}" at ${plate.tile.col},${plate.tile.row} (${String(plate.widthTiles)} wide) overprints ${other.kind} "${other.text}" at ${other.tile.col}`,
          ).toBe(true);
        }
      }
    });

    /**
     * NO CIVIC PLATE OVERLAPS ANOTHER PLATE ON SCREEN - which is a different
     * claim from the tile check above, and a stronger one.
     *
     * A plate's backing is a FIXED fourteen pixels tall and as wide as its text
     * measures, drawn at a fixed face however far out the camera is; a tile row
     * is sixteen world pixels, 11.2 of them at office zoom. So two plates one
     * row apart overlap by 2.8 pixels of backing with their tiles perfectly
     * separate, and the tile check cannot see it - it compares different-row
     * pairs not at all. That is exactly how the plazas shipped "Records" 2.8
     * pixels inside "Front desk" and the Floor shipped "Archive" 9.8 inside it.
     *
     * THE OVERFLOW IS THE LADDER WORKING, not something to truncate away: the
     * word is a civic plate's floor, so "Front desk" measures 76 pixels on the
     * three tiles the Floor gives it and is drawn in full at every band.
     * PLACEMENT is the half that has to give, which is why this case is about
     * where a plate hangs and never about how long its name is.
     *
     * EVERY PAIR, whatever their kinds. This was scoped to pairs involving a
     * civic plate when it was written, because the unrestricted claim was red on
     * pod plates against their own team boards in the oblique views at close-up
     * - 13 pairs in Towers at 309 and at 1,000, 2 at 12, 1 in Building - a
     * defect the civic layer had not introduced. That is fixed (a pod's plate
     * stops short of the tile its board letters, and a pod too narrow for both
     * letters no count), so the case says what it always meant to.
     */
    it("keeps every plate's backing clear of every other plate's, at office zoom and at close-up", () => {
      if (!CIVIC_ROOMS_EXPECTED[viewId]) return;
      // The face the plate is actually set in, derived rather than guessed: the
      // tracking counts towards `measureText` as well as towards the painted
      // glyphs, so leaving it out under-reports every plate by eight percent -
      // the difference between two plates that clear and two that do not.
      const charPx =
        OFFICE_SIGN_FONT_PX * (0.6 + OFFICE_SIGN_LETTER_SPACING_EM);
      const measure = (text: string): number =>
        text.length * charPx + OFFICE_SIGN_PADDING_X * 2;
      // The renderer's own two numbers for the box it paints around a plate:
      // the baseline it drops the lettering to below the sign's art, and the
      // vertical padding of the backing. Mirrored here with the file they come
      // from named, the way this suite's sibling mirrors the plate's advance -
      // they live in a `.tsx` component the office modules do not import.
      const SIGN_LABEL_BASELINE = 11;
      const SIGN_PADDING_Y = 2;
      const projector = view.painter.projector(layout);
      const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));

      for (const [zoom, lod] of [
        [0.7, 1],
        [1.6, 2],
      ] as ReadonlyArray<readonly [number, 1 | 2]>) {
        const drawn = officeSignsToDraw({
          signs: layout.signs,
          floors: layout.floors,
          visibleAgentIds,
          statusById: epic.statusById,
          nameById: new Map(epic.agents.map((agent) => [agent.id, agent.name])),
          hostNameById: new Map(),
          roleClaims: {},
          civicTally: {
            occupiedByRoom: new Map<string, number>(),
            archivedByHost: new Map<string | null, number>(),
          },
          projector,
          lod,
          zoom,
          clock: { nowMs: 0, reducedMotion: false },
          measure,
        });
        const boxes = drawn.map((entry) => {
          const kind = entry.sign.kind;
          // Which art the plate hangs off, and how far the lettering drops below
          // the sign's own tile: the renderer's `signSpriteFor`, the two sprites
          // it can answer, and nothing for a board.
          const sprite = plateArtFor(kind);
          const overhang =
            sprite === null
              ? 0
              : OFFICE_TILE - officeSpriteSize({ name: sprite }).height;
          // A SUMMARY is drawn as the resolver chose it and a NAME is cut to the
          // renderer's character budget first, so the two are measured
          // differently - the drawn string is what has a backing round it.
          const summary =
            kind === "board" || kind === "hq-board" || kind === "civic";
          const budget =
            entry.sign.widthTiles >= 2
              ? OFFICE_SIGN_PLATE_MAX_CHARS
              : OFFICE_SIGN_NARROW_PLATE_MAX_CHARS;
          const text = (
            summary || entry.text.length <= budget
              ? entry.text
              : `${entry.text.slice(0, budget - 1)}…`
          ).toUpperCase();
          const width = measure(text);
          const centreX = officeSignCenterX(entry) * zoom;
          const baseline =
            (entry.anchor.y + overhang + SIGN_LABEL_BASELINE) * zoom;
          return {
            civic: kind === "civic",
            label: `${kind} "${text}" at ${entry.sign.tile.col},${entry.sign.tile.row}`,
            left: centreX - width / 2,
            right: centreX + width / 2,
            top: baseline - OFFICE_SIGN_FONT_PX - SIGN_PADDING_Y,
            bottom: baseline + SIGN_PADDING_Y,
          };
        });
        // CLOSE-UP ONLY. At office zoom a civic sign is fixture lettering
        // unless its own counter fits or it carries a beacon
        // (`officeSignLetteredAt`), so a small population or a narrow room
        // can legitimately draw none there - that is the feedback-round-1
        // fix, not a gap in this sweep. Close-up still letters every civic
        // room unconditionally, which is what keeps the sweep from going
        // vacuous on the one plate kind it exists to catch.
        if (lod === 2) {
          expect(boxes.some((box) => box.civic)).toBe(true);
        }

        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i];
            const b = boxes[j];
            // A HUNDREDTH OF A PIXEL, because two plate faces are allowed to
            // TOUCH and floating point cannot say which side of touching it
            // landed on. This geometry is commensurate: a face measures
            // `len * 6.8 + 8` and the isometric separations are `16 * zoom`
            // apart, so faces abut EXACTLY rather than nearly, and the residual
            // is whatever the multiplication left behind.
            //
            // WHAT WAS SAMPLED, stated as a sample. Every PAIR - not each
            // combination's minimum - in 36 combinations of 6 views x 3
            // populations x 2 zooms, taking only those under 5 px. HISTORICAL
            // NOTE on where the City figures came from: when they were taken
            // this case ran five views, City returning at the enrolment gate
            // above, so City was measured with that gate lifted. City is
            // enrolled now and the case runs all six, so the construction that
            // produced these is the one running here rather than a reconstruction
            // of it. The figures are left as they were taken:
            //
            //   3 pairs at exactly 0
            //   2 at -5.6843e-14, 1 at -1.1369e-13, 1 at +1.1369e-13
            //   11 at 2.8, 5 at 3.4
            //
            // Seven pairs within 1.2e-13 of zero, three of them landing exactly
            // on it, and then nothing until 2.8 px. The residual falling on BOTH
            // sides of zero, and on zero itself, is what says its sign is
            // rounding rather than geometry.
            //
            // The empty band is a property of this SAMPLE, not a proof about
            // every fixture: a knife-edge sweep that hunts a pair deliberately
            // placed a thousandth of a pixel apart is on the plan's open list.
            // What is not sample-bound is the RATIO - 0.01 px is 8.8e10 times
            // the largest residual measured, and 120x smaller than 1.2 px, the
            // smallest REAL overprint this suite has caught (finding 5's board
            // at close-up; the rest ran 2.8 to 8.4 px).
            //
            // Exact tangency is NOT a defect and must not be "fixed" by nudging
            // a packer - the nudge would move a layout that is correct, to
            // satisfy an artefact of reading it.
            const separation = Math.max(
              b.left - a.right,
              a.left - b.right,
              b.top - a.bottom,
              a.top - b.bottom,
            );
            expect(
              separation > -TOUCH_TOLERANCE_PX,
              `zoom ${String(zoom)}: ${a.label} overlaps ${b.label} by ${String(-separation)} px`,
            ).toBe(true);
          }
        }
      }
    });

    /** Every tile of a rect, as the `col,row` keys the sets above are built on. */
    const tileKeysIn = (bounds: OfficeTileRect): ReadonlyArray<string> => {
      const keys: string[] = [];
      for (let row = bounds.row; row < bounds.row + bounds.rows; row += 1) {
        for (let col = bounds.col; col < bounds.col + bounds.cols; col += 1) {
          keys.push(`${col},${row}`);
        }
      }
      return keys;
    };

    /**
     * A KERB IS A PROMISE, and this is the whole of it.
     *
     * C6 says which rooms make it - a vehicle drives to a ward and to a counter,
     * and to neither a bench nor a records door - and ruling 6 says what it
     * means: a road tile one step from that room's own door.
     */
    const expectKerbPromise = (
      room: OfficeCivicRoom,
      roadTiles: ReadonlySet<string>,
    ): void => {
      const kerb = room.kerbTile;
      // Only the two rooms something drives to name one (C6).
      if (room.kind === "waiting-room" || room.kind === "archive") {
        expect(kerb).toBeNull();
        return;
      }
      // AND THEY NAME ONE EXACTLY WHEN THERE IS A ROAD TO NAME IT ON. A roadless
      // hall's rooms carry `null` and are done with it; a view with a street owes
      // BOTH of them a kerb, so one that quietly dropped its own would otherwise
      // pass by having nothing left to misplace.
      if (!CIVIC_ROADS_EXPECTED[viewId]) {
        expect(kerb).toBeNull();
        return;
      }
      if (kerb === null) throw new Error(`${room.kind} owes a kerb`);
      // A kerb off the road is a vehicle parked in the flowerbed.
      expect(roadTiles.has(`${kerb.col},${kerb.row}`)).toBe(true);
      // AND IT IS NEXT TO ITS OWN DOOR, for both rooms. "Somewhere on the road"
      // would let an ambulance stop at the far end of the building and unload a
      // stretcher that walks the length of the floor to the bed, and would let a
      // courier's parcel cross the lobby to reach the counter it was delivered
      // for.
      expect(
        Math.abs(kerb.col - room.doorTile.col) +
          Math.abs(kerb.row - room.doorTile.row),
      ).toBe(1);
    };

    it("walks to every civic seat, its archive door and its kerbs", () => {
      if (!CIVIC_ROOMS_EXPECTED[viewId]) return;
      for (const floor of layout.floors) {
        if (floor.civic.length === 0) continue;
        const road = floor.road;
        if (road === null && CIVIC_ROADS_EXPECTED[viewId])
          throw new Error("an enrolled storey owes a road");
        const roadTiles = new Set(
          (road?.tiles ?? []).map((tile) => `${tile.col},${tile.row}`),
        );
        const corridorTiles = new Set(
          floor.corridorTiles.map((tile) => `${tile.col},${tile.row}`),
        );
        for (const room of floor.civic) {
          // A DOOR IS NEVER A ROAD TILE. A vehicle stops outside and unloads;
          // it does not drive through the doorway it is stopping at.
          expect(
            roadTiles.has(`${room.doorTile.col},${room.doorTile.row}`),
          ).toBe(false);
          // AND NO LANE THROUGH A ROOM SOMEBODY IS LYING OR SITTING IN. Said of
          // the rooms with seats rather than of all four, because a help desk is
          // a COUNTER ON THE FRONTAGE: the Floor's stands on its lobby row,
          // which is that view's road, and its queue forms on the same pavement.
          // A vehicle passing a counter is furniture it drives past; a vehicle
          // crossing a bed is not.
          const seated = room.seatIds.length > 0;
          for (const key of tileKeysIn(room.bounds)) {
            if (seated) expect(roadTiles.has(key)).toBe(false);
            // The stroll half holds for all four, and stands in for the
            // exclusion each view does in its own plan: put a bay on an aisle
            // and this fails rather than a walker strolling through the ward.
            expect(corridorTiles.has(key)).toBe(false);
          }
          // NOT A TELEPORT. A room an agent cannot walk to is a room the scene
          // would have to drop somebody into, which is the one thing the civic
          // walk must never do.
          expect(
            findOfficePath(layout, floor.lobbyTile, room.doorTile),
          ).not.toBeNull();
          for (const seatId of room.seatIds) {
            const seat = layout.seats.get(seatId);
            if (seat === undefined) continue;
            expect(
              findOfficePath(layout, floor.lobbyTile, seat.chairTile),
            ).not.toBeNull();
          }
          expectKerbPromise(room, roadTiles);
        }
      }
    });

    // Folded from office-layout-contract.test.ts: "seats every agent exactly
    // once, with every seat id unique".
    it("seats every agent exactly once, with every seat id unique and stable", () => {
      expect(layout.desks.size).toBe(n);
      for (const agentId of agentIds) {
        expect(layout.desks.has(agentId)).toBe(true);
      }

      const seatIds = new Set<string>();
      for (const seat of layout.seats.values()) {
        expect(seatIds.has(seat.seatId)).toBe(false);
        seatIds.add(seat.seatId);
      }
      for (const desk of layout.desks.values()) {
        expect(layout.seats.get(desk.seatId)).toEqual(desk);
      }
    });

    // Folded: "agrees each desk's floorIndex with the storey it physically
    // sits in".
    it("agrees each desk's floorIndex and hostId with the storey it physically sits in", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        expect(floor).toBeDefined();
        expect(floorBandContains(floor, desk.deskTile.row)).toBe(true);
        // Mission control is one mixed hall: seats keep their host, the floor
        // does not. Floor (and every per-host-storey view) still match.
        if (view.id === "mission-control") continue;
        expect(desk.hostId).toBe(floor.hostId);
      }
    });

    // Folded: "resolves every desk's roomId to a cabin whose bounds hold its
    // tile, or null".
    it("resolves every desk's roomId to a cabin whose bounds hold its tile, or null", () => {
      for (const desk of layout.desks.values()) {
        if (desk.roomId === null) continue;
        const room = layout.rooms.find(
          (candidate) => candidate.rootAgentId === desk.roomId,
        );
        expect(room).toBeDefined();
        if (room === undefined) continue;
        expect(withinRect(room.bounds, desk.deskTile)).toBe(true);
      }
    });

    // Folded: "lets every chair reach its own floor's door" - the contract's
    // reachability invariant, and the one that catches a plan that produced
    // an unreachable seat before `walkTo` ever has to fall back to teleporting.
    it("lets every chair reach its own floor's door", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        const path = findOfficePath(layout, desk.chairTile, floor.doorTile);
        expect(path).not.toBeNull();
      }
    });

    // Folded: "keeps every spot's approach tile, corridor tile and visit tile
    // walkable".
    it("keeps every spot's approach tile, corridor tile and visit tile walkable", () => {
      for (const floor of layout.floors) {
        for (const spot of floor.errandSpots) {
          expect(isWalkable(layout, spot.approachTile)).toBe(true);
        }
        for (const corridorTile of floor.corridorTiles) {
          expect(isWalkable(layout, corridorTile)).toBe(true);
        }
      }
      for (const room of layout.rooms) {
        if (room.visitTile === null) continue;
        expect(isWalkable(layout, room.visitTile)).toBe(true);
      }
    });

    // Folded: "keeps every corridor tile inside its own storey and outside
    // every room and amenity".
    it("keeps every corridor tile inside its own storey and outside every room and amenity", (context) => {
      // Mission control's one hall room IS the amphitheatre; aisle corridors
      // sit inside it. Floor-shaped "outside every cabin" does not apply.
      if (view.id === "mission-control") {
        context.skip(
          "Mission control is one hall; aisle corridors sit inside that room",
        );
        return;
      }
      for (const floor of layout.floors) {
        for (const corridorTile of floor.corridorTiles) {
          expect(floorBandContains(floor, corridorTile.row)).toBe(true);
          for (const room of layout.rooms) {
            expect(withinRect(room.bounds, corridorTile)).toBe(false);
          }
          for (const amenity of floor.amenities) {
            expect(withinRect(amenity.bounds, corridorTile)).toBe(false);
          }
        }
      }
    });

    // Folded: "names an agent that exists for every sign with an owner".
    it("names an agent that exists for every sign with an owner", () => {
      for (const sign of layout.signs) {
        if (sign.ownerAgentId === null) continue;
        expect(agentIds.has(sign.ownerAgentId)).toBe(true);
      }
    });

    // Folded: "carries a non-empty signs list and a non-empty corridorTiles
    // list per floor". Universal assertions that only check `.length >= 0`, or
    // check nothing once a set is empty, pass on an accidentally-empty
    // implementation just as happily as a correct one. These pin the sets as
    // genuinely non-empty at every scale, so an accidental regression to
    // "always empty" fails.
    it("carries a non-empty signs list and a non-empty corridorTiles list per floor", () => {
      expect(layout.signs.length).toBeGreaterThan(0);
      for (const floor of layout.floors) {
        expect(floor.corridorTiles.length).toBeGreaterThan(0);
      }
    });

    // Folded: "gives at least one room a non-null visitTile".
    it("gives at least one room a non-null visitTile", () => {
      expect(layout.rooms.length).toBeGreaterThan(0);
      const withVisit = layout.rooms.filter((room) => room.visitTile !== null);
      expect(withVisit.length).toBeGreaterThan(0);
    });
  });

  /**
   * Folded from office-layout-contract.test.ts's `action anchors` describe.
   *
   * Every non-garden action kind maps to exactly one sprite. A spot's
   * `actionTile` must be that exact sprite, standing directly above the spot in
   * the same column - which is a promise the PLAN makes to the scene, not a
   * Floor detail: a view that draws its bins somewhere else still has to say
   * where the bin it means is.
   */
  describe("action anchors", () => {
    const epic = makeTestEpic("triage", 309, 1);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );

    const ACTION_ANCHORS: ReadonlyArray<{
      readonly kind: OfficeErrandKind;
      readonly sprite: OfficeSpriteName;
    }> = [
      { kind: "bin", sprite: "bin" },
      { kind: "darts", sprite: "dartboard" },
      { kind: "water-plant", sprite: "plant" },
      { kind: "arcade", sprite: "arcade" },
      { kind: "console", sprite: "tv" },
    ];

    it.for(ACTION_ANCHORS)(
      "anchors every $kind spot with a non-null actionTile on the exact $sprite prop above it",
      ({ kind, sprite }, context) => {
        const spots = layout.floors.flatMap((floor) =>
          floor.errandSpots.filter((spot) => spot.kind === kind),
        );
        if (spots.length === 0 && viewId !== "floor") {
          context.skip(`${viewId} intentionally has no ${kind} spots`);
          return;
        }
        expect(spots.length).toBeGreaterThan(0);
        // At least one spot must actually resolve an anchor - otherwise the
        // loop below is vacuously true over an all-null set, exactly the
        // universal-assertion trap this suite exists to close.
        const anchored = spots.filter((spot) => spot.actionTile !== null);
        expect(anchored.length).toBeGreaterThan(0);
        for (const spot of anchored) {
          const tile = spot.actionTile;
          if (tile === null) continue;
          expect(tile.col).toBe(spot.tile.col);
          expect(tile.row).toBeLessThan(spot.tile.row);
          const propStandsThere = layout.props.some(
            (prop) =>
              prop.sprite.name === sprite &&
              prop.tile.col === tile.col &&
              prop.tile.row === tile.row,
          );
          expect(propStandsThere).toBe(true);
        }
      },
    );

    it("gives the garden BOTH outcomes: spots with a bench anchor and spots without one", (context) => {
      const garden = layout.floors.flatMap((floor) =>
        floor.errandSpots.filter((spot) => spot.kind === "garden"),
      );
      // D25: views without gardens intentionally skip this shared-plan case;
      // Floor remains the reference view and must keep both outcomes.
      if (garden.length === 0 && viewId !== "floor") {
        context.skip(`${viewId} intentionally has no garden spots`);
        return;
      }
      expect(garden.length).toBeGreaterThan(0);

      const withBench = garden.filter((spot) => spot.actionTile !== null);
      const withoutBench = garden.filter((spot) => spot.actionTile === null);
      // Both outcomes exist at this fixture: some garden spots sit under a
      // bench and are sat in, others are bare stroll tiles. The garden is the
      // one kind that is two things, and a view that collapsed it to one -
      // every spot a bench, or none - would break the sitting decision the
      // scene reads straight off this field.
      expect(withBench.length).toBeGreaterThan(0);
      expect(withoutBench.length).toBeGreaterThan(0);

      for (const spot of withBench) {
        const tile = spot.actionTile;
        if (tile === null) continue;
        expect(tile.col).toBe(spot.tile.col);
        expect(tile.row).toBeLessThan(spot.tile.row);
        const benchStandsThere = layout.props.some(
          (prop) =>
            prop.sprite.name === "bench" &&
            prop.tile.col === tile.col &&
            prop.tile.row === tile.row,
        );
        expect(benchStandsThere).toBe(true);
      }
    });

    it("still requires Floor to emit every action-anchor kind", (context) => {
      if (viewId !== "floor") {
        context.skip("Floor is the reference view for non-empty errand kinds");
        return;
      }
      for (const { kind } of ACTION_ANCHORS) {
        const spots = layout.floors.flatMap((floor) =>
          floor.errandSpots.filter((spot) => spot.kind === kind),
        );
        expect(spots.length).toBeGreaterThan(0);
      }
    });
  });

  // Folded from office-layout-contract.test.ts's `the two-host shape` describe.
  describe("the two-host shape", () => {
    const epic = makeTestEpic("two-hosts", 60, 1);
    const layout = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );

    it("carries each floor's own hostId on every seat that floor owns", (context) => {
      if (view.id === "mission-control") {
        context.skip(
          "Mission control is one mixed hall; seats keep hostId, the floor does not",
        );
        return;
      }
      expect(layout.floors.length).toBeGreaterThanOrEqual(2);
      for (const seat of layout.seats.values()) {
        const floor = layout.floors[seat.floorIndex];
        expect(floor).toBeDefined();
        expect(seat.hostId).toBe(floor.hostId);
      }
    });

    it("keeps every desk's tile inside its own floor's physical band", () => {
      for (const desk of layout.desks.values()) {
        const floor = layout.floors[desk.floorIndex];
        expect(floor).toBeDefined();
        expect(floorBandContains(floor, desk.deskTile.row)).toBe(true);
        expect(withinRect(floor.bounds, desk.deskTile)).toBe(true);
      }
    });

    it("seats the fixture's original root agent on the host the fixture gave it", (context) => {
      if (view.id === "mission-control") {
        context.skip(
          "Mission control is one mixed hall; the root's floor is hostless",
        );
        return;
      }
      const rootAgent = epic.agents.find((agent) => agent.id === "agent-root");
      expect(rootAgent).toBeDefined();
      expect(rootAgent?.hostId).toBe("host-a");

      const rootDesk = layout.desks.get("agent-root");
      expect(rootDesk).toBeDefined();
      if (rootDesk === undefined) return;
      expect(rootDesk.hostId).toBe("host-a");
      const floor = layout.floors[rootDesk.floorIndex];
      expect(floor.hostId).toBe("host-a");
      expect(floorBandContains(floor, rootDesk.deskTile.row)).toBe(true);
    });

    /**
     * Every host gets its own naming, one way or another. Floor names a host by
     * the cabins standing on its own storey rather than by a `host` sign - that
     * sign kind is for the views that stack several hosts' buildings where the
     * storeys themselves need a label - so this only holds views that actually
     * emit one to the letter, and is a no-op everywhere else, INCLUDING Floor
     * today. It still runs for Floor so the day a Floor-shaped host label is
     * added, this starts checking it with no edit here.
     */
    it("gives each host its own host sign, wherever the view marks hosts that way", (context) => {
      const hostSigns = layout.signs.filter((sign) => sign.kind === "host");
      if (hostSigns.length === 0) {
        context.skip(
          `${view.id} emits no host sign - Floor names a host by its cabins instead`,
        );
        return;
      }
      const hostIds = new Set(hostSigns.map((sign) => sign.hostId));
      expect(hostIds.size).toBe(2);
    });

    /**
     * Whether a character can walk from one host's door to the other's. Floor
     * keeps hosts on separate storeys and Towers stands each host's towers
     * apart; Building joins its wings with a skybridge, the only crossing;
     * Mission control seats both hosts in one hall and has no plazas to link.
     * Campus and City give each host a district in its own column band, with
     * dead columns between them that no pass ever opens - the isometric views
     * separate hosts by construction rather than by distance.
     * The record is exhaustive on purpose: a view added to the registry has to
     * say which it is before this suite compiles.
     */
    const HOST_PLAZA_LINK: Readonly<
      Record<OfficeViewId, "isolated" | "skybridge" | "one-hall">
    > = {
      floor: "isolated",
      towers: "isolated",
      building: "skybridge",
      "mission-control": "one-hall",
      campus: "isolated",
      city: "isolated",
    };

    it("links host plazas only where the view builds a skybridge", (context) => {
      const link = HOST_PLAZA_LINK[viewId];
      if (link === "one-hall") {
        context.skip(`${viewId} seats both hosts in one hall`);
        return;
      }

      // Every storey of a host shares the host's plaza door (D13), so the
      // first floor of the host is the right door on every view.
      const doorFor = (hostId: string): OfficeTilePos => {
        const floor = layout.floors.find(
          (candidate) => candidate.hostId === hostId,
        );
        if (floor === undefined) {
          throw new Error(`missing a floor for ${hostId}`);
        }
        return floor.doorTile;
      };
      const doorA = doorFor("host-a");
      const doorB = doorFor("host-b");
      const plazaPath = findOfficePath(layout, doorA, doorB);

      if (link === "isolated") {
        expect(plazaPath).toBeNull();
        return;
      }

      expect(plazaPath).not.toBeNull();
      const walkable = layout.walkable.map((row) => [...row]);
      for (const prop of layout.props) {
        if (prop.sprite.name !== "skybridge") continue;
        walkable[prop.tile.row][prop.tile.col] = false;
      }
      const withoutBridge: OfficeLayout = { ...layout, walkable };
      expect(findOfficePath(withoutBridge, doorA, doorB)).toBeNull();
    });
  });

  it("preserves seats when one status flip is planned with the previous layout", () => {
    const epic = makeTestEpic("triage", 40, 2);
    const cold = new Map<string, OfficeAgentStatus>();
    const target = epic.agents.at(1);
    if (target === undefined) throw new Error("expected a second agent");
    const hot = new Map(cold).set(target.id, "working");

    const firstPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: cold,
      previous: null,
    });
    const layoutCold = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: cold,
        overrides: { partition: firstPartition },
      }),
    );
    const hotPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: hot,
      previous: firstPartition,
    });
    const layoutHot = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: hot,
        overrides: { partition: hotPartition, previous: layoutCold },
      }),
    );

    expect(layoutHot.seats).toEqual(layoutCold.seats);
  });

  it("does not call a plan again for a status-only flip while reserves remain", () => {
    const epic = makeTestEpic("one-team", 12, 7);
    const cold = new Map<string, OfficeAgentStatus>(
      epic.agents.map((agent) => [agent.id, "idle"]),
    );
    const target = epic.agents.find((agent) => agent.parentId !== null);
    if (target === undefined) throw new Error("expected a team member");
    const hot = new Map(cold).set(target.id, "working");
    let planCalls = 0;
    const countingView = {
      ...view,
      plan: (input: OfficePlanInput) => {
        planCalls += 1;
        return view.plan(input);
      },
    };
    const scene = new OfficeScene(countingView, null);
    const coldPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: cold,
      previous: null,
    });
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: cold,
        partition: coldPartition,
      }),
    );
    expect(planCalls).toBe(1);
    const hotPartition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: hot,
      previous: coldPartition,
    });
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: hot,
        partition: hotPartition,
      }),
    );
    expect(planCalls).toBe(1);
  });

  it("leaves every existing seat's tile unchanged (or uniformly shifted) on a stable layout when an agent is appended", (context) => {
    const epic = makeTestEpic("triage", 30, 3);
    const before = view.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    if (!before.stable) {
      context.skip(
        `${view.id}'s triage-30 layout is not stable at this scale - nothing to prove an unchanged seat set against`,
      );
      return;
    }
    const grown = [
      ...epic.agents,
      {
        ...epic.agents[0],
        id: "office-plans-append-probe",
        parentId: null,
        createdAt: Number.MAX_SAFE_INTEGER,
      },
    ];
    const after = view.plan(
      planInputFor({
        agents: grown,
        statusById: epic.statusById,
        overrides: { previous: before },
      }),
    );
    const shift = after.shiftFromPrevious ?? { col: 0, row: 0 };
    for (const [seatId, seat] of before.seats) {
      const stillThere = after.seats.get(seatId);
      expect(stillThere).toBeDefined();
      if (stillThere === undefined) continue;
      expect(stillThere.chairTile).toEqual({
        col: seat.chairTile.col + shift.col,
        row: seat.chairTile.row + shift.row,
      });
    }
  });

  it("walks every character whose chair actually moved to its new seat, and leaves the rest exactly where they were, when growth reshapes an unstable layout", (context) => {
    const epic = makeTestEpic("triage", 30, 4);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition,
      }),
    );
    const before = scene.layout();
    if (before === null) throw new Error("expected a layout");
    if (before.stable) {
      context.skip(
        `${view.id}'s triage-30 layout is stable at this scale - nothing to prove a moved set against`,
      );
      return;
    }
    const beforeProjector = view.painter.projector(before);
    // Captured from the SCENE's own DRAWN characters, not `scene.locate()`:
    // for a seated agent, `locate` answers from the SEAT BOOK's effective
    // seat, not from the character - so it reports the new seat's position
    // even when nothing actually walked there. The hit region a character
    // is really drawn at is the one thing a disabled `rehomeCharacters`
    // cannot fake, because it is built from the character's own tile.
    const beforeFrame = frameOverLayout(scene, beforeProjector);
    const beforeRects = new Map(
      epic.agents.map((person) => [
        person.id,
        characterRectOf(beforeFrame, person.id),
      ]),
    );

    // A single appended solo (the earlier fixture) never disturbs an
    // existing chair on Floor or Campus: both repack by tiling cabins/rooms
    // left to right, and one more pod at the end just extends the tiling.
    // Growing an EXISTING team's lead by a whole extra team's worth of
    // members grows that team's own room/cabin footprint enough to push
    // everything packed after it - which is what actually reshuffles
    // existing chairs on both views at this fixture (verified: 27 of 30
    // pre-existing agents move at this exact scale/seed on both).
    const leadAgent = epic.agents.find((agent) => agent.id.includes("lead"));
    if (leadAgent === undefined) {
      throw new Error("expected a team lead in the triage fixture");
    }
    const grown = [
      ...epic.agents,
      ...Array.from({ length: 7 }, (_unused, index) => ({
        ...epic.agents[0],
        id: `office-plans-grow-probe-${index}`,
        parentId: leadAgent.id,
        createdAt: Number.MAX_SAFE_INTEGER - index,
      })),
    ];
    const grownPartition = partitionOfficePopulation({
      agents: grown,
      statusById: epic.statusById,
      previous: partition,
    });
    scene.sync(
      sceneInputFor({
        agents: grown,
        statusById: epic.statusById,
        partition: grownPartition,
      }),
    );
    const after = scene.layout();
    if (after === null) throw new Error("expected a layout");
    const newSeatId = after.desks.get("office-plans-grow-probe-0")?.seatId;
    expect(newSeatId).toBeDefined();

    // An isometric view's origin can move with growth even when no tile
    // does (F17, tracked separately) - fold that known, separately-scoped
    // delta out here so THIS case stays about the moved-SET, not about F17.
    const afterProjector = view.painter.projector(after);
    const originBefore = beforeProjector.project(0, 0);
    const originAfter = afterProjector.project(0, 0);
    const originDelta = {
      x: originAfter.x - originBefore.x,
      y: originAfter.y - originBefore.y,
    };
    const afterFrame = frameOverLayout(scene, afterProjector);

    // An independent oracle for "where a settled agent's CHARACTER really
    // belongs": a FRESH scene synced directly onto the grown population,
    // which never goes through a re-layout transition or `rehomeCharacters`
    // at all - a character seen for the first time is seated straight onto
    // its assigned chair the moment it appears, a path `rehomeCharacters`
    // never touches. Floor and Campus both replan purely from the agent set
    // (`stable: false`; `previous` is never read - see floor-plan.ts and
    // campus-plan.ts), so this fresh scene's drawn positions are exactly
    // what the transitioned scene above SHOULD converge to, established
    // without relying on the rehoming code path under test.
    const freshScene = new OfficeScene(view, null);
    freshScene.sync(
      sceneInputFor({
        agents: grown,
        statusById: epic.statusById,
        partition: grownPartition,
      }),
    );
    const freshFrame = frameOverLayout(freshScene, afterProjector);

    let movedCount = 0;
    let unmovedCount = 0;
    for (const seatAgent of epic.agents) {
      // Archived agents get a dust-sheeted desk, not a live character - there
      // is nothing drawn to check them against, on EITHER side of growth.
      if (seatAgent.archivedAt !== null) continue;
      // Nor are the agents the CIVIC layer moved. A crashed or waiting agent
      // is drawn in a bed or a lounge chair rather than at the desk it still
      // owns, so its drawn position answers a question about its status and
      // not about growth - `seatUnchanged` below reads `desks`, which is the
      // desk it kept the whole time. This case is about what a re-layout does
      // to a settled office, and a second, independent reason to be away from
      // a desk is not that.
      const status = epic.statusById.get(seatAgent.id);
      if (status === "failure" || status === "awaiting") continue;
      const beforeRect = beforeRects.get(seatAgent.id);
      if (beforeRect === undefined) continue;
      if (beforeRect === null) {
        throw new Error(`no drawn character for ${seatAgent.id} before growth`);
      }
      const afterRect = characterRectOf(afterFrame, seatAgent.id);
      const expectedIfUnmoved = {
        ...beforeRect,
        x: beforeRect.x + originDelta.x,
        y: beforeRect.y + originDelta.y,
      };
      const beforeSeat = before.desks.get(seatAgent.id);
      const afterSeat = after.desks.get(seatAgent.id);
      const seatUnchanged =
        beforeSeat !== undefined &&
        afterSeat !== undefined &&
        beforeSeat.chairTile.col === afterSeat.chairTile.col &&
        beforeSeat.chairTile.row === afterSeat.chairTile.row;
      if (seatUnchanged) {
        // A seat whose tile is UNCHANGED between the two plans must leave
        // its occupant's DRAWN character exactly where it was, up to the
        // origin delta - proven through the scene's own rehoming, not a
        // diff the test performs itself.
        unmovedCount += 1;
        expect(afterRect).toEqual(expectedIfUnmoved);
        continue;
      }
      // The scene actually rehomed this agent: its character now has to be
      // DRAWN at the real seat a scene loaded fresh onto the SAME final
      // layout would draw it at - not left standing at the stale pre-growth
      // spot, which is exactly what a disabled `rehomeCharacters` leaves
      // behind.
      movedCount += 1;
      expect(afterRect).toEqual(characterRectOf(freshFrame, seatAgent.id));
      expect(afterRect).not.toEqual(expectedIfUnmoved);
    }
    // The whole point of this fixture: real movement happened, and it
    // was not universal either - both outcomes are exercised.
    expect(movedCount).toBeGreaterThan(0);
    expect(unmovedCount).toBeGreaterThan(0);
  });

  it("measures exactly the size its own plan projects to", () => {
    const epic = makeTestEpic("triage", 60, 5);
    const input = planInputFor({
      agents: epic.agents,
      statusById: epic.statusById,
      overrides: {},
    });
    const layout = view.plan(input);
    const scene = new OfficeScene(view, layout);

    expect(view.measure(input)).toEqual(scene.worldSize());
  });

  it("keeps every sprite the real painter draws CONTAINED in the projector's bounds", () => {
    const epic = makeTestEpic("triage", 60, 6);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    const scene = new OfficeScene(view, null);
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition,
      }),
    );
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout");
    const projector = view.painter.projector(layout);
    const { bounds } = projector;
    const worldRect = {
      x: bounds.x - 4096,
      y: bounds.y - 4096,
      width: bounds.width + 8192,
      height: bounds.height + 8192,
    };
    const frame = scene.frame(2, worldRect);
    // The PAINTER's actual output, not the layout's declared hit boxes - a
    // sprite the painter draws taller or wider than its tile (a tower, a
    // spire) is exactly what a declared-hitbox check cannot see. The floor
    // drawables are included too - a lod-0/lod-1 block or tile sprite is as
    // real a painter output as a prop or an actor.
    const drawables = [
      ...frame.floor,
      ...(frame.world !== null
        ? frame.world.map((entry) => entry.drawable)
        : [...frame.props, ...frame.actors]),
    ];
    let sprites = 0;
    for (const drawable of drawables) {
      if (drawable.kind !== "sprite") continue;
      sprites += 1;
      const size = officeSpriteSize(drawable.sprite);
      // Full CONTAINMENT, not intersection: all four edges of the sprite's
      // box have to sit inside the bounds box, not merely touch it.
      expect(drawable.x).toBeGreaterThanOrEqual(bounds.x);
      expect(drawable.y).toBeGreaterThanOrEqual(bounds.y);
      expect(drawable.x + size.width).toBeLessThanOrEqual(
        bounds.x + bounds.width,
      );
      expect(drawable.y + size.height).toBeLessThanOrEqual(
        bounds.y + bounds.height,
      );
    }
    expect(sprites).toBeGreaterThan(0);
  });

  /**
   * (g)'s positive control: intersection alone would accept a sprite that
   * pokes almost entirely outside the bounds as long as its top-left corner
   * still touches them. Decorate the REAL painter to append one of its own
   * real sprite parts at `(bounds.right - 1, bounds.bottom - 1)` - the exact
   * reproduction the reviewer used - and prove two things about it: it is
   * genuinely present in the real frame (so the probe above is reading real
   * painter output, not a dropped part), and the containment predicate the
   * case above uses rejects it.
   */
  it("(g) rejects a real sprite the painter draws mostly outside the bounds, proving the containment check above is not just intersection", () => {
    const epic = makeTestEpic("triage", 60, 6);
    const partition = partitionOfficePopulation({
      agents: epic.agents,
      statusById: epic.statusById,
      previous: null,
    });
    let injected = false;
    const decoratedPainter: OfficePainter = {
      ...view.painter,
      seatProps: (seatLayout, seat, state, lod) => {
        const real = view.painter.seatProps(seatLayout, seat, state, lod);
        if (injected) return real;
        const realSprite = real.find(
          (entry) => entry.drawable.kind === "sprite",
        );
        if (realSprite === undefined) return real;
        injected = true;
        const overflowBounds = view.painter.projector(seatLayout).bounds;
        return [
          ...real,
          {
            ...realSprite,
            drawable: {
              ...realSprite.drawable,
              x: overflowBounds.x + overflowBounds.width - 1,
              y: overflowBounds.y + overflowBounds.height - 1,
            },
          },
        ];
      },
    };
    const scene = new OfficeScene({ ...view, painter: decoratedPainter }, null);
    scene.sync(
      sceneInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        partition,
      }),
    );
    const layout = scene.layout();
    if (layout === null) throw new Error("expected a layout");
    const { bounds } = view.painter.projector(layout);
    const worldRect = {
      x: bounds.x - 4096,
      y: bounds.y - 4096,
      width: bounds.width + 8192,
      height: bounds.height + 8192,
    };
    const frame = scene.frame(2, worldRect);
    const drawables = [
      ...frame.floor,
      ...(frame.world !== null
        ? frame.world.map((entry) => entry.drawable)
        : [...frame.props, ...frame.actors]),
    ];
    const overflow = drawables.find(
      (drawable) =>
        drawable.kind === "sprite" &&
        drawable.x === bounds.x + bounds.width - 1 &&
        drawable.y === bounds.y + bounds.height - 1,
    );
    // The overflowing sprite really did reach the frame the scene handed
    // back - injecting it into the painter was not silently dropped
    // somewhere between the painter and the frame.
    expect(overflow).toBeDefined();
    if (overflow === undefined || overflow.kind !== "sprite") return;
    const size = officeSpriteSize(overflow.sprite);
    expect(overflow.x + size.width).toBeGreaterThanOrEqual(bounds.x);
    expect(overflow.y + size.height).toBeGreaterThanOrEqual(bounds.y);
    expect(overflow.x).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(overflow.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    // It intersects the bounds (the four checks above, an intersection
    // predicate, all pass) - and containment must still reject it, because
    // almost its whole box lies past the bounds' right and bottom edges.
    const contained =
      overflow.x >= bounds.x &&
      overflow.y >= bounds.y &&
      overflow.x + size.width <= bounds.x + bounds.width &&
      overflow.y + size.height <= bounds.y + bounds.height;
    expect(contained).toBe(false);
  });
});

describe("floor civic sign width", () => {
  it("equals the room's span from its sign tile to its right wall, and the archive's is 4", () => {
    // Measured on two-hosts: Lounge went 2 → 7 tiles (13 at 309),
    // Infirmary 2 → 6, Front desk stays 2, Archive 2 → 4. This pins
    // the RULE, not those numbers: the span is derived from the room's
    // own bounds and sign tile, and only the archive's 4 is a literal
    // (its bounds are the one-tile records door).
    const epic = makeTestEpic("two-hosts", 80, 1);
    const layout = OFFICE_VIEWS.floor.plan(
      planInputFor({
        agents: epic.agents,
        statusById: epic.statusById,
        overrides: {},
      }),
    );
    const civicSigns = layout.signs.filter((sign) => sign.kind === "civic");
    expect(civicSigns.length).toBeGreaterThan(0);
    let archives = 0;
    let rooms = 0;
    let widerThanTwo = 0;
    for (const floor of layout.floors) {
      for (const room of floor.civic) {
        const sign = civicSigns.find(
          (entry) => entry.civicRoomId === room.civicRoomId,
        );
        if (sign === undefined) {
          throw new Error(`missing civic sign for ${room.civicRoomId}`);
        }
        rooms += 1;
        if (room.kind === "archive") {
          expect(sign.widthTiles).toBe(4);
          archives += 1;
          continue;
        }
        const span = room.bounds.col + room.bounds.cols - room.signTile.col;
        expect(sign.widthTiles).toBe(span);
        if (span > 2) widerThanTwo += 1;
      }
    }
    expect(rooms).toBeGreaterThan(0);
    expect(archives).toBeGreaterThan(0);
    // A suite that only ever saw the two-tile help desk would not be
    // testing the span rule at all.
    expect(widerThanTwo).toBeGreaterThan(0);
  });
});

/**
 * THE GUARD ON THE FLOOR-FIRST POOL: a storey that belongs to one host isolates
 * its rooms exactly as it always did.
 *
 * A civic want reads the agent's own STOREY before its building, so that Mission
 * control's one hall - a single floor serving every host, whose seats therefore
 * carry no host - can seat a host-bound agent at all. In the Floor, Towers and
 * Building a storey belongs to exactly one host, so that clause admits nothing
 * those views did not already admit: the seats on your floor are your host's
 * seats by construction.
 *
 * ASSERTED RATHER THAN ASSUMED, because "nothing changed here" is the half of a
 * reordering that is easy to get wrong, and the wrong fix for the hall - making
 * `null` a wildcard, or the floor preference a free-for-all - passes every case
 * about the hall and fails this one. The falsifier is a ward that is FULL on one
 * host while another host's ward has beds going spare: the overflowing agent
 * keeps its desk (C2 - capacity is the cap) and does not cross the building line
 * to lie down.
 */
describe.each(["floor", "towers", "building"] as const)(
  "%s: a civic claim never crosses to another host's storey",
  (viewId) => {
    it("leaves an agent at its desk when its own ward is full, beds free next door", () => {
      const epic = makeTestEpic("two-hosts", 120, 7);
      const partition = partitionOfficePopulation({
        agents: epic.agents,
        statusById: epic.statusById,
        previous: null,
      });
      const view = OFFICE_VIEWS[viewId];
      const layout = view.plan({
        agents: epic.agents,
        partition,
        occupancy: new Map<string, string>(),
        needsCapacity: [],
        activityById: new Map<string, number>(),
        viewport: { width: 1040, height: 700 },
        previous: null,
      });

      const wards = layout.floors
        .map((floor) => floor.civic.find((room) => room.kind === "infirmary"))
        .filter((room): room is OfficeCivicRoom => room !== undefined);
      // Two hosts, two wards, and each ward's seats attributed to its own
      // storey's host - which is the premise the isolation rests on.
      expect(wards.length).toBeGreaterThan(1);
      const mine = wards[0];
      const theirs = wards[1];
      expect(mine.hostId).not.toBe(theirs.hostId);
      expect(mine.hostScope).toBe("host");
      expect(theirs.seatIds.length).toBeGreaterThan(0);

      const mineHost = mine.hostId;
      // EVERY ONE OF THIS HOST'S DESK AGENTS CRASHES, rather than one more than
      // the ward holds: how many of them there are is a fact about the fixture
      // and each view packs it differently, so taking a slice left one view with
      // no real overflow at all and the case vacuous there.
      //
      // AT A DESK, NOT IN A CUBBY. A cold agent in the quiet stack has no
      // character on the floor and the civic pass only serves agents that do, so
      // a cubby agent here would be a patient that never asks - measured: with
      // them in the set, three of four crashes reached the book and the fourth
      // was never offered a bed by anything.
      const patients = epic.agents
        .filter((agent) => agent.hostId === mineHost)
        .filter((agent) => {
          const desk = layout.desks.get(agent.id);
          return desk !== undefined && desk.kind !== "cubby";
        });
      expect(patients.length).toBeGreaterThan(mine.seatIds.length);

      const scene = new OfficeScene(view, null);
      const base = sceneInputFor({
        agents: epic.agents,
        statusById: new Map(
          epic.agents.map((agent) => [agent.id, "working" as const]),
        ),
        partition,
      });
      scene.sync(base);
      const statusById = new Map(base.statusById);
      for (const patient of patients) statusById.set(patient.id, "failure");
      scene.sync({ ...base, statusById });

      // THE TALLY AND NOT THE WORD, because both storeys' wards are called the
      // same thing in all three of these views - "Infirmary", "Dispensary" - so
      // an agent that had crossed the building line would read as being in its
      // own ward. The count is keyed by ROOM and cannot be confused that way.
      const tally = scene.civicTally();
      expect(tally.occupiedByRoom.get(mine.civicRoomId)).toBe(
        mine.seatIds.length,
      );
      // THE WHOLE POINT: beds going spare one host over, and nobody in them.
      expect(theirs.seatIds.length).toBeGreaterThan(0);
      expect(tally.occupiedByRoom.get(theirs.civicRoomId) ?? 0).toBe(0);

      // And the overflow kept its desk rather than being dropped somewhere: C2,
      // capacity is the cap, and an agent that finds the ward full stays put
      // with its glyph up.
      const inWard = patients.filter(
        (patient) => scene.whereabouts(patient.id) === mine.name,
      );
      expect(inWard.length).toBe(mine.seatIds.length);
      expect(patients.length - inWard.length).toBeGreaterThan(0);
    });
  },
);
