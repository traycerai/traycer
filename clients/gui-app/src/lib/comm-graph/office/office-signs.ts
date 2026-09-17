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
 * Four things happen here that used to be scattered through the draw calls:
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
 * - **A plate fits the room it names.** The plate is drawn at a fixed face and
 *   centred on its own tiles, so the same twelve characters that sit over three
 *   desks at close-up are wider than a two-desk pod at office zoom - and the
 *   drawing step, given a reading too long for the room, centres it anyway and
 *   paints the pod next door. A sign that declares a ladder comes down it here,
 *   where the measured face is, and is dropped rather than drawn over its
 *   neighbour when even the last rung is too wide. The one exception is a
 *   CIVIC sign, whose last rung is the room's own word: a ward is an area with
 *   floor around it rather than one of a dense row of pods, so its name
 *   overflows its tiles exactly as `CAFETERIA` always has.
 * - **A civic sign says what is inside the room.** Its counter is read off the
 *   seat book and the partition at the cursor, never written by a plan, and
 *   one ward's sign carries a beacon whose frame this module chooses.
 */
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { officeFloorName } from "@/lib/comm-graph/office/office-floor-name";
import { OFFICE_TILE } from "@/lib/comm-graph/office/office-types";
import type {
  OfficeAgentStatus,
  OfficeCivicRoom,
  OfficeCivicTally,
  OfficeFloor,
  OfficeLod,
  OfficePoint,
  OfficeSign,
} from "@/lib/comm-graph/office/office-types";
import type { OfficeProjector } from "@/lib/comm-graph/office/views/office-view";

/**
 * WHAT A SIGN IS FIXED TO, which decides both whether it has a board and where
 * its lettering sits.
 *
 * `wall` is a board hung on a wall face, with the lettering ON the board -
 * every cabin sign, pod plate, area name and roster board, and a civic room
 * that is walled. The board lands on structure because there is structure
 * there to land on.
 *
 * `floating` is lettering alone, hung in the air just above the room it names.
 * It exists because THREE QUARTERS of the civic rooms are `enclosure: "open"`
 * - a plaza ward, a row of waiting chairs, a reception counter - and an open
 * room has no wall for a board to hang on. Hanging one anyway put it on the
 * room's own first row, which is the row the room is FURNISHED along: the
 * Dispensary's board stood in a bed and hid the agent lying in it, the waiting
 * room's took a chair, and the front desk's collected the name tag of whoever
 * was standing at the counter. A room label belongs over the room, not in it.
 *
 * A floating mount CARRIES ITS OWN CLEARANCE rather than leaving the renderer
 * to infer one from the anchor, because the two are not the same point and the
 * difference is a whole row. A sign's tile is not always its room's first row:
 * all four help desks letter from the row BELOW their box's top (the sign sits
 * on the counter, the queue stands above it), so a lift measured from the
 * anchor clears the counter and sets the plate straight back down in the queue
 * - the exact overlap this mount exists to end. Making the clearance part of
 * the mount is what stops a future floating sign from being added without one.
 */
export type OfficeSignMount =
  | { readonly kind: "wall" }
  | {
      readonly kind: "floating";
      /**
       * World-space `y` the plate has to clear: the top of the room's own
       * first row, taken at THIS sign's column, and never below the sign's
       * own tile - Campus's waiting room and the oblique archive already
       * letter from above their box, and clamping them down to it would
       * undo a lift the plan had already made.
       */
      readonly clearWorldY: number;
    };

/**
 * The mount every board-on-a-wall sign shares. One frozen value rather than a
 * literal per sign: this resolver runs per frame over every visible agent's
 * name plate, and at a thousand agents that is a thousand allocations a frame
 * for a value with no fields to vary.
 */
const WALL_MOUNT: OfficeSignMount = { kind: "wall" };

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
  /**
   * Which frame of the beacon this sign carries, or `null` for the signs that
   * carry none - which is all of them but one ward's.
   *
   * A NUMBER RATHER THAN A SPRITE NAME, because the art is the renderer's and
   * the cadence is this module's: the resolver is where the room's occupancy
   * and the clock meet, and it has no business naming pixel maps.
   */
  readonly sirenFrame: 0 | 1 | null;
  /** Board on a wall, or lettering hung over the room. */
  readonly mount: OfficeSignMount;
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
 * The mark a board falls back to when not even a bare count fits its pixels.
 * One character, so it fits the narrowest plate any real board ever has.
 */
const BOARD_OVERFLOW_GLYPH = "…";

/**
 * THE MOST CHARACTERS A PLATE CAN CARRY, whatever its pixels allow.
 *
 * The renderer cuts a name-bearing plate to a character budget of its own
 * before it draws it, and it does so AFTER the reading has been chosen - so a
 * rung that fits the room in pixels but runs past this budget is cut mid-word
 * with an ellipsis, which is exactly the `BULLPEN · 9…` the ladder exists to
 * prevent. The fit below therefore never offers a rung the drawing step would
 * cut: the ladder and the budget have to agree, and the ladder is the half
 * that can shorten a reading without lying about it.
 *
 * These are the renderer's own two numbers, and the threshold between them is
 * its own: a plate narrower than two tiles gets the smaller budget. They live
 * here because the fit is decided here, and the renderer reads them from here
 * rather than keeping a second copy - one number in two files is the same
 * disagreement in slower motion.
 */
export const OFFICE_SIGN_PLATE_MAX_CHARS = 12;
export const OFFICE_SIGN_NARROW_PLATE_MAX_CHARS = 10;
const OFFICE_SIGN_NARROW_PLATE_TILES = 2;

function plateMaxChars(widthTiles: number): number {
  return widthTiles >= OFFICE_SIGN_NARROW_PLATE_TILES
    ? OFFICE_SIGN_PLATE_MAX_CHARS
    : OFFICE_SIGN_NARROW_PLATE_MAX_CHARS;
}

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
 * The same reading at decreasing lengths, widest first. Every rung down to the
 * last pair says all four numbers: a board that dropped a category to fit would
 * be lying about the room rather than abbreviating.
 *
 * The separators go before the words do - " · " to " " to nothing at all, which
 * a letter-suffixed count survives unambiguously ("1D1W1I1A" cannot be read any
 * other way). Below that the categories genuinely cannot be kept, and the tail
 * is what any board can always show.
 */
function boardRenderings(counts: BoardCounts): ReadonlyArray<string> {
  const { archived, doing, idle, waiting } = counts;
  const full = [`${doing} doing`, `${waiting} waiting`, `${idle} idle`];
  const short = [`${doing}D`, `${waiting}W`, `${idle}I`];
  if (archived > 0) {
    full.push(`${archived} archived`);
    short.push(`${archived}A`);
  }
  return [
    full.join(" · "),
    short.join(" · "),
    short.join(" "),
    short.join(""),
    ...lastResortRungs(doing + waiting + idle + archived),
  ];
}

/**
 * What is left when no reading of the roster fits: how many there are, then a
 * mark saying the board has something on it, then nothing at all.
 *
 * THE EMPTY RUNG IS WHAT MAKES THIS A GUARANTEE. The narrowest board a plan
 * emits is the oblique views' per-team board, which is ONE tile - 11.2px at
 * zoom 0.7, the lowest zoom that draws lettering at all - and a single glyph
 * needs 14.8px of it. There is no reading of a roster that fits there, so the
 * last rung has to be the absence of one; a board with nothing it can say is
 * dropped by the resolver rather than painted as a bare plate.
 */
function lastResortRungs(total: number): ReadonlyArray<string> {
  return [`${total}`, BOARD_OVERFLOW_GLYPH, ""];
}

interface FitRequest {
  /** The same reading at decreasing lengths, widest first. */
  readonly renderings: ReadonlyArray<string>;
  readonly available: number;
  readonly measure: OfficePlateMeasure;
}

/**
 * The widest rendering that fits, or `null` when none of them does.
 *
 * The one scan in this module: a board comes down its ladder here and so does
 * a plate, because "widest that fits" is the same question about the same
 * measured face and two copies of it would drift the moment one of them was
 * taught something. What differs is the ANSWER TO NOTHING FITTING - a board
 * has a last rung it can always show, a plate is dropped - so that choice is
 * left to the two callers rather than decided here.
 */
function firstThatFits(args: FitRequest): string | null {
  const { available, measure, renderings } = args;
  for (const text of renderings) {
    if (measure(text) <= available) return text;
  }
  return null;
}

/** The widest rendering that fits, or the narrowest when none does. */
function widestThatFits(args: FitRequest): string {
  return firstThatFits(args) ?? args.renderings[args.renderings.length - 1];
}

/**
 * One name at two lengths, widest first: as written, then its first word. A
 * name is shortened rather than dropped, because the board exists to say WHO
 * needs the lead and half a roster does not say it.
 *
 * A ONE-WORD NAME HAS NOWHERE TO GO, and that is now allowed. There used to be
 * a third rung - the name's initials - so that five one-word names had
 * something narrower to fall to than the 213px "Alpha Beta Gamma Delta
 * Epsilon" they otherwise measured. What falls out of a board too narrow for
 * first names is the ROSTER'S COUNTS (see `hqBoardText`), which every board
 * can say at every width, so a name that cannot shorten now simply loses its
 * rung to the next one down instead of being lettered away to "A".
 */
function nameRungs(name: string): readonly [string, string] {
  const words = name.split(" ").filter((word) => word !== "");
  if (words.length === 0) return [name, name];
  return [name, words[0]];
}

/**
 * A label's parts and the separators between them.
 *
 * A board splits a name on spaces, because a board is naming PEOPLE and people
 * are called "Alpha One". A plate names a room after its lead, and an agent is
 * as often called `team-26-lead` as it is "Platform Team" - so the parts a
 * plate can give up are separated by hyphens as well as by spaces. The
 * separators are carried rather than normalised so a shortened reading is
 * still spelled the way the label was: `team-26`, never `team 26`.
 */
interface LabelParts {
  readonly segments: ReadonlyArray<string>;
  /** What sits between segment *i* and segment *i + 1*. */
  readonly separators: ReadonlyArray<string>;
}

/** Captured, so `split` hands back the separators along with the parts. */
const LABEL_SEPARATOR_SPLIT = /([\s-]+)/;
const LABEL_SEPARATOR_ONLY = /^[\s-]+$/;

function labelParts(label: string): LabelParts {
  const segments: string[] = [];
  const separators: string[] = [];
  for (const piece of label.split(LABEL_SEPARATOR_SPLIT)) {
    if (piece === "") continue;
    if (!LABEL_SEPARATOR_ONLY.test(piece)) {
      segments.push(piece);
      continue;
    }
    // A separator before the first segment belongs to nothing and is dropped,
    // which keeps `separators[i - 1]` the thing that precedes `segments[i]`.
    if (segments.length > 0) separators.push(piece);
  }
  return { segments, separators };
}

function joinParts(
  segments: ReadonlyArray<string>,
  separators: ReadonlyArray<string>,
): string {
  let out = "";
  for (const [index, segment] of segments.entries()) {
    if (index > 0) out += separators[index - 1] ?? " ";
    out += segment;
  }
  return out;
}

/**
 * ONE NAME AT DECREASING LENGTHS, widest first: as written, then a trailing
 * part at a time, then its leading part cut to an initial, then its initials.
 *
 * `team-26-lead` comes down `team-26`, `t-26`, `t2l`. The trailing parts go
 * first because a name is usually specific at its front - a lead's role is
 * what its team already implies - and the LAST cut keeps the tail rather than
 * the head for the same reason read the other way: `team` names every room on
 * the storey, `t-26` names this one. The board's ladder is the model
 * (`nameRungs`): shorten rather than drop, and never cut a word in half,
 * because a name cut mid-word names nobody while an abbreviated one still
 * points at somebody.
 *
 * One part at a time rather than all but the first in one step, so a name with
 * five parts has a rung near every width instead of falling from a sentence
 * straight to five letters.
 *
 * Exported for every plate that has to fit the tiles it names - the oblique
 * views' room plates today, Mission control's tier plates next.
 */
export function officePlateRungs(label: string): ReadonlyArray<string> {
  const { segments, separators } = labelParts(label);
  if (segments.length === 0) return [label];
  const rungs = [label];
  for (let kept = segments.length - 1; kept >= 2; kept -= 1) {
    rungs.push(joinParts(segments.slice(0, kept), separators));
  }
  if (segments.length >= 2) {
    rungs.push(joinParts([segments[0].slice(0, 1), segments[1]], separators));
  }
  rungs.push(segments.map((segment) => segment.slice(0, 1)).join(""));
  return rungs;
}

/**
 * THE WIDEST READING OF A PLATE THAT FITS THE TILES IT NAMES, or `null` when
 * even the narrowest overflows them.
 *
 * The width budget is the sign's own span through the camera - the same
 * arithmetic a board's width uses - because a plate is drawn at a fixed face
 * whatever the zoom while the room under it shrinks with the camera: the
 * twelve characters that sit comfortably over three desks at close-up are
 * half as wide again as the pod they name at office zoom, which is how two
 * neighbouring plates came to paint over each other.
 *
 * `null` is a real answer, not a failure: a plate whose narrowest reading is
 * still wider than its room is dropped rather than drawn over the room next
 * door, exactly as a board with nothing it can say is dropped.
 */
export function officePlateTextThatFits(args: {
  /** The same lettering at decreasing lengths, widest first. */
  readonly rungs: ReadonlyArray<string>;
  /** The plate's own span in tiles: the pod, the tier run, the room. */
  readonly widthTiles: number;
  /** The camera's zoom, because the tiles' width on screen is a camera fact. */
  readonly zoom: number;
  readonly measure: OfficePlateMeasure;
}): string | null {
  const { measure, rungs, widthTiles, zoom } = args;
  const maxChars = plateMaxChars(widthTiles);
  return firstThatFits({
    renderings: rungs.filter((text) => text.length <= maxChars),
    available: officePlateWidthPx(widthTiles, zoom),
    measure,
  });
}

/**
 * Hotter first, ties broken by id so two runs of one office agree.
 *
 * Exported for its own contract test and nothing else. A comparator has to
 * answer 0 for a pair it considers equal, and this one answered 1 for an id
 * against itself - which `Array.prototype.sort` is entitled to act on however
 * it likes, making the order implementation-defined the moment a roster
 * carries a duplicate. That is unobservable through the board text, because
 * two copies of one id read the same whichever way round they land, so the
 * only honest way to hold the rule is to state it about the comparator.
 */
export function compareHeat(
  left: string,
  right: string,
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
): number {
  const leftHeat = STATUS_HEAT[statusById.get(left) ?? "idle"];
  const rightHeat = STATUS_HEAT[statusById.get(right) ?? "idle"];
  if (leftHeat !== rightHeat) return leftHeat - rightHeat;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The HQ board names the five hottest agents while it has the pixels to letter
 * them, and COUNTS ITS ROOM once it does not.
 *
 * HQ overlooks the whole office, and "who needs me" is what its board is for -
 * a count of idle agents is the one thing a lead standing there does not need.
 * All five are listed whatever the width: an omitted name is an agent the
 * board failed to raise, which is worse than an abbreviated one.
 *
 * BELOW THE FIRST NAMES IT STOPS LETTERING. The ladder used to carry on into
 * initials - " · "-joined, then spaced, then run together - and a real HQ
 * board is eight tiles, which at office zoom is about 118px: five names never
 * fit there, so those were the rungs the office's own zoom always landed on.
 * The live sitting read `R R R R R` off the top storey of the Building, which
 * names nobody, and at that size looks like a rendering fault rather than a
 * summary. So the names hand over to the roster COUNTS the other boards
 * already use - the same reading, over the same roster, that a `board` would
 * give - which is a true statement about the room at every width.
 *
 * The board is not dropped below close-up instead. The top storey is where the
 * eye lands first, and a board that vanishes at the office's own zoom reads as
 * broken art; one that counts reads as a summary.
 */
function hqBoardText(args: {
  readonly agentIds: ReadonlyArray<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly available: number;
  readonly measure: OfficePlateMeasure;
}): string {
  const { agentIds, available, measure, nameById, statusById } = args;
  // NAMED FIRST, THEN THE TOP FIVE - not the other way round. Taking the five
  // hottest and dropping the unnamed among them leaves a gap that the
  // next-hottest NAMED agent should have filled, so a single agent the cursor
  // has no name for yet costs the board a line it could have printed. That is
  // precisely the "omitted name" the rule above refuses.
  const byHeat = [...agentIds].sort((left, right) =>
    compareHeat(left, right, statusById),
  );
  const named: string[] = [];
  for (const agentId of byHeat) {
    const name = nameById.get(agentId);
    if (name === undefined) continue;
    named.push(name);
    if (named.length === HQ_BOARD_NAMES) break;
  }
  // THE WHOLE ROSTER'S COUNTS, not the five named agents'. The rungs below the
  // names answer a different question - how the ROOM is doing - and they answer
  // it about everyone this board summarises, exactly as an ordinary `board`
  // does over the same ids. Counting only the five would make the board's
  // narrow readings disagree with its wide ones about who is on it.
  const counts = boardRenderings(countRoster(agentIds, statusById));
  // Nobody is named yet at this cursor: the board falls back to counting,
  // which is a true statement about the room rather than an empty plate.
  if (named.length === 0) {
    return widestThatFits({ renderings: counts, available, measure });
  }
  // EVERY ENTRY, AT WHATEVER LENGTH FITS. The two name rungs shorten all five
  // together - written, then first names - so a narrow board says less about
  // each agent and never fewer of them. Narrower than that it says nothing
  // about them at all and counts the room instead, down the same tail any
  // board ends on.
  const rungs = named.map(nameRungs);
  const renderings = [
    rungs.map((rung) => rung[0]).join(" · "),
    rungs.map((rung) => rung[1]).join(" · "),
    ...counts,
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

// ---- A civic room's sign -------------------------------------------- //
//
// The one sign that says what is INSIDE the room it names, which is why it is
// resolved here beside the boards rather than written by a plan: `Infirmary`
// is a plan fact, `3 of 4` is a fact about right now, and a counter baked into
// the lettering at plan time is a number that stops being true on the next
// sync.

/**
 * The band from which a civic sign carries its counter.
 *
 * OFFICE ZOOM, and it used to be close-up. The argument for holding it back
 * was that "the plate is already competing with every amenity sign on the
 * storey" - which was true, and is what {@link officeSignLetteredAt} has now
 * removed: at office zoom the amenity signs are gone, so the pixels the
 * counter needs are pixels nothing else is using.
 *
 * That trade has to go this way round rather than the other. A civic sign with
 * no counter on it says `FRONT DESK` - a fact about the floor plan that was
 * equally true last week - and feedback round 1 named exactly that reading
 * twice: "too prominent and not adding value". The counter is the whole of
 * what a ward's sign is worth at a glance, so the band that draws the sign and
 * the band that draws its number are now the same band by construction.
 */
const OFFICE_SIGN_COUNTER_LOD: OfficeLod = 1;

/** Close-up: where lettering that reports nothing is finally worth its pixels. */
const OFFICE_FIXTURE_LETTERING_LOD: OfficeLod = 2;

/**
 * WHETHER THIS SIGN IS LETTERED AT THIS BAND.
 *
 * One rule: **lettering that reports something is drawn at office zoom;
 * lettering that names a fixture waits for close-up.** A roster board's counts
 * change, a host's name says which machine you are looking at, a plate that
 * names a lead re-letters when that lead is renamed, and a ward's sign counts
 * the beds that are taken. `CAFETERIA`, `SOLO DESKS` and `FRONT DESK` say the
 * same thing they said on the first frame and will say on the last.
 *
 * This is feedback round 1, and it is four complaints rather than one: the
 * amenity plates were "too prominent", "repetitive" ( `SOLO DESKS` once per
 * storey down a tower), "not adding value", and - the one that settles it -
 * "the labels completely cover the artwork". A plate is drawn at a fixed face
 * whatever the zoom, so the further out the camera goes the more of the floor
 * each one hides; the band where the art is worth looking at is precisely the
 * band where the lettering costs the most.
 *
 * NOT A LIST OF VIEWS, and deliberately. Every view puts amenity names on its
 * floor, so a rule written about Towers and Campus would be re-discovered by
 * the next view to land. The two inputs are the sign's own kind and whether it
 * names somebody - both facts the plan already carries.
 *
 * READ THIS AS "DRAWN AT", NOT ONLY "LETTERED AT". A `false` here withholds
 * the sign's whole ENTRY, and the renderer hangs the board sprite off the same
 * entry as the text, so the plaque goes with the words. See the call site in
 * {@link officeSignsToDraw} for why that is the answer the feedback asked for
 * rather than an oversight. The one thing that outlives a `false` is a ward's
 * BEACON, which `civicSignToDraw` checks before it consults this at all: an
 * alarm is not lettering and does not wait for the camera.
 */
export function officeSignLetteredAt(args: {
  readonly sign: OfficeSign;
  readonly lod: OfficeLod;
  /**
   * For a `civic` sign: whether the reading that fits its room at this zoom
   * actually carries the room's counter. A ward too narrow to say `2 of 3`
   * here has nothing to report here, so it is a fixture like any other until
   * the camera comes in. `false` for every other kind, which never counts.
   */
  readonly civicReports: boolean;
}): boolean {
  const { civicReports, lod, sign } = args;
  // NO LETTERING AT OVERVIEW. The block map carries the whole reading there.
  if (lod === 0) return false;
  if (lod >= OFFICE_FIXTURE_LETTERING_LOD) return true;
  switch (sign.kind) {
    // Counts, and they move.
    case "board":
    case "hq-board":
      return true;
    // Which machine this part of the office belongs to - the one thing the
    // floor cannot show by drawing it.
    case "host":
      return true;
    case "civic":
      return civicReports;
    // A cabin sign, a pod plate: lettered at office zoom when it names a
    // person, silent when it names the furniture. `ownerAgentId` is what the
    // plan sets for a room with a lead and leaves `null` for a solo pod, whose
    // written plate (`Solo desks`, `Bullpen · 9 live solos`) is the repetition
    // the feedback pointed at - and whose count the BOARD beside it still
    // carries at this band.
    case "room":
    case "pod":
    case "plate":
      return sign.ownerAgentId !== null;
    // An amenity: the cafeteria is a cafeteria at every zoom.
    case "area":
      return false;
  }
}

/**
 * HOW LONG ONE FRAME OF A WARD'S BEACON IS UP.
 *
 * Mission control has no street, so no ambulance can come for the agent lying
 * in its medbay (C6) - the light on the ward's own sign is the whole of the
 * alarm there. A quarter-second is the vehicles' own cadence, stated once
 * here because the two are meant to read as the same light.
 */
export const OFFICE_SIREN_FRAME_MS = 250;

/**
 * WHAT A SIGN NEEDS TO KNOW ABOUT TIME, which is one sign's whole reason for
 * asking: the office's own animation clock, and whether the person watching
 * asked for less motion.
 *
 * The two travel together because neither is any use to a sign alone - a clock
 * with no preference beside it would blink at a reader who asked it not to,
 * and a preference with no clock could not blink at all.
 */
export interface OfficeSignClock {
  /** The scene's animation clock (`OfficeScene.animationClockMs`). */
  readonly nowMs: number;
  /** `prefers-reduced-motion`, as the scene was last synced with. */
  readonly reducedMotion: boolean;
}

/**
 * THE BEACON'S TWO FRAMES, as a contract with the art: **0 is the dark lens
 * and 1 is the lit one.**
 *
 * Three states have to be told apart with two frames, which is what fixes the
 * meaning of each:
 *
 * - an EMPTY ward is frame 0 at every clock - a lamp that is there and is not
 *   telling anybody to hurry;
 * - an OCCUPIED ward alternates, which is the alarm;
 * - an occupied ward under REDUCED MOTION holds frame 1. Somebody who asked
 *   for less motion should not be shown a flashing sign, and holding the dark
 *   frame instead would make an occupied ward indistinguishable from an empty
 *   one for exactly the reader who cannot watch it blink.
 */
const SIREN_DARK_FRAME = 0;
const SIREN_LIT_FRAME = 1;

/**
 * WHAT ONE CIVIC SIGN COUNTS, or `null` where its room counts nothing.
 *
 * Three rules, one per kind that has one:
 *
 * - a ward or a waiting room says how many of ITS OWN seats are taken, because
 *   "is there a bed free" is the question somebody looking at it has;
 * - the archive says how many records it holds, which is its whole content
 *   (C5: no crate per agent, the number is the room) - ITS OWN host's records
 *   in a view whose storeys belong to one host each, and every host's in a view
 *   whose one floor serves them all. `room.hostScope` is what says which, and
 *   it is a field rather than a reading of `hostId` because `null` there is the
 *   unattributed host - a real host with records of its own - so a shared room
 *   and an unattributed one are indistinguishable by that field alone;
 * - the help desk says nothing. The queue standing in front of it is the
 *   count, drawn at full size, and a number over it would be the same fact
 *   said twice.
 */
/**
 * HOW MANY RECORDS THIS ARCHIVE HOLDS, over the hosts its room serves.
 *
 * The tally is kept per host because that is what the population knows, and a
 * room's scope is what turns those per-host counts into the one number on its
 * door. The occupancy half needs nothing like this: `occupiedByRoom` is already
 * keyed by the room, so a shared ward's seats are counted once whoever is in
 * them.
 */
function archivedFor(room: OfficeCivicRoom, tally: OfficeCivicTally): number {
  if (room.hostScope === "host") {
    return tally.archivedByHost.get(room.hostId) ?? 0;
  }
  let total = 0;
  for (const count of tally.archivedByHost.values()) total += count;
  return total;
}

function civicCounterOf(
  room: OfficeCivicRoom,
  tally: OfficeCivicTally,
): string | null {
  if (room.kind === "help-desk") return null;
  if (room.kind === "archive") {
    return `${archivedFor(room, tally)}`;
  }
  // A room a view could not fit any seats into counts nothing rather than
  // saying `0 of 0`, which reads as a fault in the floor plan.
  if (room.seatIds.length === 0) return null;
  const taken = tally.occupiedByRoom.get(room.civicRoomId) ?? 0;
  return `${taken} of ${room.seatIds.length}`;
}

/**
 * ONE CIVIC SIGN AT TWO LENGTHS, widest first: the room and its count, then
 * the room alone.
 *
 * **THE WORD IS THE FLOOR.** A civic sign is never dropped and never comes
 * down to a glyph: a room's name is the one thing on it that is true at every
 * width, and a civic room is an AREA - every `area` plate on a Floor storey
 * already says `CAFETERIA` across two tiles of wall and overflows them without
 * anybody minding. What a plate is dropped for is two POD plates overprinting
 * each other in a dense row, which a ward and a lounge two columns apart are
 * not. So the COUNTER is the only rung that gives way, and the help desk - two
 * tiles of counter row, `Front desk` at 76 px against 51 at close-up - reads
 * its own name rather than `…` at every zoom in every view.
 */
function civicRungs(
  name: string,
  counter: string | null,
): ReadonlyArray<string> {
  if (counter === null) return [name];
  return [`${name} · ${counter}`, name];
}

/** What one civic sign says, and whether saying it told the reader anything. */
export interface OfficeCivicSignReading {
  readonly text: string;
  /**
   * Whether `text` carries the room's counter. `false` for a room that counts
   * nothing (the help desk, whose queue IS the count) and for one whose tiles
   * were too narrow for the number at this zoom - both of which leave the sign
   * saying only its own unchanging word.
   */
  readonly reports: boolean;
}

/**
 * WHAT ONE CIVIC SIGN SAYS at this band and this zoom. Never `null`: see the
 * ladder above - the room's word is drawn whether or not it fits.
 *
 * Exported for the same reason `officeBoardText` is: the rule is worth testing
 * without a camera around it, and a view's own regression should be able to
 * call the real resolver rather than a copy of it.
 *
 * NO CHARACTER BUDGET, and that is deliberate rather than an oversight. The
 * budget on a NAME plate (`plateMaxChars`) exists to keep the ladder in step
 * with the renderer's own ellipsis - it cuts a name-bearing plate to twelve
 * characters after the reading has been chosen, so a rung longer than that
 * would come out as `BULLPEN · 9…`. A civic sign is a SUMMARY, like a board:
 * the renderer draws it as chosen and truncates nothing, so the only budget
 * that applies to it is the one the room's own tiles impose. Move one half and
 * the other has to move with it; they are `signPlateText`'s two branches.
 */
export function officeCivicSignText(args: {
  readonly room: OfficeCivicRoom;
  readonly tally: OfficeCivicTally;
  readonly lod: OfficeLod;
  /** The sign's own span in tiles, as the plan placed it. */
  readonly widthTiles: number;
  readonly zoom: number;
  readonly measure: OfficePlateMeasure;
}): OfficeCivicSignReading {
  const { lod, measure, room, tally, widthTiles, zoom } = args;
  const counter =
    lod < OFFICE_SIGN_COUNTER_LOD ? null : civicCounterOf(room, tally);
  const text = widestThatFits({
    renderings: civicRungs(room.name, counter),
    available: officePlateWidthPx(widthTiles, zoom),
    measure,
  });
  // THE READING THAT FITS, not the counter that was offered. A room whose
  // tiles have no pixels for `2 of 3` comes down to its own word, which is a
  // fixture reading however live the number behind it was - and at office zoom
  // that is the difference between a sign and a label over the artwork.
  return { text, reports: counter !== null && text !== room.name };
}

/**
 * WHICH FRAME OF THE BEACON A WARD'S SIGN SHOWS, or `null` for a sign that
 * carries no beacon.
 *
 * A ward carries one exactly where NO AMBULANCE CAN COME: decision C6 gives
 * every view with a street a vehicle and gives the one without - Mission
 * control, whose amphitheatre has no road - a light on the medbay's own sign
 * instead. Derived from the room and its storey rather than from a table of
 * view names, so a later view that plans a ward on a roadless floor lights up
 * without a line of code here.
 *
 * The clock is the scene's, and the cadence is the vehicles' (250 ms), so the
 * light in the amphitheatre and the light on the road read as the same alarm.
 * An empty ward rests on the dark frame: nothing is happening, and a lamp
 * going round over an empty bed would be an alarm about nobody. Under reduced
 * motion the lit frame is HELD instead of alternating - see the frame
 * constants for why it is the lit one and not the dark.
 */
function sirenFrameOf(args: {
  readonly room: OfficeCivicRoom;
  readonly floor: OfficeFloor;
  readonly tally: OfficeCivicTally;
  readonly clock: OfficeSignClock;
}): 0 | 1 | null {
  const { clock, floor, room, tally } = args;
  if (room.kind !== "infirmary") return null;
  if (floor.road !== null) return null;
  const taken = tally.occupiedByRoom.get(room.civicRoomId) ?? 0;
  if (taken === 0) return SIREN_DARK_FRAME;
  if (clock.reducedMotion) return SIREN_LIT_FRAME;
  return Math.floor(clock.nowMs / OFFICE_SIREN_FRAME_MS) % 2 === 0
    ? SIREN_DARK_FRAME
    : SIREN_LIT_FRAME;
}

/** A civic room and the storey it stands on, which is what decides its beacon. */
interface CivicPlacement {
  readonly room: OfficeCivicRoom;
  readonly floor: OfficeFloor;
}

/**
 * Every civic room on the plan, by id.
 *
 * Built per resolve rather than carried, because it is four rooms a storey and
 * the alternative is a cache to invalidate when a plan changes - which is the
 * kind of second copy this module exists to avoid.
 */
function civicPlacements(
  floors: ReadonlyArray<OfficeFloor>,
): ReadonlyMap<string, CivicPlacement> {
  const byId = new Map<string, CivicPlacement>();
  for (const floor of floors) {
    for (const room of floor.civic) byId.set(room.civicRoomId, { room, floor });
  }
  return byId;
}

/**
 * ONE CIVIC SIGN, resolved and banded, or `null` where this band does not
 * letter it.
 *
 * Lifted out of {@link officeSignsToDraw}'s loop rather than inlined with the
 * other kinds, because it is the only one whose BAND depends on its own
 * reading: `reports` is not known until the counter has been fitted to the
 * room, so the resolve has to happen before the gate and the gate cannot be
 * the loop's usual one-liner.
 */
function civicSignToDraw(args: {
  readonly sign: OfficeSign;
  readonly placed: CivicPlacement;
  readonly anchor: OfficePoint;
  readonly civicTally: OfficeCivicTally;
  readonly clock: OfficeSignClock;
  readonly lod: OfficeLod;
  readonly zoom: number;
  readonly measure: OfficePlateMeasure;
  /** For an open room's clearance: the room's first row is a PROJECTED fact. */
  readonly projector: OfficeProjector;
}): OfficeSignToDraw | null {
  const {
    anchor,
    civicTally,
    clock,
    lod,
    measure,
    placed,
    projector,
    sign,
    zoom,
  } = args;
  const reading = officeCivicSignText({
    room: placed.room,
    tally: civicTally,
    lod,
    widthTiles: sign.widthTiles,
    zoom,
    measure,
  });
  const sirenFrame = sirenFrameOf({
    room: placed.room,
    floor: placed.floor,
    tally: civicTally,
    clock,
  });
  // A BEACON IS A REPORT, and it hangs off this plate's own top edge - so a
  // ward whose counter did not fit is still lettered when it carries one.
  // Dropping the plate here would take the lamp with it, and on a roadless
  // floor that lamp is the whole of the alarm (C6): Mission control has no
  // street for an ambulance to come down.
  if (
    sirenFrame === null &&
    !officeSignLetteredAt({ sign, lod, civicReports: reading.reports })
  ) {
    return null;
  }
  return {
    sign,
    text: reading.text,
    // A room is not somebody's, so there is no role to letter under it.
    subtext: null,
    anchor,
    sirenFrame,
    // THE ROOM'S OWN ENCLOSURE DECIDES, because the board needs a wall and
    // only a walled room has one. See {@link OfficeSignMount} for what an
    // open room's board was landing on instead.
    //
    // THE CLEARANCE IS THE ROOM'S FIRST ROW, NOT THE SIGN'S TILE. Taken at the
    // sign's own column, because that is the column the plate is drawn in -
    // two of the four help desks letter from a tile outside their box
    // entirely - and `min`'d with the anchor so a sign the plan already hung
    // above its room is not dragged back down onto it.
    mount:
      placed.room.enclosure === "walled"
        ? WALL_MOUNT
        : {
            kind: "floating",
            clearWorldY: Math.min(
              anchor.y,
              projector.project(sign.tile.col, placed.room.bounds.row).y,
            ),
          },
  };
}

/** Any sign's own width on screen: its tiles, through the camera's zoom. */
export function officePlateWidthPx(widthTiles: number, zoom: number): number {
  return Math.max(1, widthTiles) * OFFICE_TILE * zoom;
}

/** A board's own width on screen: its tiles, through the camera's zoom. */
export function officeBoardWidthPx(sign: OfficeSign, zoom: number): number {
  return officePlateWidthPx(sign.widthTiles, zoom);
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
  /** The storeys, for the civic rooms a `civic` sign counts and lights. */
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly visibleAgentIds: ReadonlySet<string>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  readonly nameById: ReadonlyMap<string, string>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly roleClaims: Readonly<Record<string, readonly RoleClaim[]>>;
  /** What the civic signs count: the scene's, because the seat book is. */
  readonly civicTally: OfficeCivicTally;
  readonly projector: OfficeProjector;
  readonly lod: OfficeLod;
  /** The camera's zoom, because a board's width on screen is a camera fact. */
  readonly zoom: number;
  /** What the ward's beacon is phased on, and whether it may blink at all. */
  readonly clock: OfficeSignClock;
  readonly measure: OfficePlateMeasure;
}): ReadonlyArray<OfficeSignToDraw> {
  const {
    civicTally,
    clock,
    floors,
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
  const placements = civicPlacements(floors);
  const out: OfficeSignToDraw[] = [];
  for (const sign of signs) {
    const owner = sign.ownerAgentId;
    if (owner !== null && !visibleAgentIds.has(owner)) continue;
    const anchor = projector.project(sign.tile.col, sign.tile.row);
    const placed =
      sign.civicRoomId === null ? undefined : placements.get(sign.civicRoomId);
    if (sign.kind === "civic" && placed !== undefined) {
      const civic = civicSignToDraw({
        sign,
        placed,
        anchor,
        projector,
        civicTally,
        clock,
        lod,
        zoom,
        measure,
      });
      if (civic !== null) out.push(civic);
      continue;
    }
    // Every other kind decides on the sign alone - only `civic` counts, so
    // only `civic` has a reading to consult.
    //
    // THIS DROPS THE BOARD TOO, not only the lettering. A sign that is not
    // lettered here gets no entry at all, and the renderer draws a sign's
    // board sprite off the same entries it draws the text off - so an amenity
    // plate withheld at office zoom takes its plaque with it and both come
    // back together at close-up. That is the intent rather than a side
    // effect: the feedback this band rule answers is "the labels completely
    // cover the artwork", and a BLANK plaque covers exactly as much of it as
    // a lettered one. Leaving the board behind would answer the complaint by
    // deleting the only part of the sign that was doing any work.
    if (!officeSignLetteredAt({ sign, lod, civicReports: false })) continue;
    if (sign.kind === "board" || sign.kind === "hq-board") {
      const text = officeBoardText({
        sign,
        statusById,
        visibleAgentIds,
        nameById,
        available: officeBoardWidthPx(sign, zoom),
        measure,
      });
      // A one-tile board at the lowest lettered zoom has room for no reading
      // of its roster, not even a glyph. It draws NOTHING rather than an empty
      // plate: a plate is only its padding at that point, and a box painted
      // over the room next door says less than the board art already does.
      if (text === "") continue;
      out.push({
        sign,
        text,
        subtext: null,
        anchor,
        sirenFrame: null,
        mount: WALL_MOUNT,
      });
      continue;
    }
    const named = nameSignToDraw({
      sign,
      owner,
      anchor,
      nameById,
      hostNameById,
      roleClaims,
      zoom,
      measure,
    });
    if (named !== null) out.push(named);
  }
  return out;
}

/**
 * EVERY SIGN THAT IS NEITHER A BOARD NOR A CIVIC ROOM: a cabin's sign, a pod's
 * plate, an amenity's name, a host's floor. `null` where it has nothing it can
 * say in the room it names.
 *
 * Lifted out of {@link officeSignsToDraw}'s loop for the same reason
 * {@link civicSignToDraw} is - the loop is a three-way dispatch and each arm is
 * a paragraph - and this is the arm with the ladder in it.
 */
function nameSignToDraw(args: {
  readonly sign: OfficeSign;
  readonly owner: string | null;
  readonly anchor: OfficePoint;
  readonly nameById: ReadonlyMap<string, string>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly roleClaims: Readonly<Record<string, readonly RoleClaim[]>>;
  readonly zoom: number;
  readonly measure: OfficePlateMeasure;
}): OfficeSignToDraw | null {
  const {
    anchor,
    hostNameById,
    measure,
    nameById,
    owner,
    roleClaims,
    sign,
    zoom,
  } = args;
  // A host sign carries no text of its own: the layout knows the id and the
  // directory knows what the machine is called. Everything else says what
  // the plan wrote, re-lettered from the owner's current name.
  const text = signTextOf({ sign, owner, nameById, hostNameById });
  if (text === "") return null;
  const claim = roleClaimOf(roleClaims, owner);
  const rungs = plateRungsFor(sign, text);
  // A sign that names no ladder is drawn as written, which is every sign on
  // every view but the two oblique ones: their plates are the only lettering
  // whose room is narrow enough for the reading to have to give way.
  if (rungs === null) {
    return {
      sign,
      text,
      subtext: claim,
      anchor,
      sirenFrame: null,
      mount: WALL_MOUNT,
    };
  }
  const fitted = officePlateTextThatFits({
    rungs,
    widthTiles: sign.widthTiles,
    zoom,
    measure,
  });
  if (fitted === null) return null;
  return {
    sign,
    text: fitted,
    // THE CLAIM FITS TOO, or it is not drawn. It is a second plate on the
    // same centre, so a claim wider than the room overhangs it exactly as
    // the name would have, and the name being short is no protection.
    subtext:
      claim === null
        ? null
        : officePlateTextThatFits({
            rungs: officePlateRungs(claim),
            widthTiles: sign.widthTiles,
            zoom,
            measure,
          }),
    anchor,
    sirenFrame: null,
    mount: WALL_MOUNT,
  };
}

/**
 * The ladder this sign comes down, or `null` where it has none.
 *
 * A plate that says `"name"` is re-lettered from whoever owns it AT THE
 * CURSOR, so its ladder is derived here from the resolved text rather than
 * carried from the plan: a renamed lead would otherwise shorten through its
 * old name. A plate that carries its own readings is a SUMMARY the plan wrote
 * ("Bullpen · 9 live solos"), with no owner and no name to re-letter, so those
 * readings are used exactly as they were written.
 */
function plateRungsFor(
  sign: OfficeSign,
  text: string,
): ReadonlyArray<string> | null {
  if (sign.rungs === undefined) return null;
  if (sign.rungs === "name") return officePlateRungs(text);
  return sign.rungs;
}

/**
 * A HOST'S NAME OVER ITS STAIRWELL - once per host, never once per storey.
 *
 * The label answers "whose machine is this part of the office", so it is asked
 * of a HOST and not of a floor. Two rules follow, and both are about the same
 * question being asked too often:
 *
 * - **One host, no label.** With a single host the office IS the epic and a
 *   sign over it labels the obvious. This is the old `floors.length <= 1`
 *   guard, restated about hosts: a thousand agents on one machine stack into
 *   twenty-one storeys, which is one host and was twenty-one `Unattributed`s.
 * - **A stack names itself at its foot.** Where a host holds several floors
 *   they are the storeys of one building, and the plan already puts a `host`
 *   sign across its ground row - so a label over every stairwell repeats that
 *   name down the whole tower. The foot sign is the one that carries it.
 *
 * What is left is the case this was written for: one floor per host, which is
 * every host on Floor, Campus and City. Those are unaffected.
 */
export function officeFloorSignsToDraw(args: {
  readonly floors: ReadonlyArray<OfficeFloor>;
  readonly hostNameById: ReadonlyMap<string, string>;
  readonly projector: OfficeProjector;
  readonly lod: OfficeLod;
}): ReadonlyArray<OfficeFloorSignToDraw> {
  const { floors, hostNameById, lod, projector } = args;
  if (lod === 0) return NO_FLOOR_SIGNS_TO_DRAW;
  const byHost = new Map<string | null, OfficeFloor[]>();
  for (const floor of floors) {
    const group = byHost.get(floor.hostId);
    if (group === undefined) byHost.set(floor.hostId, [floor]);
    else group.push(floor);
  }
  if (byHost.size <= 1) return NO_FLOOR_SIGNS_TO_DRAW;
  const out: OfficeFloorSignToDraw[] = [];
  for (const group of byHost.values()) {
    if (group.length !== 1) continue;
    const floor = group[0];
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

// ---- A seated agent's name tag -------------------------------------- //
//
// Everything below is the NAME TAG's own fit, and it deliberately shares
// nothing with the plate ladder above but `officePlateWidthPx`. A tag is a
// person's name over a box the plan sized; a plate is a room's lettering. The
// two rules look alike and disagree about every interesting case, so they are
// kept apart rather than parameterised into one.

/**
 * HOW MANY CHARACTERS HAVE TO SURVIVE IN FRONT OF AN ELLIPSIS for a clipped
 * name to still point at somebody.
 *
 * `Orchestra…` names one agent; `Orch…` names whoever the reader guesses, and
 * on a bench where every name shares a stem it names a whole team. A count and
 * not a width, because it is a statement about reading rather than about
 * pixels - the one place in this module where a character budget is the right
 * unit.
 */
const NAME_TAG_MIN_CLIPPED_CHARS = 6;

/**
 * What a clipped reading must not end in: a gap reads as a missing word, and a
 * second ellipsis as a typo. Also what makes the STEM, so a clip never lands
 * on the ellipsis `truncate` already added and never offers the written
 * reading back as though it were a shorter one.
 */
const NAME_TAG_CLIP_FILLER = /[\s…]+$/;

/** A name's words, split the way a person's name splits: on spaces alone. */
function tagWords(name: string): ReadonlyArray<string> {
  return name.split(" ").filter((word) => word !== "");
}

/** The leading word, or the whole name when it has no spaces in it. */
function tagFirstWord(name: string): string {
  return tagWords(name)[0] ?? name;
}

/** One letter a word. `Bay member` is `BM`; `team-4-member` is `t`. */
function tagInitials(name: string): string {
  return tagWords(name)
    .map((word) => word.slice(0, 1))
    .join("");
}

/**
 * THE WIDEST READING OF A SEATED AGENT'S NAME TAG THAT FITS ITS SEAT, or
 * `null` when nothing readable does.
 *
 * A cubby is ONE tile wide and a truncated name is fourteen characters, so a
 * dense row used to print its occupants over each other while every name in it
 * was individually correct. Fitting each tag to its OWN seat is what makes two
 * neighbours disjoint with no neighbour search and nothing measured against
 * the row.
 *
 * This is not {@link officePlateTextThatFits}, and the difference is in both
 * halves. A plate gives up a name's trailing parts, which reads `team-4` for
 * every member of team 4; and a plate's character budgets exist to keep a
 * reading out of the renderer's own ellipsis, where a tag REACHES for that
 * ellipsis as its second rung.
 *
 * The rungs, widest first:
 *
 * 1. as the scene wrote it (already cut to `MAX_LABEL_CHARS`);
 * 2. clipped to the budget with an ellipsis, while at least
 *    {@link NAME_TAG_MIN_CLIPPED_CHARS} characters survive in front of it;
 * 3. its first word, where the name has more than one;
 * 4. its initials, where there are at least two of them;
 * 5. nothing.
 *
 * A LONE LETTER IS NOT A RUNG, which is why 4 needs two initials and 5 is a
 * real answer rather than a failure. `t` is what every agent of a hyphenated
 * bench comes down to, and a cubby storey of identical single letters says
 * strictly less than a row of bare desks does. An agent whose one long word
 * will not fit therefore carries no tag until six of its characters do - the
 * hover card and the directory name it meanwhile, and an overprinted row names
 * nobody at all.
 */
export function nameTagTextThatFits(args: {
  readonly name: string;
  /** The seat's own width on screen: {@link officePlateWidthPx}. */
  readonly widthPx: number;
  /** The face the tag is DRAWN in, so what fits is what lays out. */
  readonly measure: OfficePlateMeasure;
}): string | null {
  const { measure, name, widthPx } = args;
  if (measure(name) <= widthPx) return name;
  const clipped = clippedNameThatFits({ name, widthPx, measure });
  if (clipped !== null) return clipped;
  // A SINGLE-WORD NAME HAS NO RUNG 3: its first word is the written reading,
  // which has already been measured and did not fit.
  const firstWord = tagFirstWord(name);
  if (firstWord !== name && measure(firstWord) <= widthPx) return firstWord;
  const initials = tagInitials(name);
  if (initials.length >= 2 && measure(initials) <= widthPx) return initials;
  return null;
}

/**
 * The longest ellipsized reading of a name that fits, or `null` when none
 * keeps enough of it.
 *
 * LONGEST FIRST, so the first fit is the longest one by construction - no
 * assumption that a longer prefix measures wider, which a proportional
 * fallback face in the stack would not owe us.
 */
function clippedNameThatFits(args: {
  readonly name: string;
  readonly widthPx: number;
  readonly measure: OfficePlateMeasure;
}): string | null {
  const { measure, name, widthPx } = args;
  const stem = name.replace(NAME_TAG_CLIP_FILLER, "");
  for (
    let kept = stem.length - 1;
    kept >= NAME_TAG_MIN_CLIPPED_CHARS;
    kept -= 1
  ) {
    const prefix = stem.slice(0, kept).replace(NAME_TAG_CLIP_FILLER, "");
    // Trimming a trailing gap can take a reading under the floor, and every
    // shorter one is under it too.
    if (prefix.length < NAME_TAG_MIN_CLIPPED_CHARS) break;
    const clipped = `${prefix}…`;
    if (measure(clipped) <= widthPx) return clipped;
  }
  return null;
}
