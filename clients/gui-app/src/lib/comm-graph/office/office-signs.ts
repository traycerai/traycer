/**
 * WHAT THE LETTERING SAYS, and where it goes.
 *
 * A sign is placed by the plan and read at the cursor, which is why it cannot
 * live in either alone: `layout.signs` knows the tile and the owner, and only
 * the renderer knows who exists right now and what they are called. This module
 * is the join, kept pure and out of the component so the rule can be tested
 * without a canvas - and so a view's own regression can call the real resolver
 * rather than a copy of it.
 *
 * Three things happen here that used to be scattered through the draw calls:
 *
 * - **Projection.** An anchor is the sign's tile PUT THROUGH the view's
 *   projector. Raw `tile.col * OFFICE_TILE` is right only for a view whose
 *   projector is the identity, which every view was until Campus and City;
 *   on those two, every plate rendered off its own cabin.
 * - **Semantic zoom.** Overview draws no lettering at all: a two-tile board is
 *   five screen pixels there and the plate its text needs is wider than the
 *   room it names.
 * - **Boards read the cursor.** A roster counts the agents that exist AS OF the
 *   cursor, never the whole planned membership, or a board announces people who
 *   have not been created yet.
 */
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { officeFloorName } from "@/lib/comm-graph/office/office-floor-name";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeAgentStatus,
  OfficeFloor,
  OfficeLod,
  OfficePoint,
  OfficeSign,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/** One sign, resolved: where it is, and what it says right now. */
export interface OfficeSignToDraw {
  readonly sign: OfficeSign;
  readonly text: string;
  /**
   * The owner's role claim, drawn under the name at close-up. `null` where
   * nobody has claimed one - which is most agents, so the plate is a name
   * alone unless somebody has said otherwise.
   */
  readonly subtext: string | null;
  /** The sign's own tile, projected. Both the plate and its text hang off this. */
  readonly anchor: OfficePoint;
}

/** A storey's name over its stairwell, already projected. */
export interface OfficeFloorSignToDraw {
  readonly text: string;
  readonly anchor: OfficePoint;
}

/**
 * How wide the PLATE for this text would be, in screen pixels.
 *
 * Supplied by the renderer, because only the renderer has the font: the plate
 * is set in a bold tracked-out monospace it owns, and a character count is not
 * a width - a six-tile board is ninety-six pixels across and its full count
 * reading measured nearly three hundred, so every one of them overflowed the
 * room it was naming while a character budget said it fit.
 *
 * A board is the one sign whose text is a SUMMARY rather than a name, so it
 * can be said at several lengths and the widest that fits is the one to use.
 * Names cannot do this - "Platform" abbreviated is not a name any more - so
 * they keep the ellipsis they have always had.
 */
export type OfficePlateMeasure = (text: string) => number;

/**
 * THE FACE A PLATE IS SET IN, declared here rather than in the renderer.
 *
 * The resolver decides a board's reading by measuring it, so the typography
 * that decides the measurement belongs beside the rule that consumes it -
 * otherwise the two drift and the ladder is picked in a face the plate is not
 * drawn in. The renderer still owns the drawing; it reads these to set the
 * context up, and `signPlateMeasure` is the only thing that measures.
 *
 * The tracking is part of the width. `ctx.letterSpacing` is applied by
 * `measureText` as well as by `fillText`, so a model of this face that leaves
 * it out under-reports every plate by eight percent - which is the difference
 * between a rung that fits and one that overflows the room it names.
 */
export const OFFICE_SIGN_FONT_PX = 10;
export const OFFICE_SIGN_PADDING_X = 4;
export const OFFICE_SIGN_LETTER_SPACING_EM = 0.08;
export const OFFICE_SIGN_MONOSPACE_STACK =
  "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Hottest first, as the directory orders its own rows. */
const STATUS_HEAT: Readonly<Record<OfficeAgentStatus, number>> = {
  attention: 0,
  failure: 1,
  working: 2,
  awaiting: 3,
  background: 4,
  idle: 5,
  archived: 6,
};

/** How many agents an HQ board names. Always this many, never fewer that fit. */
const HQ_BOARD_NAMES = 5;

interface BoardCounts {
  readonly doing: number;
  readonly waiting: number;
  readonly idle: number;
  readonly archived: number;
}

function countRoster(
  agentIds: ReadonlyArray<string>,
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
): BoardCounts {
  let doing = 0;
  let waiting = 0;
  let idle = 0;
  let archived = 0;
  for (const agentId of agentIds) {
    const status = statusById.get(agentId) ?? "idle";
    if (status === "working" || status === "background") doing += 1;
    else if (status === "archived") archived += 1;
    else if (status === "idle") idle += 1;
    else waiting += 1;
  }
  return { doing, waiting, idle, archived };
}

/**
 * The same reading at three lengths, widest first. Every one of them says all
 * four numbers: a board that dropped a category to fit would be lying about the
 * room rather than abbreviating.
 */
function boardRenderings(counts: BoardCounts): ReadonlyArray<string> {
  const { archived, doing, idle, waiting } = counts;
  const full = [`${doing} doing`, `${waiting} waiting`, `${idle} idle`];
  const short = [`${doing}D`, `${waiting}W`, `${idle}I`];
  if (archived > 0) {
    full.push(`${archived} archived`);
    short.push(`${archived}A`);
  }
  return [full.join(" · "), short.join(" · "), short.join(" ")];
}

/** The widest rendering that fits, or the narrowest when none does. */
function widestThatFits(args: {
  readonly renderings: ReadonlyArray<string>;
  readonly available: number;
  readonly measure: OfficePlateMeasure;
}): string {
  const { available, measure, renderings } = args;
  for (const text of renderings) {
    if (measure(text) <= available) return text;
  }
  return renderings[renderings.length - 1];
}

/**
 * One name at three lengths, widest first: as written, its first word, its
 * initials. A name is shortened rather than dropped, because the board exists
 * to say WHO needs the lead and half a roster does not say it.
 */
function nameRungs(name: string): ReadonlyArray<string> {
  const words = name.split(" ").filter((word) => word !== "");
  // A ONE-WORD name keeps its word at every rung. "Zeta" abbreviated to "Z"
  // names nobody, and a board of single letters is a board of no names at all
  // - the separators are where the last of the width comes from instead.
  if (words.length <= 1) return [name, name, name];
  const initials = words.map((word) => word.slice(0, 1)).join("");
  return [name, words[0], initials];
}

function compareHeat(
  left: string,
  right: string,
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
): number {
  const leftHeat = STATUS_HEAT[statusById.get(left) ?? "idle"];
  const rightHeat = STATUS_HEAT[statusById.get(right) ?? "idle"];
  if (leftHeat !== rightHeat) return leftHeat - rightHeat;
  // Ties break by id so two runs of one office agree with each other.
  return left < right ? -1 : 1;
}

/**
 * The HQ board names the five hottest agents rather than counting them.
 *
 * HQ overlooks the whole office, and "who needs me" is what its board is for -
 * a count of idle agents is the one thing a lead standing there does not need.
 * All five are listed whatever the width: an omitted name is an agent the
 * board failed to raise, which is worse than an abbreviated one.
 */
function hqBoardText(args: {
  readonly agentIds: ReadonlyArray<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly available: number;
  readonly measure: OfficePlateMeasure;
}): string {
  const { agentIds, available, measure, nameById, statusById } = args;
  const hottest = [...agentIds]
    .sort((left, right) => compareHeat(left, right, statusById))
    .slice(0, HQ_BOARD_NAMES);
  const named: string[] = [];
  for (const agentId of hottest) {
    const name = nameById.get(agentId);
    if (name === undefined) continue;
    named.push(name);
  }
  // Nobody is named yet at this cursor: the board falls back to counting,
  // which is a true statement about the room rather than an empty plate.
  if (named.length === 0) {
    return widestThatFits({
      renderings: boardRenderings(countRoster(agentIds, statusById)),
      available,
      measure,
    });
  }
  // EVERY ENTRY, AT WHATEVER LENGTH FITS. The rungs shorten all of them
  // together - written, first name, initials, then initials without the
  // separators - so a narrow board says less about each agent and never less
  // about how many of them need the lead.
  const rungs = named.map(nameRungs);
  const renderings = [
    rungs.map((rung) => rung[0]).join(" · "),
    rungs.map((rung) => rung[1]).join(" · "),
    rungs.map((rung) => rung[2]).join(" · "),
    rungs.map((rung) => rung[2]).join(" "),
  ];
  return widestThatFits({ renderings, available, measure });
}

/**
 * What one board says, laid out to its own width and filtered at the cursor.
 *
 * Exported because both the resolver and the views' own regressions want it
 * without a sign around it.
 */
export function officeBoardText(args: {
  readonly sign: OfficeSign;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly nameById: ReadonlyMap<string, string>;
  /** The board's own width on screen, in the same pixels `measure` returns. */
  readonly available: number;
  readonly measure: OfficePlateMeasure;
}): string {
  const { available, measure, nameById, sign, statusById, visibleAgentIds } =
    args;
  // AS OF THE CURSOR. The plan lists everyone the board will ever summarise;
  // an agent created later does not exist here yet and must not be counted,
  // least of all as an idle one.
  const roster = sign.agentIds.filter((agentId) =>
    visibleAgentIds.has(agentId),
  );
  if (sign.kind === "hq-board") {
    return hqBoardText({
      agentIds: roster,
      statusById,
      nameById,
      available,
      measure,
    });
  }
  return widestThatFits({
    renderings: boardRenderings(countRoster(roster, statusById)),
    available,
    measure,
  });
}

/** A board's own width on screen: its tiles, through the camera's zoom. */
export function officeBoardWidthPx(sign: OfficeSign, zoom: number): number {
  return Math.max(1, sign.widthTiles) * OFFICE_TILE * zoom;
}

/**
 * The door plate's second line: what this agent has CLAIMED to be doing, in
 * its own words.
 *
 * The first claim only. A plate is two tiles wide and a list of roles on it
 * would be unreadable at any zoom; the hover card carries the rest.
 */
function roleClaimOf(
  roleClaims: Readonly<Record<string, readonly RoleClaim[]>>,
  owner: string | null,
): string | null {
  if (owner === null) return null;
  if (!Object.hasOwn(roleClaims, owner)) return null;
  return roleClaims[owner].at(0)?.role ?? null;
}

/** What one non-board sign says: the owner's name, or a host's. */
function signTextOf(args: {
  readonly sign: OfficeSign;
  readonly owner: string | null;
  readonly nameById: ReadonlyMap<string, string>;
  readonly hostNameById: ReadonlyMap<string, string>;
}): string {
  const { hostNameById, nameById, owner, sign } = args;
  if (sign.text === "") return officeFloorName(sign.hostId, hostNameById);
  if (owner === null) return sign.text;
  return nameById.get(owner) ?? sign.text;
}

export function officeSignsToDraw(args: {
  readonly signs: ReadonlyArray<OfficeSign>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly roleClaims: Readonly<Record<string, readonly RoleClaim[]>>;
  readonly projector: OfficeProjector;
  readonly lod: OfficeLod;
  /** The camera's zoom, because a board's width on screen is a camera fact. */
  readonly zoom: number;
  readonly measure: OfficePlateMeasure;
}): ReadonlyArray<OfficeSignToDraw> {
  const {
    hostNameById,
    lod,
    measure,
    nameById,
    projector,
    roleClaims,
    signs,
    statusById,
    visibleAgentIds,
    zoom,
  } = args;
  // NO LETTERING AT OVERVIEW. The block map carries the whole reading there.
  if (lod === 0) return NO_SIGNS_TO_DRAW;
  const out: OfficeSignToDraw[] = [];
  for (const sign of signs) {
    const owner = sign.ownerAgentId;
    if (owner !== null && !visibleAgentIds.has(owner)) continue;
    const anchor = projector.project(sign.tile.col, sign.tile.row);
    if (sign.kind === "board" || sign.kind === "hq-board") {
      out.push({
        sign,
        text: officeBoardText({
          sign,
          statusById,
          visibleAgentIds,
          nameById,
          available: officeBoardWidthPx(sign, zoom),
          measure,
        }),
        subtext: null,
        anchor,
      });
      continue;
    }
    // A host sign carries no text of its own: the layout knows the id and the
    // directory knows what the machine is called. Everything else says what
    // the plan wrote, re-lettered from the owner's current name.
    const text = signTextOf({ sign, owner, nameById, hostNameById });
    if (text === "") continue;
    out.push({ sign, text, subtext: roleClaimOf(roleClaims, owner), anchor });
  }
  return out;
}

/**
 * A floor's name over its stairwell. Only when the building has more than one
 * storey: with a single host the building IS the epic, and a sign over it would
 * label the obvious.
 */
export function officeFloorSignsToDraw(args: {
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly projector: OfficeProjector;
  readonly lod: OfficeLod;
}): ReadonlyArray<OfficeFloorSignToDraw> {
  const { floors, hostNameById, lod, projector } = args;
  if (lod === 0 || floors.length <= 1) return NO_FLOOR_SIGNS_TO_DRAW;
  const out: OfficeFloorSignToDraw[] = [];
  for (const floor of floors) {
    const tile = floor.stairsTile ?? {
      col: floor.bounds.col,
      row: floor.bounds.row,
    };
    // A tile to the right of the stairwell, so the name sits beside the hole
    // rather than over it - said in TILES and then projected, because "one
    // tile right" is a fact about the plan and not about the screen.
    const anchor = projector.project(tile.col + 1, tile.row);
    out.push({
      text: officeFloorName(floor.hostId, hostNameById),
      anchor,
    });
  }
  return out;
}

const NO_SIGNS_TO_DRAW: ReadonlyArray<OfficeSignToDraw> = [];
const NO_FLOOR_SIGNS_TO_DRAW: ReadonlyArray<OfficeFloorSignToDraw> = [];

/** Half a tile, for centring a sign's plate over the tiles it spans. */
export function officeSignCenterX(sign: OfficeSignToDraw): number {
  return sign.anchor.x + (sign.sign.widthTiles * OFFICE_TILE) / 2;
}
