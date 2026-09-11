/**
 * The absolute property the T2 fixup requires of the board text ladder: it
 * never emits a rung wider than the board it names, at ANY supported width
 * or zoom. `office-signs.test.ts` pins the three specific reproductions the
 * reviewer found; this file is the general property run over every real
 * view's real plan, so a fourth reproduction nobody thought to write down
 * cannot slip back in.
 */
import { describe, expect, it } from "vitest";
import { partitionOfficePopulation } from "@/lib/comm-graph/office/office-population";
import {
  OFFICE_SIGN_FONT_PX,
  OFFICE_SIGN_LETTER_SPACING_EM,
  OFFICE_SIGN_PADDING_X,
  officeBoardText,
  officeBoardWidthPx,
  officeSignsToDraw,
} from "@/lib/comm-graph/office/office-signs";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentStatus,
  OfficeLayout,
  OfficeSign,
  OfficeViewId,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_VIEW_IDS,
  OFFICE_VIEWS,
} from "@/lib/comm-graph/office/views/office-view";

/**
 * A plate's width in the face it is ACTUALLY DRAWN IN, derived the same way
 * `office-signs.test.ts` derives it rather than hard-coded: `ctx.letterSpacing`
 * counts towards `measureText` as well as the painted glyphs, so leaving the
 * tracking out under-reports every plate by the exact margin that separates a
 * rung that fits from one that overflows the room it names.
 */
const MONOSPACE_ADVANCE_EM = 0.6;
const CHAR_PX =
  OFFICE_SIGN_FONT_PX * (MONOSPACE_ADVANCE_EM + OFFICE_SIGN_LETTER_SPACING_EM);
const PLATE_PADDING_PX = OFFICE_SIGN_PADDING_X * 2;
function measure(text: string): number {
  return text.length * CHAR_PX + PLATE_PADDING_PX;
}

/** The supported lod-1 zoom range: its inclusive lower boundary, unity, and its upper end. */
const ZOOMS: ReadonlyArray<number> = [0.7, 1, 1.6];

/** Cycled onto the real population so the HQ board's named rungs are exercised. */
const SINGLE_WORD_NAMES: ReadonlyArray<string> = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
];
const TWO_WORD_NAMES: ReadonlyArray<string> = [
  "Alpha One",
  "Beta Two",
  "Gamma Three",
  "Delta Four",
  "Epsilon Five",
  "Zeta Six",
  "Eta Seven",
  "Theta Eight",
];

interface NamePool {
  readonly label: string;
  readonly names: ReadonlyArray<string>;
}

const NAME_POOLS: ReadonlyArray<NamePool> = [
  { label: "single-word", names: SINGLE_WORD_NAMES },
  { label: "two-word", names: TWO_WORD_NAMES },
];

function namesFor(
  agentIds: ReadonlyArray<string>,
  pool: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  agentIds.forEach((agentId, index) => {
    names.set(agentId, pool[index % pool.length]);
  });
  return names;
}

interface RealBoardPlan {
  readonly layout: OfficeLayout;
  /** Every board this view's real plan produced, at a real (309-agent, mixed-status) population. */
  readonly boardSigns: ReadonlyArray<OfficeSign>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly visibleAgentIds: ReadonlySet<string>;
}

/**
 * A real plan for `viewId`, built the way `office-signs.test.ts`'s
 * `realObliqueSigns` builds one, generalized to every view rather than just
 * the oblique pair: `makeTestEpic` -> `partitionOfficePopulation` -> the
 * view's own `plan`. 309 agents at a mixed roster of statuses is the
 * recording's own scale, and large enough that every view which produces a
 * board at all produces one here.
 */
function realBoardPlanFor(viewId: OfficeViewId): RealBoardPlan {
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
  const boardSigns = layout.signs.filter(
    (sign) => sign.kind === "board" || sign.kind === "hq-board",
  );
  const visibleAgentIds = new Set(epic.agents.map((agent) => agent.id));
  return { layout, boardSigns, statusById, visibleAgentIds };
}

/**
 * `null` when the rung `officeBoardText` chose fits; the offender string
 * (view, sign kind, width, zoom, name pool, the text, and both measurements)
 * otherwise. Pulled out of the four-deep loop below so that loop's own body
 * stays a single statement rather than nesting a fifth block inside it.
 */
function overflowOffenderFor(args: {
  readonly viewId: OfficeViewId;
  readonly sign: OfficeSign;
  readonly poolLabel: string;
  readonly nameById: ReadonlyMap<string, string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly zoom: number;
}): string | null {
  const {
    viewId,
    sign,
    poolLabel,
    nameById,
    statusById,
    visibleAgentIds,
    zoom,
  } = args;
  const available = officeBoardWidthPx(sign, zoom);
  const text = officeBoardText({
    sign,
    statusById,
    visibleAgentIds,
    nameById,
    available,
    measure,
  });
  const measured = measure(text);
  if (measured <= available) return null;
  return (
    `${viewId}/${sign.kind}/widthTiles=${sign.widthTiles}/zoom=${zoom}/names=${poolLabel}: ` +
    `"${text}" measures ${measured}px > ${available}px available`
  );
}

describe("board text never overflows its board - the F11 absolute property", () => {
  it("keeps every board's chosen rung within the board's own width, at every supported zoom, for every real board every real view produces", () => {
    const offenders: string[] = [];
    let combinationsChecked = 0;
    const distinctWidthTiles = new Set<number>();

    for (const viewId of OFFICE_VIEW_IDS) {
      const { boardSigns, statusById, visibleAgentIds } =
        realBoardPlanFor(viewId);
      for (const pool of NAME_POOLS) {
        const nameById = namesFor([...visibleAgentIds], pool.names);
        for (const sign of boardSigns) {
          distinctWidthTiles.add(sign.widthTiles);
          for (const zoom of ZOOMS) {
            combinationsChecked += 1;
            const offender = overflowOffenderFor({
              viewId,
              sign,
              poolLabel: pool.label,
              nameById,
              statusById,
              visibleAgentIds,
              zoom,
            });
            offenders.push(...(offender === null ? [] : [offender]));
          }
        }
      }
    }

    // Not vacuous: real boards, at more than one width, were actually
    // exercised - otherwise an empty `offenders` array would prove nothing.
    expect(combinationsChecked).toBeGreaterThan(0);
    expect(distinctWidthTiles.size).toBeGreaterThan(1);

    expect(offenders).toEqual([]);
  });

  it("sees at least one board-producing view and knows which views produce none", () => {
    // Not every registered view places a `board`/`hq-board` sign at all -
    // Floor, Campus and City currently name their rooms with a `plate` sign
    // instead and carry no summary board. Recorded as an explicit assertion
    // rather than left implicit, so a view that starts emitting boards (or
    // stops) is a deliberate, visible change to this suite rather than a
    // silent shift in what the property above actually covers.
    const viewsWithBoards = OFFICE_VIEW_IDS.filter(
      (viewId) => realBoardPlanFor(viewId).boardSigns.length > 0,
    );
    expect(viewsWithBoards).toEqual(["towers", "building", "mission-control"]);
  });

  it("mission control's board sign is always the HQ board, never a plain per-team board", () => {
    const { boardSigns } = realBoardPlanFor("mission-control");
    expect(boardSigns.length).toBeGreaterThan(0);
    expect(boardSigns.every((sign) => sign.kind === "hq-board")).toBe(true);
  });

  it("drops a one-tile board's sign entry entirely at the lowest lettered zoom, and draws one again once the zoom clears it (officeSignsToDraw, not just officeBoardText)", () => {
    // The measured-text property above cannot see this half of the fix: at
    // the lowest zoom a one-tile board's chosen rung is now the EMPTY
    // string, and `officeBoardText` alone never says whether an empty rung
    // became a blank plate or no sign entry at all. `officeSignsToDraw` is
    // the one that decides that, so this case calls the real resolver.
    const viewId: OfficeViewId = "towers";
    const { layout, statusById, visibleAgentIds } = realBoardPlanFor(viewId);
    const oneTileBoard = layout.signs.find(
      (sign) => sign.kind === "board" && sign.widthTiles === 1,
    );
    if (oneTileBoard === undefined) {
      throw new Error(
        `expected ${viewId}'s real plan to place a one-tile board sign`,
      );
    }
    const nameById = namesFor([...visibleAgentIds], SINGLE_WORD_NAMES);
    const projector = OFFICE_VIEWS[viewId].painter.projector(layout);
    const drawnAt = (zoom: number) =>
      officeSignsToDraw({
        signs: [oneTileBoard],
        visibleAgentIds,
        statusById,
        nameById,
        hostNameById: new Map(),
        roleClaims: {},
        projector,
        lod: 1,
        zoom,
        measure,
      });

    // The failure text this reproduced before the fix: `officeBoardText`
    // returning "…" at 14.8px against an 11.2px board. Below the fix's
    // empty-rung/dropped-entry pair, this drew a bare 14.8px-wide plate
    // over 11.2px of board - painted over whatever sits beside it.
    const atLowestZoom = drawnAt(0.7);
    expect(atLowestZoom).toEqual([]);

    // The control: at zoom 1 the same board has 16px, which clears the
    // single glyph (14.8px), so an entry IS drawn - proving the absence
    // above is the fit rule and not `officeSignsToDraw` dropping every
    // one-tile board unconditionally.
    const atUnitZoom = drawnAt(1);
    expect(atUnitZoom).toHaveLength(1);
    expect(atUnitZoom[0].sign).toBe(oneTileBoard);
    expect(atUnitZoom[0].text.length).toBeGreaterThan(0);
  });
});
