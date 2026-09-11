/**
 * The office simulation: who is where, who is walking, what is bubbling, and
 * which envelopes are in the air at this instant.
 *
 * PURE AND DETERMINISTIC BY CONSTRUCTION. Nothing here reads a clock, a random
 * source, the DOM or a canvas. Time enters only through `tick(dtMs)` and
 * per-agent variety only through a hash of the agent id, so two scenes fed the
 * same sync/tick sequence produce identical frames. That is what makes
 * playback scrubbable, replayable and testable - a scene that sampled
 * `Date.now()` would render a different floor every time the same cursor was
 * revisited.
 *
 * ANCHORS the canvas must honour - a frame is coordinates and nothing else:
 *
 * - `floor`, `props` and `actors` sprites are TOP-LEFT anchored at `(x, y)`.
 * - A character hangs from its FOOT POINT, the projected bottom centre of the
 *   tile it stands on: its sprite corner is that point less half a character's
 *   width and a whole character's height, so its feet land on its tile and its
 *   head rises above it. On the Floor's identity projector that is exactly
 *   `(col * OFFICE_TILE, row * OFFICE_TILE - 4)`.
 * - `overlay` sprites (bubbles, sparkles) are BOTTOM-CENTER anchored - `x` is
 *   the character's horizontal centre, `y` its top minus two.
 * - `envelope` drawables are CENTER anchored. Their `y` ALREADY includes the
 *   flight arc, and `progress` is the EASED parameter, so a ground shadow must
 *   be derived from that same value or it will slide out from under the
 *   envelope.
 * - `clock` drawables are CENTER anchored on the clock FACE, so the hands are
 *   drawn outward from `(x, y)`.
 * - A `label` is centered on `x` with its baseline above `y`, per the shared
 *   type.
 *
 * A DESK IS ONLY DRAWN FOR AN AGENT THAT EXISTS AS OF THE CURSOR. The floor
 * plan covers every agent in the epic so positions never shift as playback
 * reveals people, but rendering an empty desk for someone who has not been
 * created yet would leak the future into a historical view.
 *
 * MESSAGES FLY BETWEEN SEATS, never between bodies. An envelope aimed at
 * wherever a character happens to be standing lands in an empty chair the
 * moment that character is walking in or away at reception, so both endpoints
 * are the agents' DESKS and anyone an envelope touches is seated first.
 */
import type {
  CommGraphPulse,
  CommGraphPulseKind,
} from "@/lib/comm-graph/comm-graph-timeline";
import { officeSpriteSize } from "@/lib/comm-graph/office/office-pixel-art";
import {
  isOfficeHotStatus,
  officeArchivedAsOf,
} from "@/lib/comm-graph/office/office-status";
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import { OfficeSeatBook } from "@/lib/comm-graph/office/office-seat-book";
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeCharacterAccessory,
  type OfficeCharacterPose,
  type OfficeDrawable,
  type OfficeEnvelopeHitRegion,
  type OfficeErrandKind,
  type OfficeErrandSpot,
  type OfficeFacing,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficeLod,
  type OfficePipGlyph,
  type OfficePoint,
  type OfficeRect,
  type OfficeRoom,
  type OfficeSceneInput,
  type OfficeSeat,
  type OfficeSize,
  type OfficeSpriteName,
  type OfficeTilePos,
  type OfficeTileRect,
  type OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";
import type {
  OfficeDeskState,
  OfficeProjector,
  OfficeView,
} from "@/lib/comm-graph/office/views/office-view";

/**
 * How far outside the camera's rect the frame is still built.
 *
 * A character standing just off the left edge is half on screen, and a desk's
 * monitor is drawn eight pixels above the desk's own tile. One tile's worth of
 * slack, four times over, costs a handful of drawables and removes every class
 * of thing popping into existence at the edge of the viewport.
 */
export const OFFICE_CULL_MARGIN_PX = 64;

/**
 * The side of one frame-index chunk, in tiles - 512 sprite pixels, the same
 * square the static layer bakes in.
 *
 * The index exists so `frame` never walks every seat in a thousand-agent
 * office to find the forty that are on screen. It is rebuilt per layout and
 * read per frame, so the chunk wants to be big enough that a viewport touches
 * a dozen of them and small enough that one is not most of the world.
 */
const FRAME_CHUNK_TILES = 32;

/** A cubby's occupant is drawn dimmed at close-up: present, not working. */
const CUBBY_OCCUPANT_ALPHA = 0.6;

const WALK_TILES_PER_SECOND = 3;
/**
 * An arrival is not a stroll. A newcomer's first message lands within a step of
 * its creation, so the walk from the door has to be over by then or the
 * envelope arrives at an empty chair.
 */
const ARRIVAL_TILES_PER_SECOND = 8;
/**
 * A message is waiting: whoever it is to or from RUNS. This is what replaced
 * snapping an agent into its chair the instant a pulse touched it - a character
 * teleporting mid-stride reads as a rendering glitch, while the same character
 * sprinting back reads as the office noticing.
 */
const HURRY_TILES_PER_SECOND = 14;
/**
 * Below this step length playback is running fast enough that a walk-in would
 * still be in progress when the next row is drawn, so arrivals are announced
 * with a sparkle at the desk instead.
 */
const FAST_PLAYBACK_STEP_MS = 600;
const WALK_FRAME_MS = 120;
const TYPING_FRAME_MS = 180;
const BACKGROUND_FRAME_MS = 400;
const BUBBLE_BOB_MS = 500;
const BUBBLE_HELLO_MS = 700;
const SPARKLE_MS = 400;
const ENVELOPE_STEP_FRACTION = 0.75;
const ENVELOPE_MIN_MS = 350;
const ENVELOPE_MAX_MS = 900;
/**
 * Peak height of an envelope's flight, in sprite pixels. Exported because the
 * renderer has to undo it: the drawable's `y` already has this lift folded in,
 * and adding it back is what recovers the ground line the shadow sits on.
 */
export const ENVELOPE_ARC_LIFT = 14;
/**
 * A burst of traffic in one step must not turn the floor into confetti, and an
 * unbounded list would grow without limit while scrubbing. Oldest is dropped
 * because the newest rows are the ones the cursor is actually about.
 */
const MAX_LIVE_ENVELOPES = 24;
/** Even with motion off an arrival has to be on screen long enough to see. */
const REDUCED_MOTION_ARRIVAL_MS = 300;
const BUBBLE_GAP = 2;
const LABEL_GAP = 8;
const MAX_LABEL_CHARS = 14;
/**
 * A lit screen is never still: two frames alternate while an agent is in a
 * turn, and far more slowly while it is only working in the background.
 *
 * The scene owns the CLOCK and the painter owns the art, so what crosses the
 * seam is which of the two frames a desk is on.
 */
const MONITOR_WORKING_FRAME_MS = 260;
const MONITOR_BACKGROUND_FRAME_MS = 700;
/** Slack around an envelope's box, so a moving 10x8 target stays clickable. */
const ENVELOPE_HIT_PADDING = 2;
/**
 * Errands. Only a LIVE floor runs them - playback makes every agent idle
 * between its own rows, so a break during it would fire constantly - and only
 * after a stretch of nothing long enough that the stillness is the point. The
 * stagger is what keeps a quiet epic from standing up in unison.
 *
 * The threshold is DELIBERATELY short. An office where nobody moves for half a
 * minute reads as a screenshot, and the whole reason this exists is that agents
 * between turns looked dead.
 *
 * AN IDLE AGENT IS NEVER AT ITS DESK. Past the threshold everyone gets up, and
 * errands CHAIN - one finishes, the next begins from where the last one ended -
 * so the only things that put somebody back in a chair are the things that
 * actually happened to them: a status that stopped being idle, a message, a
 * summons to reception, an archival, playback starting, going invisible. There
 * is deliberately no cap on how many are away and no cooldown after one: both
 * existed to keep the floor looking populated, and a floor of people sitting
 * perfectly still is the thing this is for.
 */
const IDLE_ERRAND_MS = 5_000;
const ERRAND_STAGGER_SPREAD_MS = 4_000;
const ERRAND_LINGER_MIN_MS = 3_000;
const ERRAND_LINGER_SPREAD_MS = 5_000;
/** A visit is a shorter beat: two people talking, not one person standing. */
const VISIT_LINGER_MIN_MS = 3_000;
const VISIT_LINGER_SPREAD_MS = 2_000;
/** A corridor spot is one leg of a stroll: stand, then move on to the next. */
const STROLL_PAUSE_MS = 2_000;
/** How many corridor spots one stroll takes in before it counts as done. */
const STROLL_MIN_LEGS = 2;
const STROLL_LEG_SPREAD = 3;
/** Lounging on the sofa: long, because a sofa that is a pause reads as a queue. */
const SOFA_LINGER_MIN_MS = 6_000;
const SOFA_LINGER_SPREAD_MS = 6_000;
/** Looking in at somebody else's room, and looking down the stairwell. */
const PEEK_LINGER_MS = 2_000;
const STAIRS_LINGER_MS = 3_000;
/** A go on the arcade cabinet, and how often its screen flashes while played. */
const ARCADE_LINGER_MIN_MS = 5_000;
const ARCADE_LINGER_SPREAD_MS = 4_000;
const ARCADE_SPARKLE_GAP_MS = 2_000;
/**
 * The two-player games: ping-pong, foosball and chess. They are the errands
 * that need somebody OPPOSITE, so the first to arrive holds their side open for
 * a while and gives up if nobody comes - a character standing alone at a table
 * forever reads as a hang, not as a wait.
 *
 * All three share one clock and one pairing rule. What differs is only what is
 * drawn: a ball shuttling across the table, or two people thinking.
 */
const GAME_ALONE_MS = 6_000;
const GAME_PLAY_MIN_MS = 8_000;
const GAME_PLAY_SPREAD_MS = 6_000;
/** One stroke: the ball crosses to the other side and comes back. */
const GAME_STROKE_MS = 500;
/** How often the thinking bubble passes between two players at the chess table. */
const CHESS_THINK_MS = 2_000;
/** The kinds two agents play together, in the order the pairing bias tries them. */
const TWO_PLAYER_KINDS: ReadonlyArray<OfficeErrandTargetKind> = [
  "pingpong",
  "foosball",
  "chess",
];
/** A game on the console: the television flashes while somebody is on the sofa. */
const CONSOLE_LINGER_MIN_MS = 6_000;
const CONSOLE_LINGER_SPREAD_MS = 5_000;
const CONSOLE_SPARKLE_GAP_MS = 2_000;
/**
 * A nap: long, and the sleeping bubble comes up once the agent has settled.
 * Anything shorter reads as lying down and getting straight back up.
 */
const NAP_LINGER_MIN_MS = 10_000;
const NAP_LINGER_SPREAD_MS = 8_000;
const NAP_SETTLE_MS = 2_000;
/**
 * Reading in the library. The thought bubble comes and goes on its own beat -
 * a page turned - rather than standing for the whole sit like a status would.
 */
const READ_LINGER_MIN_MS = 8_000;
const READ_LINGER_SPREAD_MS = 6_000;
const READ_THOUGHT_CYCLE_MS = 3_000;
const READ_THOUGHT_ON_MS = 1_500;
/** A stint on a treadmill, and how fast the walking frames alternate on it. */
const TREADMILL_LINGER_MIN_MS = 6_000;
const TREADMILL_LINGER_SPREAD_MS = 5_000;
const TREADMILL_FRAME_MS = 200;
/** Tending a plant: the can is out for the whole beat, the sparkle ends it. */
const WATER_PLANT_MS = 3_000;
/**
 * A paper toss: a beat to line the shot up, then two or three throws a beat
 * apart. The gap is longer than the flight so the ball is seen to land before
 * the next one leaves.
 *
 * DARTS is the same throw against a different target, so it runs on the same
 * clock. It takes a fixed three, and none of them miss: a dart is aimed, and a
 * board full of floor-bound darts would read as the arc being broken.
 */
const BIN_STAND_MS = 1_000;
const BIN_THROW_GAP_MS = 800;
const BIN_MIN_THROWS = 2;
const BIN_THROW_SPREAD = 2;
const DARTS_THROWS = 3;
const PAPER_BALL_FLIGHT_MS = 500;
/** A missed ball lies where it landed rather than vanishing mid-air. */
const PAPER_BALL_REST_MS = 3_000;
/** Roughly three in ten throws miss - seeded, never sampled. */
const PAPER_MISS_PERCENT = 30;
/** Where a missed ball comes to rest, in sprite pixels beside the bin. */
const PAPER_MISS_OFFSET = 6;
/** The can hangs at the character's right hand, beside the body. */
const WATERING_CAN_X_OFFSET = 10;
const WATERING_CAN_Y_OFFSET = 14;
/** How often two agents in one conversation swap who is talking. */
const CHAT_ALTERNATE_MS = 900;
/**
 * How often a seated idle agent does something small at its own desk, and the
 * spread over which that gap varies per agent.
 *
 * SHORTER THAN THE ERRAND THRESHOLD, deliberately. A desk filler used to be
 * what the floor did while the two agents allowed out at once were away; now
 * everybody leaves, so the only time an idle agent is in its chair at all is
 * the few seconds between falling idle and standing up. A gap longer than that
 * window is a feature that never fires.
 */
const FILLER_GAP_MIN_MS = 1_500;
const FILLER_GAP_SPREAD_MS = 2_000;
const FILLER_LOOK_MS = 1_500;
const FILLER_LOOK_STEP_MS = 500;
const FILLER_STRETCH_MS = 1_200;
const FILLER_SPIN_STEP_MS = 120;
const FILLER_SPIN_TURNS = 2;
const FILLER_SPIN_FACINGS: ReadonlyArray<OfficeFacing> = [
  "down",
  "left",
  "up",
  "right",
];
/**
 * How badly the errand kinds are wanted. The cafeteria outweighs the rest
 * because it is where two agents can end up in the same place; standing at a
 * window is scenery, and a floor of scenery is the problem this solves.
 */
const ERRAND_WEIGHTS: Readonly<Record<OfficeErrandTargetKind, number>> = {
  // The rooms that only appear once a floor is big enough. A kind with no spot
  // on THIS floor can never be drawn whatever its weight, so these only ever
  // compete where the room they belong to actually exists.
  foosball: 3,
  darts: 2,
  chess: 2,
  console: 2,
  nap: 2,
  read: 2,
  garden: 2,
  treadmill: 1,
  coffee: 3,
  cafe: 3,
  sofa: 2,
  cooler: 2,
  vending: 2,
  corridor: 2,
  visit: 2,
  bin: 2,
  window: 2,
  peek: 1,
  "water-plant": 1,
  whiteboard: 1,
  plant: 1,
  stairs: 1,
  // The game room is worth crossing the floor for, and the table most of all:
  // it is the only errand two agents play TOGETHER.
  pingpong: 3,
  arcade: 2,
};
const ARCHIVED_ALPHA = 0.45;
/** Spread of the per-agent animation phase offset. */
const PHASE_SPREAD_MS = 1000;

interface TransientBubble {
  readonly sprite: OfficeSpriteName;
  remainingMs: number;
}

/**
 * What a character is away from its desk FOR. One field rather than several
 * flags, because every one of these drives the same path and only one of them
 * can be true at a time.
 *
 * - `arriving` - walking in from its floor's door to take a seat.
 * - `errand-out` / `errand-wait` / `errand-return` - a break somewhere on the
 *   floor: the cafeteria, a window, a colleague's desk.
 * - `queue-out` / `queue-stand` - waiting at reception for a person.
 * - `leaving` - archived; walking to the door to disappear.
 * - `returning` - walking back to its own chair from anything else.
 *
 * An errand keeps its own return state rather than folding into `returning`,
 * because the cap on how many people are away at once has to count the walk
 * back: release the slot the moment the linger ends and the next bored agent
 * stands up while the last one is still crossing the floor.
 */
type OfficeErrand =
  | "none"
  | "arriving"
  | "errand-out"
  | "errand-wait"
  | "errand-return"
  | "queue-out"
  | "queue-stand"
  | "leaving"
  | "returning";

/**
 * `visit` is the one errand with no tile in the floor plan: it is paid to a
 * COLLEAGUE, whose desk moves whenever the agent set does. The layout could not
 * carry it without turning the plan into a function of who is idle, so the
 * scene derives it and the other kinds are read straight off the floor.
 */
type OfficeErrandTargetKind = OfficeErrandKind | "visit";

interface OfficeErrandTarget {
  readonly kind: OfficeErrandTargetKind;
  /** Where the walker STANDS. The spot's `approachTile`, which it may not own. */
  readonly tile: OfficeTilePos;
  readonly facing: OfficeFacing;
  /** The colleague a `visit` is paid to; `null` for every other kind. */
  readonly partnerId: string | null;
  /**
   * The FIXTURE, so two agents at one table are two agents at one table.
   * `null` for a visit and a stroll, which have no furniture between them.
   */
  readonly fixtureId: string | null;
  /**
   * What this errand acts ON - the bin a ball is thrown at, the plant that is
   * watered, the screen that flashes - or `null` for one that acts on nothing.
   * Carried from the spot rather than looked up a tile above, which is a fact
   * about one floor plan rather than about errands.
   */
  readonly actionTile: OfficeTilePos | null;
}

/** Every errand target that is not a spot on the plan names no fixture. */
function derivedTarget(args: {
  readonly kind: OfficeErrandTargetKind;
  readonly tile: OfficeTilePos;
  readonly facing: OfficeFacing;
  readonly partnerId: string | null;
}): OfficeErrandTarget {
  return { ...args, fixtureId: null, actionTile: null };
}

function targetOfSpot(spot: OfficeErrandSpot): OfficeErrandTarget {
  return {
    kind: spot.kind,
    tile: spot.approachTile,
    facing: spot.facing,
    partnerId: null,
    fixtureId: spot.fixtureId,
    actionTile: spot.actionTile,
  };
}

/**
 * Something small a seated idle agent does at its own desk. Errands move two
 * people at a time and the rest of the floor would sit perfectly still without
 * these - which is the exact complaint that started all of this.
 */
type OfficeFillerKind = "look" | "stretch" | "spin";

interface OfficeFiller {
  readonly kind: OfficeFillerKind;
  elapsedMs: number;
  readonly durationMs: number;
}

/** An envelope that landed while its receiver was away from its chair. */
interface PendingItem {
  readonly bubble: OfficeSpriteName;
  readonly sparkle: boolean;
  /**
   * Whether the pile on the desk already counts this message: an unanswered
   * request is in the as-of open-request count from the moment it lands, so
   * adding it here as well would draw one message as two.
   */
  readonly inOpenCount: boolean;
}

interface OfficeCharacter {
  readonly agentId: string;
  /** Tile coordinates, fractional while walking. */
  col: number;
  row: number;
  facing: OfficeFacing;
  seated: boolean;
  path: ReadonlyArray<OfficeTilePos>;
  pathIndex: number;
  walkPhaseMs: number;
  /** Scene time spent seated and idle; drives the sleep bubble. */
  idleMs: number;
  bubble: TransientBubble | null;
  sparkleMs: number;
  errand: OfficeErrand;
  /** Scene time left standing at the spot, while `errand` is `errand-wait`. */
  waitMs: number;
  /** What `waitMs` started at, so a stint can be told long from short. */
  lingerTotalMs: number;
  /** The reception slot this character was assigned, while it holds one. */
  queueTile: OfficeTilePos | null;
  /** Where this errand is headed. Held for the whole errand, return included. */
  errandTarget: OfficeErrandTarget | null;
  /** Tile of the last errand's destination; never chosen twice running. */
  lastErrandKey: string | null;
  /** Kind of the last errand; never chosen twice running either. */
  lastErrandKind: OfficeErrandTargetKind | null;
  /** Legs taken of the current stroll, and how many it means to take. */
  errandLegs: number;
  errandLegsWanted: number;
  /** In a rally: a partner took the other end of the table and play began. */
  rallying: boolean;
  /** Paper balls this character still means to throw, while it is at a bin. */
  throwsLeft: number;
  /** Scene time until the next throw leaves its hand. */
  nextThrowMs: number;
  filler: OfficeFiller | null;
  /** Scene time until the next desk filler, once the current one is over. */
  nextFillerMs: number;
  /** How many fillers this character has run; part of the next one's seed. */
  fillerCount: number;
  /** Envelopes that landed while this character was out of its chair. */
  pending: PendingItem[];
  /** Running for the chair because a message is waiting. Cleared on sitting. */
  hurrying: boolean;
}

interface OfficeEnvelope {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly pulseKind: CommGraphPulseKind;
  /** The pair edge the message belongs to, carried through to the drawable. */
  readonly edgeId: string;
  elapsedMs: number;
  readonly durationMs: number;
}

/**
 * A crumpled page on its way to a bin. Flies the same arc an envelope does -
 * the shape is what makes a thrown thing read as thrown - and a miss then lies
 * on the floor beside the bin for a few seconds instead of blinking out.
 */
interface OfficePaperBall {
  readonly from: OfficePoint;
  readonly to: OfficePoint;
  readonly missed: boolean;
  elapsedMs: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
}

/** FNV-1a: a stable, dependency-free spread over agent ids. */
function hashAgentId(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A per-agent phase offset, so a room of typists does not hammer its keyboards
 * in lockstep. Seeded from the id rather than from arrival order, which would
 * make the animation depend on how the timeline was scrubbed.
 */
function phaseOffsetMs(agentId: string): number {
  return hashAgentId(agentId) % PHASE_SPREAD_MS;
}

/**
 * How much longer than the threshold THIS agent sits still before getting up.
 * Derived from the id for the same reason the typing phase is: a floor where
 * everyone stands at once is an animation, not an office.
 */
function errandStaggerMs(agentId: string): number {
  return hashAgentId(agentId) % ERRAND_STAGGER_SPREAD_MS;
}

/**
 * Folds a second number into an agent's hash. Every per-agent CHOICE - which
 * spot, how long to linger, which filler comes next - is drawn from one of
 * these rather than from a random source, so the same tick sequence replays
 * frame for frame. Two seeds that differ by one must not land on neighbouring
 * values either, or a per-second reseed would walk an agent along the spot list
 * instead of moving it around the floor.
 */
function mixSeed(seed: number, salt: number): number {
  let hash = (seed ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) >>> 0;
  return (hash ^ (hash >>> 13)) >>> 0;
}

function tileKeyOf(tile: OfficeTilePos): string {
  return `${tile.col},${tile.row}`;
}

/**
 * Which way a character ends up turned once it reaches its spot. A spot's own
 * facing looks AT the thing it names, which is what somebody walking up to it
 * does - the sofa is the exception, because you approach one facing it and then
 * turn round, so the room is what you end up looking at.
 */
function arrivalFacingOf(target: OfficeErrandTarget | null): OfficeFacing {
  if (target === null) return "up";
  return target.kind === "sofa" ? "down" : target.facing;
}

/** An errand two agents take TOGETHER, one on each side of the same table. */
function isTwoPlayerKind(kind: OfficeErrandTargetKind): boolean {
  return TWO_PLAYER_KINDS.includes(kind);
}

/**
 * An errand taken SITTING DOWN. The spot's tile is the furniture itself for
 * three of these - a sleeping bag, an armchair, a bench - and the sofa's is the
 * aisle in front of it, but the character reads the same way in all of them:
 * off its feet, and off its own chair.
 *
 * `seated` is deliberately still false throughout. It means "in its own chair",
 * which is what every errand, delivery and hurry rule keys on.
 */
function isSeatedErrandKind(kind: OfficeErrandTargetKind): boolean {
  return (
    kind === "sofa" ||
    kind === "nap" ||
    kind === "read" ||
    kind === "console" ||
    kind === "garden"
  );
}

/**
 * Whether this errand THROWS something. A dart and a crumpled page fly the
 * same arc at the same cadence; only what they are aimed at - which the spot
 * itself carries - and whether a shot can miss differ.
 */
function targetIsThrowable(kind: OfficeErrandTargetKind): boolean {
  return kind === "bin" || kind === "darts";
}

/**
 * Errands whose length is part of what they ARE - a two-second glance through a
 * doorway, three seconds of watering - or `null` for the ones a per-agent seed
 * decides. A game's beat is fixed for a third reason: it is not how long the
 * game lasts but how long this agent will WAIT for somebody to take the other
 * side, and play sets its own clock the moment one does.
 */
function fixedLingerMsFor(kind: OfficeErrandTargetKind): number | null {
  if (kind === "corridor") return STROLL_PAUSE_MS;
  if (kind === "peek") return PEEK_LINGER_MS;
  if (kind === "stairs") return STAIRS_LINGER_MS;
  if (kind === "water-plant") return WATER_PLANT_MS;
  if (isTwoPlayerKind(kind)) return GAME_ALONE_MS;
  return null;
}

interface LingerRange {
  readonly minMs: number;
  readonly spreadMs: number;
}

/**
 * How long a seeded stint runs. A nap outlasts a coffee for the same reason a
 * sofa outlasts a window: what the errand is worth is how long somebody would
 * actually stay.
 */
function seededLingerRangeOf(kind: OfficeErrandTargetKind): LingerRange {
  if (kind === "arcade") {
    return { minMs: ARCADE_LINGER_MIN_MS, spreadMs: ARCADE_LINGER_SPREAD_MS };
  }
  if (kind === "sofa") {
    return { minMs: SOFA_LINGER_MIN_MS, spreadMs: SOFA_LINGER_SPREAD_MS };
  }
  if (kind === "visit") {
    return { minMs: VISIT_LINGER_MIN_MS, spreadMs: VISIT_LINGER_SPREAD_MS };
  }
  if (kind === "nap") {
    return { minMs: NAP_LINGER_MIN_MS, spreadMs: NAP_LINGER_SPREAD_MS };
  }
  if (kind === "read") {
    return { minMs: READ_LINGER_MIN_MS, spreadMs: READ_LINGER_SPREAD_MS };
  }
  if (kind === "console") {
    return { minMs: CONSOLE_LINGER_MIN_MS, spreadMs: CONSOLE_LINGER_SPREAD_MS };
  }
  if (kind === "treadmill") {
    return {
      minMs: TREADMILL_LINGER_MIN_MS,
      spreadMs: TREADMILL_LINGER_SPREAD_MS,
    };
  }
  return { minMs: ERRAND_LINGER_MIN_MS, spreadMs: ERRAND_LINGER_SPREAD_MS };
}

function areAdjacent(left: OfficeTilePos, right: OfficeTilePos): boolean {
  return Math.abs(left.col - right.col) + Math.abs(left.row - right.row) === 1;
}

function withinTileRect(bounds: OfficeTileRect, tile: OfficeTilePos): boolean {
  return (
    tile.col >= bounds.col &&
    tile.col < bounds.col + bounds.cols &&
    tile.row >= bounds.row &&
    tile.row < bounds.row + bounds.rows
  );
}

/** How long a filler of this kind runs, once started. */
function fillerDurationMs(kind: OfficeFillerKind): number {
  if (kind === "look") return FILLER_LOOK_MS;
  if (kind === "stretch") return FILLER_STRETCH_MS;
  return FILLER_SPIN_STEP_MS * FILLER_SPIN_FACINGS.length * FILLER_SPIN_TURNS;
}

/**
 * Which way a character is turned partway through a filler, and how it sits.
 *
 * A look ends back at the SCREEN, which is wherever this seat faces - `up` on
 * the Floor and something else in a view whose desks are turned.
 */
function fillerPoseOf(
  filler: OfficeFiller,
  seatFacing: OfficeFacing,
): {
  readonly pose: OfficeCharacterPose;
  readonly facing: OfficeFacing;
} {
  const elapsed = filler.elapsedMs;
  if (filler.kind === "stretch") return { pose: "stand", facing: "down" };
  if (filler.kind === "spin") {
    const step = Math.floor(elapsed / FILLER_SPIN_STEP_MS);
    return {
      pose: "stand",
      facing: FILLER_SPIN_FACINGS[step % FILLER_SPIN_FACINGS.length],
    };
  }
  // Looking around: left, then right, then back to the screen.
  if (elapsed < FILLER_LOOK_STEP_MS) return { pose: "stand", facing: "left" };
  if (elapsed < FILLER_LOOK_STEP_MS * 2) {
    return { pose: "stand", facing: "right" };
  }
  return { pose: "stand", facing: seatFacing };
}

/**
 * Everything the floor plan depends on. Names and archive flags are
 * deliberately absent: a rename must not restack the office. The HOST is not,
 * because it decides which storey the agent lives on.
 */
function agentSetSignature(agents: ReadonlyArray<OfficeAgentInput>): string {
  return agents
    .map(
      (agent) =>
        `${agent.id}\u0000${agent.parentId ?? ""}\u0000${agent.createdAt}\u0000${agent.hostId ?? ""}`,
    )
    .sort()
    .join("\u0001");
}

/** The names alone, so a rename is detectable without being a re-layout. */
function agentNameSignature(agents: ReadonlyArray<OfficeAgentInput>): string {
  return agents
    .map((agent) => `${agent.id}\u0000${agent.name}`)
    .sort()
    .join("\u0001");
}

/**
 * The same floor plan with every cabin sign, pod plate and piece of lettering
 * re-lettered from the current agent names. Geometry is untouched, so nothing
 * that was placed moves.
 *
 * The SIGNS are refreshed as well as the rooms and pods they were copied from.
 * They are what the renderer actually draws, so re-lettering only the source
 * would rename the room in the hover card and leave the wall saying the old
 * name - which is the shape of bug a copied string always eventually has.
 *
 * SIGNS ARE THE SOURCE for a room's name, not `rootAgentId`. A room id is a
 * key that `seat.roomId` resolves to and nothing more: a view that splits a
 * large team across several rooms makes it up, so resolving it as an agent
 * would silently name the wrong person - or nobody - on exactly the layouts
 * where rooms outnumber leads. A pod's `leadAgentId` IS an agent, and stays
 * one.
 */
function withRefreshedNames(
  layout: OfficeLayout,
  agentById: ReadonlyMap<string, OfficeAgentInput>,
): OfficeLayout {
  const signs = layout.signs.map((sign) => {
    const owner = sign.ownerAgentId;
    if (owner === null) return sign;
    const name = agentById.get(owner)?.name;
    if (name === undefined || name === sign.text) return sign;
    return { ...sign, text: name };
  });
  const roomNames = new Map<string, string>();
  for (const sign of signs) {
    if (sign.kind !== "room") continue;
    roomNames.set(tileKeyOf(sign.tile), sign.text);
  }
  return {
    ...layout,
    rooms: layout.rooms.map((room) => ({
      ...room,
      name: roomNames.get(tileKeyOf(room.signTile)) ?? room.name,
      pods: room.pods.map((pod) => ({
        ...pod,
        name: agentById.get(pod.leadAgentId)?.name ?? pod.name,
      })),
    })),
    signs,
  };
}

function facingFor(dCol: number, dRow: number): OfficeFacing | null {
  if (Math.abs(dCol) >= Math.abs(dRow) && dCol !== 0) {
    return dCol > 0 ? "right" : "left";
  }
  if (dRow !== 0) return dRow > 0 ? "down" : "up";
  return null;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function sameTile(
  left: OfficeTilePos | null,
  right: OfficeTilePos | null,
): boolean {
  if (left === null || right === null) return false;
  return left.col === right.col && left.row === right.row;
}

/**
 * An in-flight envelope's clickable box: its sprite, padded, so a target that
 * is both small and moving can still be hit.
 */
function envelopeHitRegionsOf(
  overlay: ReadonlyArray<OfficeDrawable>,
): ReadonlyArray<OfficeEnvelopeHitRegion> {
  const size = officeSpriteSize({ name: "envelope" });
  const regions: OfficeEnvelopeHitRegion[] = [];
  for (const drawable of overlay) {
    if (drawable.kind !== "envelope") continue;
    regions.push({
      edgeId: drawable.edgeId,
      rect: {
        x: drawable.x - size.width / 2 - ENVELOPE_HIT_PADDING,
        y: drawable.y - size.height / 2 - ENVELOPE_HIT_PADDING,
        width: size.width + ENVELOPE_HIT_PADDING * 2,
        height: size.height + ENVELOPE_HIT_PADDING * 2,
      },
    });
  }
  return regions;
}

function containsPoint(rect: OfficeRect, point: OfficePoint): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function isCreatedPulseFor(
  pulse: CommGraphPulse | null,
  agentId: string,
): boolean {
  if (pulse === null) return false;
  if (pulse.kind !== "edge") return false;
  return pulse.pulseKind === "created" && pulse.toAgentId === agentId;
}

function pulseSenderId(pulse: CommGraphPulse | null): string | null {
  if (pulse === null) return null;
  return pulse.kind === "edge" ? pulse.fromAgentId : pulse.senderAgentId;
}

/**
 * The fields every character starts with however it arrives, so a walk-in and a
 * silently seated agent cannot drift apart as fields are added.
 */
function blankCharacter(agentId: string): OfficeCharacter {
  return {
    agentId,
    col: 0,
    row: 0,
    facing: "up",
    seated: true,
    path: [],
    pathIndex: 0,
    walkPhaseMs: 0,
    idleMs: 0,
    bubble: null,
    sparkleMs: 0,
    errand: "none",
    waitMs: 0,
    lingerTotalMs: 0,
    queueTile: null,
    errandTarget: null,
    lastErrandKey: null,
    lastErrandKind: null,
    errandLegs: 0,
    errandLegsWanted: 0,
    rallying: false,
    throwsLeft: 0,
    nextThrowMs: 0,
    filler: null,
    // Staggered from the id, so a room of idle agents does not stretch in unison
    // on the very first frame they are all still.
    nextFillerMs:
      FILLER_GAP_MIN_MS + (hashAgentId(agentId) % FILLER_GAP_SPREAD_MS),
    fillerCount: 0,
    pending: [],
    hurrying: false,
  };
}

function seatedCharacter(agentId: string, seat: OfficeSeat): OfficeCharacter {
  return {
    ...blankCharacter(agentId),
    col: seat.chairTile.col,
    row: seat.chairTile.row,
    // Seated means facing the screen, which the SEAT knows about and the scene
    // does not: `up` on the Floor, and something else wherever a view turns a
    // desk round.
    facing: seat.facing,
    seated: true,
  };
}

/** An agent and the seat it is actually in - the claim, or the assignment. */
interface SeatedAgent {
  readonly agentId: string;
  readonly seat: OfficeSeat;
}

/** Everything that stands still, bucketed by chunk. Rebuilt per layout. */
interface FrameChunkIndex {
  readonly seats: ReadonlyMap<string, ReadonlyArray<OfficeSeat>>;
  readonly spots: ReadonlyMap<string, ReadonlyArray<OfficeErrandSpot>>;
}

interface CachedSeatProps {
  readonly key: string;
  readonly drawables: ReadonlyArray<OfficeWorldDrawable>;
}

/** One painted floor and the three things that decide what it contains. */
interface CachedFloor {
  readonly key: string;
  readonly drawables: ReadonlyArray<OfficeDrawable>;
}

/** What a floor was asked for: the plan, the band, and the rectangle of it. */
function floorKeyOf(
  layoutVersion: number,
  lod: OfficeLod,
  tiles: OfficeTileRect,
): string {
  return `${layoutVersion}|${lod}|${tiles.col},${tiles.row},${tiles.cols},${tiles.rows}`;
}

function compareIdPair(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Everything about a desk that changes what it LOOKS like, as one string.
 *
 * The cache this keys exists because a floor of idle agents produces the
 * identical desk drawables on every frame, and rebuilding them is most of what
 * a still office used to spend its frame budget on.
 */
function deskStateKey(state: OfficeDeskState): string {
  return [
    state.agentId ?? "",
    state.name ?? "",
    state.status,
    state.sheeted ? "1" : "0",
    state.openRequests,
    state.screenFrame,
    state.harnessId ?? "",
    state.modelTier,
    state.accentId ?? "",
  ].join("|");
}

/**
 * One depth-ordered stream out of the two halves a world painter emits.
 *
 * Stable within a depth, and the PROPS come first at equal depth: a desk front
 * carries its occupant's own depth plus a hair, so a painter that wants to
 * cover a lap says so with the depth rather than relying on which array it
 * came from.
 */
function mergeByDepth(
  props: ReadonlyArray<OfficeWorldDrawable>,
  actors: ReadonlyArray<OfficeWorldDrawable>,
): ReadonlyArray<OfficeWorldDrawable> {
  const merged = [...props, ...actors];
  merged.sort((left, right) => left.depth - right.depth);
  return merged;
}

/** The tile one step AGAINST a facing: where somebody looking that way stands. */
function stepAgainst(tile: OfficeTilePos, facing: OfficeFacing): OfficeTilePos {
  if (facing === "up") return { col: tile.col, row: tile.row + 1 };
  if (facing === "down") return { col: tile.col, row: tile.row - 1 };
  if (facing === "left") return { col: tile.col + 1, row: tile.row };
  return { col: tile.col - 1, row: tile.row };
}

function characterAlpha(
  archived: boolean,
  inCubby: boolean,
): number | undefined {
  if (archived) return ARCHIVED_ALPHA;
  return inCubby ? CUBBY_OCCUPANT_ALPHA : undefined;
}

const NO_AWAY_IDS: ReadonlySet<string> = new Set<string>();

/** What a scene with no layout answers with: a frame of nothing, at no size. */
function emptyFrame(): OfficeFrame {
  return {
    size: { width: 0, height: 0 },
    staticVersion: 0,
    floor: [],
    props: [],
    actors: [],
    world: null,
    overlay: [],
    hitRegions: [],
    envelopeHitRegions: [],
    awayAgentIds: NO_AWAY_IDS,
    focus: null,
  };
}

/** The mark an overview pip wears, so state is never colour alone. */
function pipGlyphOf(status: OfficeAgentStatus): OfficePipGlyph {
  if (status === "attention" || status === "failure") return "bang";
  if (status === "awaiting") return "ring";
  if (status === "archived") return "hollow";
  return "none";
}

/** Which index chunk a tile falls in; the key both halves of the index use. */
function chunkKeyOf(col: number, row: number): string {
  return `${Math.floor(col / FRAME_CHUNK_TILES)},${Math.floor(row / FRAME_CHUNK_TILES)}`;
}

function rectsOverlap(a: OfficeRect, b: OfficeRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** The rect grown by the cull margin on every side. */
function grownBy(rect: OfficeRect, margin: number): OfficeRect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

/** The whole tiles a world-pixel rect touches, clamped to nothing. */
function tileRectOf(rect: OfficeRect): OfficeTileRect {
  const col = Math.floor(rect.x / OFFICE_TILE);
  const row = Math.floor(rect.y / OFFICE_TILE);
  return {
    col,
    row,
    cols: Math.ceil((rect.x + rect.width) / OFFICE_TILE) - col,
    rows: Math.ceil((rect.y + rect.height) / OFFICE_TILE) - row,
  };
}

export class OfficeScene {
  private readonly view: OfficeView;
  /**
   * The plan in force, or `null` until the first sync makes one.
   *
   * Deliberately not a plan of `[]` at construction. An empty plan is a real
   * packing pass over a world nobody asked for - and for a view whose shape
   * reads the viewport, it is a packing pass against a viewport that does not
   * exist yet. The canvas does not build a scene until its inputs are ready,
   * so the gap between here and the first sync is where nothing happens.
   */
  private layoutOrNull: OfficeLayout | null = null;
  private projectorOrNull: OfficeProjector | null = null;
  /**
   * WHO SITS WHERE. The scene owns it and every routine that needs a seat asks
   * it rather than reading `layout.desks`, which is only ever the plan's
   * opening offer.
   */
  private readonly seats = new OfficeSeatBook();
  private partition: OfficePopulation | null = null;
  private activityById: ReadonlyMap<string, number> = new Map<string, number>();
  private viewport: OfficeSize = { width: 0, height: 0 };
  /**
   * How far the world moved on the last plan, until somebody takes it.
   *
   * The scene translates its own state by the shift; the CAMERA is the
   * renderer's, so the delta is left here to be collected once and applied
   * there. Consumed rather than reported on the frame, because a frame is
   * built many times per shift and would otherwise pan the camera on each.
   */
  private pendingShift: OfficePoint | null = null;
  private readonly characters = new Map<string, OfficeCharacter>();
  private envelopes: OfficeEnvelope[] = [];
  private paperBalls: OfficePaperBall[] = [];
  private agentById = new Map<string, OfficeAgentInput>();
  private visibleAgentIds: ReadonlySet<string> = new Set<string>();
  private statusById: ReadonlyMap<string, OfficeAgentStatus> = new Map<
    string,
    OfficeAgentStatus
  >();
  private openRequestsByReceiver: ReadonlyMap<string, number> = new Map<
    string,
    number
  >();
  private agentSignature: string | null = null;
  private nameSignature = "";
  private pulse: CommGraphPulse | null = null;
  private lastPulseKey: string | null = null;
  private playing = false;
  private reducedMotion = false;
  private stepMs = 0;
  private cursorMs: number | null = null;
  private clockMs = 0;
  private nowMs = 0;
  private synced = false;
  /** Archived AS OF the cursor at the last sync; the walk-out reads changes. */
  private archivedIds: ReadonlySet<string> = new Set<string>();
  /** Archived agents whose character has already walked out; their desk is sheeted. */
  private readonly departedIds = new Set<string>();
  /** Agents un-archived by a scrub back, which walk in again on this sync. */
  private readonly returningIds = new Set<string>();
  /** Agents needing a person, in the order they were first seen needing one. */
  private queueOrder: string[] = [];

  /**
   * Bumped on every layout replacement, and on nothing else.
   *
   * It is the renderer's cache key for the floor, so it has to move whenever
   * `buildFloor` would produce something different and stay put otherwise -
   * which is exactly the lifetime of `currentLayout`, the only thing that
   * function reads.
   */
  private layoutVersion = 0;
  /**
   * Bumped whenever a character is ADDED or REMOVED, and on nothing else.
   *
   * `orderedByAgentId` sorts by identity alone, so movement cannot reorder it
   * - only membership can. That matters because the partner lookups call it
   * once per character per tick, which without a cache is a sort per character
   * per tick to answer a question whose answer did not change.
   */
  private membershipVersion = 0;
  private byAgentIdCache: ReadonlyArray<OfficeCharacter> | null = null;
  private byAgentIdVersion = -1;
  /**
   * Cleared around every mutation, since draw order depends on POSITION and
   * every character moves. Within one `frame()` nothing mutates, so the three
   * passes that need it share one sort.
   */
  private orderedCache: ReadonlyArray<OfficeCharacter> | null = null;
  /**
   * Seats and spots by index chunk, rebuilt once per layout.
   *
   * `frame` is bounded by the viewport rather than by the population, and this
   * is what makes that true: without it, finding the forty desks on screen in
   * a thousand-agent office is a walk over a thousand desks, thirty times a
   * second.
   */
  private chunkIndex: FrameChunkIndex | null = null;
  private chunkIndexVersion = -1;
  /** Seat props by seat, keyed by the desk state that produced them. */
  private readonly seatPropCache = new Map<string, CachedSeatProps>();
  private seatPropVersion = -1;
  /**
   * The last floor the painter was asked for, and what it was asked for.
   *
   * The floor is a pure function of the layout, the band and the rectangle, and
   * on a still office all three hold from frame to frame - so a floor of
   * thousands of tile drawables is built once and handed back by identity,
   * which is also what lets the renderer's own bitmap cache skip a repaint.
   */
  private floorCache: CachedFloor | null = null;

  /**
   * A view and, optionally, the layout to answer with until the first sync.
   *
   * The view is a VALUE - three pure functions and two strings - so a scene is
   * bound to one for life and a view change is a new scene through the
   * renderer's own unmount path. There is no view id anywhere below this line.
   */
  constructor(view: OfficeView, initialLayout: OfficeLayout | null) {
    this.view = view;
    if (initialLayout === null) return;
    this.installLayout(initialLayout);
  }

  /** The plan in force, or `null` before the first sync has made one. */
  layout(): OfficeLayout | null {
    return this.layoutOrNull;
  }

  /**
   * How big the world is, in canvas pixels - the projector's bounds, which is
   * `frame().size` without building a frame.
   *
   * Answered separately because the CAMERA has to settle before the frame is
   * built: a frame is culled to what the camera can see, so fitting the camera
   * to a size read off that frame would fit it to the previous framing. Zero
   * before the first plan.
   */
  worldSize(): OfficeSize {
    const projector = this.projectorOrNull;
    if (projector === null) return { width: 0, height: 0 };
    return { width: projector.bounds.width, height: projector.bounds.height };
  }

  /**
   * How far the world moved since the caller last asked, in world pixels, or
   * `null` where it has not. Taken once: the renderer pans the camera back by
   * it so a building that grew a storey does not jump on screen.
   */
  takeShift(): OfficePoint | null {
    const shift = this.pendingShift;
    this.pendingShift = null;
    return shift;
  }

  /**
   * Stops holding anything DERIVED. The logical state - who is where, what is
   * in flight - stays, because that is what makes the return a single sync
   * rather than a re-materialized floor.
   *
   * The scene keeps no suspended FLAG. Whether an office is off screen is the
   * renderer's question - it owns the four signals that decide it - and a
   * second copy here could only ever disagree with the one that matters. What
   * `suspend` changes is what the scene is holding, nothing more.
   */
  suspend(): void {
    this.orderedCache = null;
    this.byAgentIdCache = null;
    this.byAgentIdVersion = -1;
    this.chunkIndex = null;
    this.chunkIndexVersion = -1;
    this.seatPropCache.clear();
    this.seatPropVersion = -1;
    this.floorCache = null;
  }

  /**
   * Back on screen: ONE sync, with whatever rows went by while it was away
   * suppressed. Replaying them would fly a burst of envelopes across a floor
   * nobody was watching; the input carries the state those rows led to, which
   * is the thing actually worth showing.
   */
  resume(input: OfficeSceneInput): void {
    // Adopted BEFORE the sync, so the pulse-key check inside it sees the row
    // as already seen and `applyPulse` never fires for it.
    this.lastPulseKey = input.pulseKey;
    this.sync(input);
    this.dropTransientMotion();
  }

  sync(input: OfficeSceneInput): void {
    const firstSync = !this.synced;
    this.synced = true;
    this.orderedCache = null;
    this.visibleAgentIds = input.visibleAgentIds;
    this.statusById = input.statusById;
    this.openRequestsByReceiver = input.openRequestsByReceiver;
    this.playing = input.playing;
    // Both transitions are read BEFORE the new values are stored, and neither
    // fires on the first sync, where there is nothing in flight to end.
    const motionJustReduced = input.reducedMotion && !this.reducedMotion;
    const rewound = this.cursorRewoundBy(input);
    this.reducedMotion = input.reducedMotion;
    this.stepMs = input.stepMs;
    this.cursorMs = input.cursorMs;
    this.clockMs = input.clockMs;
    this.pulse = input.pulse;
    this.partition = input.partition;
    this.activityById = input.activityById;
    this.viewport = input.viewport;
    this.agentById = new Map(input.agents.map((agent) => [agent.id, agent]));
    if (!firstSync) {
      // The flag governs what STARTS; what is already in flight has to be
      // told. A person who just asked for less motion should not watch the
      // envelope and the walk they asked to skip play out for another few
      // seconds.
      if (motionJustReduced) this.settleMotion();
      if (rewound) this.dropTransientMotion();
    }

    this.adoptLayout(input.agents);
    if (rewound) {
      // A scrub back cannot replay the walks that led to today's claims, so it
      // does not try: they are re-derived from the statuses as of the cursor,
      // the same treatment the rest of the in-flight state gets.
      this.seats.recomputeClaims(input.statusById, this.seats.knownAgentIds());
    }
    this.applyArchivalTransitions(input, firstSync);
    this.reconcileCharacters(input, firstSync);
    this.returningIds.clear();
    this.updateSeatClaims();
    // An errand ends on the sync that ends it, not on the tick after: playback
    // starting or an agent picking work back up are both seen here first.
    for (const character of this.characters.values()) {
      if (!this.onCancellableErrand(character)) continue;
      if (!this.errandMustEnd(character.agentId)) continue;
      this.returnToDesk(character);
    }
    this.updateReceptionQueue();

    if (input.pulseKey !== this.lastPulseKey) {
      this.lastPulseKey = input.pulseKey;
      // A first sync MATERIALIZES the floor as of the cursor; it does not
      // replay the row the cursor happens to be sitting on.
      if (!firstSync) this.applyPulse(input.pulse);
    }
    this.orderedCache = null;
  }

  tick(dtMs: number): void {
    if (dtMs <= 0) return;
    // Cleared on the way IN as well as out: the errand logic below reads the
    // ordering while it is moving characters, so a cache built before the tick
    // would be handed to it stale.
    this.orderedCache = null;
    this.nowMs += dtMs;
    for (const character of this.characters.values()) {
      this.advanceCharacter(character, dtMs);
    }
    this.updateErrandStarts();
    this.advanceEnvelopes(dtMs);
    this.advancePaperBalls(dtMs);
    this.orderedCache = null;
  }

  /**
   * One frame, for one level of detail and one rectangle of world.
   *
   * Both arguments are load-bearing. The RECT is what makes the cost of a
   * frame a fact about the viewport rather than about the population: nothing
   * outside it plus the cull margin is built, hit-tested or reported away. The
   * LOD is what the floor is asked for - a block map at overview, tiles
   * otherwise - and at overview it is also all there is of a character: one
   * pip carrying a state glyph, because sixteen pixels of pixel art at 0.3x is
   * a smudge and thirty thousand of them is a smudge that costs a bitmap.
   */
  frame(lod: OfficeLod, view: OfficeRect): OfficeFrame {
    const layout = this.layoutOrNull;
    const projector = this.projectorOrNull;
    if (layout === null || projector === null) return emptyFrame();
    const rect = grownBy(view, OFFICE_CULL_MARGIN_PX);
    const floor = this.floorIn(layout, tileRectOf(rect), lod);
    const overlay = lod === 0 ? this.buildEnvelopes() : this.buildOverlay(rect);
    const characters = this.charactersIn(rect);
    const seats = this.seatsIn(rect);
    const size: OfficeSize = {
      width: projector.bounds.width,
      height: projector.bounds.height,
    };
    if (lod === 0) {
      return {
        size,
        staticVersion: this.layoutVersion,
        floor,
        props: [],
        actors: this.buildPips(characters),
        world: null,
        overlay,
        hitRegions: this.buildHitRegions(characters, seats),
        envelopeHitRegions: envelopeHitRegionsOf(overlay),
        awayAgentIds: this.awayAgentIdsAmong(characters),
        focus: this.focusPoint(),
      };
    }
    const props = this.buildSeatProps({ layout, seats, rect, lod });
    const actors = this.buildActors(characters, lod);
    const layered = this.view.painter.depth === "layered";
    return {
      size,
      staticVersion: this.layoutVersion,
      floor,
      props: layered ? props.map((entry) => entry.drawable) : [],
      actors: layered ? actors.map((entry) => entry.drawable) : [],
      world: layered ? null : mergeByDepth(props, actors),
      overlay,
      hitRegions: this.buildHitRegions(characters, seats),
      envelopeHitRegions: envelopeHitRegionsOf(overlay),
      awayAgentIds: this.awayAgentIdsAmong(characters),
      focus: this.focusPoint(),
    };
  }

  /**
   * Where to point the camera for this agent: its seat's box, or its own where
   * it is away from that seat.
   *
   * Answered from the seat book and the projector rather than from the last
   * frame, so it works for an agent nowhere near the view rect - which is the
   * only kind the directory and Find ever ask about.
   */
  locate(agentId: string): OfficeRect | null {
    const projector = this.projectorOrNull;
    if (projector === null) return null;
    const character = this.characters.get(agentId);
    // An agent AWAY from its chair is answered from its own box, which is the
    // same foot-point derivation the frame drew it with - and a walker is
    // between two tiles for most of a journey, so a tile rounded from its
    // position would point the camera up to a tile away from the person.
    if (character !== undefined && !character.seated) {
      return this.characterBox(character);
    }
    return this.seats.locate(agentId, projector, null);
  }

  /**
   * The hover card's "where" line: the place this agent is, in the words the
   * floor plan uses for it.
   *
   * Derived from the effective seat and the character's own motion, never from
   * a label the plan carried - a plan-only label is a string that stops being
   * true the moment somebody walks.
   */
  whereabouts(agentId: string): string | null {
    const layout = this.layoutOrNull;
    if (layout === null) return null;
    const character = this.characters.get(agentId);
    if (character !== undefined && !character.seated) {
      return this.awayWhereabouts(layout, character);
    }
    const seat = this.seats.effectiveSeat(agentId);
    if (seat === null) return null;
    if (seat.kind === "cubby") return "Quiet stack";
    const room = this.roomOfSeat(seat);
    if (room !== null) return room.name;
    return this.placeNameAt(layout, seat.chairTile, seat.floorIndex);
  }

  /** Characters win over desks: a person is the more specific target. */
  hitTest(point: OfficePoint): string | null {
    const layout = this.layoutOrNull;
    if (layout === null) return null;
    // The point plus a tile of slack: the regions are culled, so asking for a
    // rect that could not contain the point would answer nothing.
    const rect: OfficeRect = {
      x: point.x - OFFICE_TILE,
      y: point.y - OFFICE_TILE,
      width: OFFICE_TILE * 2,
      height: OFFICE_TILE * 2,
    };
    const regions = this.buildHitRegions(
      this.charactersIn(rect),
      this.seatsIn(rect),
    );
    for (const region of regions) {
      if (containsPoint(region.rect, point)) return region.agentId;
    }
    return null;
  }

  /**
   * The pair edge of the envelope under the point, topmost first - a message
   * is a more specific target than the floor it happens to be flying over, so
   * the canvas asks this BEFORE `hitTest`.
   */
  hitTestEnvelope(point: OfficePoint): string | null {
    if (this.layoutOrNull === null) return null;
    const regions = envelopeHitRegionsOf(this.buildEnvelopes());
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      const region = regions[index];
      if (containsPoint(region.rect, point)) return region.edgeId;
    }
    return null;
  }

  /**
   * The plan in force.
   *
   * Every private routine below reads this rather than carrying a layout
   * argument through thirty call sites. It is valid from the first sync
   * onward, which every public entry point above has already checked - so the
   * throw is a statement about this class's own invariant rather than a case
   * anything downstream has to handle.
   */
  private get currentLayout(): OfficeLayout {
    const layout = this.layoutOrNull;
    if (layout === null) {
      throw new Error("OfficeScene: no layout before the first sync");
    }
    return layout;
  }

  private get projector(): OfficeProjector {
    const projector = this.projectorOrNull;
    if (projector === null) {
      throw new Error("OfficeScene: no projector before the first sync");
    }
    return projector;
  }

  /** A tile, projected. EVERY point the scene emits goes through here. */
  private point(col: number, row: number): OfficePoint {
    return this.projector.project(col, row);
  }

  /**
   * WHERE A PERSON'S FEET ARE: the projected bottom centre of the tile they
   * stand on, fractional col and row included, because a walker is between two
   * tiles for most of its journey.
   *
   * Every character-relative point in the scene is derived from this one -
   * sprite corner, hit box, name tag, bubble, envelope endpoint, world depth -
   * rather than from the tile's top-left plus a hand-tuned offset. The offset
   * was a fact about the identity projector: on an oblique or isometric one a
   * tile's top-left is not above its own floor, and a sprite hung from it
   * stands beside the person it belongs to. The foot point is the same pixel
   * in every projection, which is why it is the one the others hang off.
   */
  private footPoint(col: number, row: number): OfficePoint {
    return this.projector.project(col + 0.5, row + 1);
  }

  /** The sprite corner for a 16x20 character standing at `foot`. */
  private spriteCornerOf(foot: OfficePoint): OfficePoint {
    return {
      x: foot.x - OFFICE_CHARACTER_WIDTH / 2,
      y: foot.y - OFFICE_CHARACTER_HEIGHT,
    };
  }

  /** Takes up a layout and the projector that goes with it, as one step. */
  private installLayout(layout: OfficeLayout): void {
    this.layoutOrNull = layout;
    this.projectorOrNull = this.view.painter.projector(layout);
    this.layoutVersion += 1;
    this.chunkIndex = null;
    this.chunkIndexVersion = -1;
    this.seatPropCache.clear();
  }

  // ---- Population ---------------------------------------------------- //

  /**
   * Archived AS OF THE CURSOR, which is the only reading a scrubbable floor
   * can use: `archivedAt` is a moment on the same timeline the cursor sits on,
   * so a record archived after the cursor is still at its desk in that view.
   */
  private isArchivedAsOf(agent: OfficeAgentInput): boolean {
    return officeArchivedAsOf(agent.archivedAt, this.cursorMs);
  }

  /**
   * Archiving is a DEPARTURE, not a state flip: the character stands, walks to
   * its floor's door and is gone, and only then does the desk get its sheet.
   * Scrubbing back un-archives, and the same person walks in again.
   */
  private applyArchivalTransitions(
    input: OfficeSceneInput,
    firstSync: boolean,
  ): void {
    const archived = new Set<string>();
    for (const agent of input.agents) {
      if (this.isArchivedAsOf(agent)) archived.add(agent.id);
    }
    // No walk on the first sync or with motion reduced: the floor is being
    // MATERIALIZED as of the cursor, and a departure nobody saw begin is just
    // an empty desk.
    const instant = firstSync || input.reducedMotion;
    this.sendArchivedHome(input, archived, instant);
    this.readmitUnarchived(input, archived, instant);
    // A character mid-departure whose agent is no longer archived turns
    // around: the cursor moved back before the archival, so the walk it was
    // performing never happened.
    for (const character of this.characters.values()) {
      if (character.errand !== "leaving") continue;
      if (archived.has(character.agentId)) continue;
      this.returnToDesk(character);
    }
    this.archivedIds = archived;
  }

  /** Starts the walk out, or removes the character outright when instant. */
  private sendArchivedHome(
    input: OfficeSceneInput,
    archived: ReadonlySet<string>,
    instant: boolean,
  ): void {
    for (const agentId of archived) {
      if (this.departedIds.has(agentId)) continue;
      const character = this.characters.get(agentId);
      if (character === undefined || !input.visibleAgentIds.has(agentId)) {
        this.departedIds.add(agentId);
        continue;
      }
      if (instant) {
        this.characters.delete(agentId);
        this.membershipVersion += 1;
        this.departedIds.add(agentId);
        continue;
      }
      if (character.errand === "leaving") continue;
      this.startLeaving(character);
    }
  }

  /** Queues a walk back in for anyone the cursor has moved back before. */
  private readmitUnarchived(
    input: OfficeSceneInput,
    archived: ReadonlySet<string>,
    instant: boolean,
  ): void {
    for (const agentId of Array.from(this.departedIds)) {
      if (archived.has(agentId)) continue;
      this.departedIds.delete(agentId);
      if (instant) continue;
      if (!input.visibleAgentIds.has(agentId)) continue;
      this.returningIds.add(agentId);
    }
  }

  private reconcileCharacters(
    input: OfficeSceneInput,
    firstSync: boolean,
  ): void {
    for (const agentId of Array.from(this.characters.keys())) {
      if (input.visibleAgentIds.has(agentId)) continue;
      this.removeCharacter(agentId);
    }
    // Fast playback outruns a walk: the newcomer would still be crossing the
    // floor when the next row is drawn, so the arrival is a sparkle instead.
    const fastPlayback = input.playing && input.stepMs < FAST_PLAYBACK_STEP_MS;
    for (const agent of input.agents) {
      if (!input.visibleAgentIds.has(agent.id)) continue;
      if (this.characters.has(agent.id)) continue;
      if (this.departedIds.has(agent.id)) continue;
      const seat = this.seats.effectiveSeat(agent.id);
      if (seat === null) continue;
      // Walking in is what a REVEAL looks like: playback advancing, the cursor
      // resting on the very row that created this agent, or a scrub back past
      // its archival. A hand-scrubbed jump and a live arrival while paused are
      // not reveals - they are the floor being restated - so those seat
      // silently.
      const revealed =
        this.returningIds.has(agent.id) ||
        input.playing ||
        isCreatedPulseFor(input.pulse, agent.id);
      const announced = !firstSync && !input.reducedMotion && revealed;
      if (announced && !fastPlayback) {
        this.characters.set(agent.id, this.spawnAtDoor(agent.id, seat));
        this.membershipVersion += 1;
        continue;
      }
      const character = seatedCharacter(agent.id, seat);
      if (announced) character.sparkleMs = SPARKLE_MS;
      this.characters.set(agent.id, character);
      this.membershipVersion += 1;
    }
  }

  private removeCharacter(agentId: string): void {
    this.characters.delete(agentId);
    this.membershipVersion += 1;
    this.envelopes = this.envelopes.filter(
      (envelope) =>
        envelope.fromAgentId !== agentId && envelope.toAgentId !== agentId,
    );
  }

  private spawnAtDoor(agentId: string, seat: OfficeSeat): OfficeCharacter {
    const door = this.floorOfAgent(agentId).doorTile;
    const path = findOfficePath(this.currentLayout, door, seat.chairTile);
    if (path === null || path.length === 0) {
      return seatedCharacter(agentId, seat);
    }
    return {
      ...blankCharacter(agentId),
      col: door.col,
      row: door.row,
      seated: false,
      path,
      errand: "arriving",
    };
  }

  /**
   * After a re-layout, everyone whose desk MOVED walks to the new one; everyone
   * whose desk stayed put keeps their exact position. Comparing destinations
   * rather than current positions is what keeps a walker that is already headed
   * to the right chair from being restarted every re-layout.
   *
   * A departure and a reception queue are left alone: those are not headed for
   * a chair at all, and their own updaters re-target them on this same sync.
   */
  private rehomeCharacters(moved: ReadonlyArray<string>): void {
    for (const agentId of moved) {
      const character = this.characters.get(agentId);
      if (character === undefined) continue;
      if (character.errand === "leaving") continue;
      if (this.inReceptionQueue(character)) continue;
      const seat = this.seats.effectiveSeat(agentId);
      if (seat === null) continue;
      const destination = this.destinationOf(character);
      if (
        destination.col === seat.chairTile.col &&
        destination.row === seat.chairTile.row
      ) {
        continue;
      }
      this.returnToDesk(character);
    }
  }

  private destinationOf(character: OfficeCharacter): OfficeTilePos {
    const last = character.path.at(-1);
    if (!character.seated && last !== undefined) return last;
    return { col: Math.round(character.col), row: Math.round(character.row) };
  }

  private startTileOf(character: OfficeCharacter): OfficeTilePos {
    return { col: Math.round(character.col), row: Math.round(character.row) };
  }

  /** Walks toward `goal`, or lands on it outright when there is no route. */
  private walkTo(character: OfficeCharacter, goal: OfficeTilePos): boolean {
    const start = this.startTileOf(character);
    const path = this.reducedMotion
      ? null
      : findOfficePath(this.currentLayout, start, goal);
    if (path === null || path.length === 0) {
      character.col = goal.col;
      character.row = goal.row;
      character.path = [];
      character.pathIndex = 0;
      character.idleMs = 0;
      return false;
    }
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    return true;
  }

  /** Back to its own chair, from an errand, a queue or a moved desk. */
  private returnToDesk(character: OfficeCharacter): void {
    const seat = this.seats.effectiveSeat(character.agentId);
    if (seat === null) {
      character.errand = "none";
      character.waitMs = 0;
      character.queueTile = null;
      character.errandTarget = null;
      return;
    }
    const fromErrand = this.onErrand(character);
    character.queueTile = null;
    character.waitMs = 0;
    character.filler = null;
    if (this.walkTo(character, seat.chairTile)) {
      character.errand = fromErrand ? "errand-return" : "returning";
      return;
    }
    // No route, or motion is reduced: sitting down IS the return.
    this.settleInChair(character);
  }

  /**
   * Everything that has to be true the instant a character is back in its seat,
   * wherever it came from: the errand released and any message that landed
   * while it was away finally acknowledged.
   */
  private settleInChair(character: OfficeCharacter): void {
    const seat = this.seats.effectiveSeat(character.agentId);
    // The SEAT says which way its occupant looks; `up` was only ever the
    // Floor's answer to that question.
    character.facing = seat === null ? "up" : seat.facing;
    character.seated = true;
    character.path = [];
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "none";
    character.waitMs = 0;
    character.queueTile = null;
    character.errandTarget = null;
    character.errandLegs = 0;
    character.throwsLeft = 0;
    character.rallying = false;
    // Arrived: the hurry is over because the thing it was for has happened.
    character.hurrying = false;
    this.flushPending(character);
  }

  private startLeaving(character: OfficeCharacter): void {
    const door = this.floorOfAgent(character.agentId).doorTile;
    const start = this.startTileOf(character);
    const path = findOfficePath(this.currentLayout, start, door);
    if (path === null || path.length === 0) {
      this.depart(character.agentId);
      return;
    }
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "leaving";
    character.queueTile = null;
    character.waitMs = 0;
    character.hurrying = false;
  }

  private depart(agentId: string): void {
    this.removeCharacter(agentId);
    this.departedIds.add(agentId);
  }

  // ---- Reception ------------------------------------------------------ //

  private inReceptionQueue(character: OfficeCharacter): boolean {
    return (
      character.errand === "queue-out" || character.errand === "queue-stand"
    );
  }

  private needsReception(agentId: string): boolean {
    const status = this.statusOf(agentId);
    if (status !== "attention" && status !== "failure") return false;
    if (!this.visibleAgentIds.has(agentId)) return false;
    if (this.archivedIds.has(agentId)) return false;
    return this.characters.has(agentId);
  }

  /**
   * Whoever needs a person queues at their own floor's reception, in the order
   * they started needing one. Arrival order is kept as a list rather than
   * re-derived, because "who got here first" is not recoverable from the
   * statuses alone; newcomers within one sync break their tie by id so the
   * queue is still a function of the data.
   *
   * A floor with more people needing help than it has standing room leaves the
   * overflow at their desks, bubble and all - a queue that grew past the lobby
   * would read as a crowd, and there is nowhere to put them anyway.
   */
  private updateReceptionQueue(): void {
    const needy = new Set<string>();
    for (const agentId of this.characters.keys()) {
      if (this.needsReception(agentId)) needy.add(agentId);
    }
    this.queueOrder = this.queueOrder.filter((agentId) => needy.has(agentId));
    const known = new Set(this.queueOrder);
    const newcomers: string[] = [];
    for (const agentId of needy) {
      if (!known.has(agentId)) newcomers.push(agentId);
    }
    newcomers.sort();
    this.queueOrder.push(...newcomers);

    const slots = new Map<string, OfficeTilePos>();
    const takenByFloor = new Map<number, number>();
    for (const agentId of this.queueOrder) {
      const floorIndex = this.floorIndexOfAgent(agentId);
      const floor = this.currentLayout.floors[floorIndex];
      const taken = takenByFloor.get(floorIndex) ?? 0;
      if (taken >= floor.receptionQueueTiles.length) continue;
      slots.set(agentId, floor.receptionQueueTiles[taken]);
      takenByFloor.set(floorIndex, taken + 1);
    }

    for (const character of this.characters.values()) {
      if (character.errand === "leaving") continue;
      const slot = slots.get(character.agentId);
      if (slot === undefined) {
        if (this.inReceptionQueue(character)) this.returnToDesk(character);
        continue;
      }
      if (
        this.inReceptionQueue(character) &&
        sameTile(character.queueTile, slot)
      ) {
        continue;
      }
      this.startQueueWalk(character, slot);
    }
  }

  private startQueueWalk(
    character: OfficeCharacter,
    slot: OfficeTilePos,
  ): void {
    const start = this.startTileOf(character);
    const standing = (): void => {
      character.col = slot.col;
      character.row = slot.row;
      // Facing the counter, which is the way a person waiting actually stands
      // - and which way that is, is the STOREY's fact rather than the scene's.
      character.facing = this.queueFacingOf(character.agentId);
      character.seated = false;
      character.path = [];
      character.pathIndex = 0;
      character.walkPhaseMs = 0;
      character.idleMs = 0;
      character.errand = "queue-stand";
      character.queueTile = slot;
      character.waitMs = 0;
      character.errandTarget = null;
      character.filler = null;
      character.hurrying = false;
    };
    if (this.reducedMotion) {
      standing();
      return;
    }
    if (start.col === slot.col && start.row === slot.row) {
      standing();
      return;
    }
    const path = findOfficePath(this.currentLayout, start, slot);
    // No route means no queue: a character is never teleported out of its
    // chair, it simply keeps its bubble where it sits.
    if (path === null || path.length === 0) return;
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "queue-out";
    character.queueTile = slot;
    character.waitMs = 0;
    character.errandTarget = null;
    character.filler = null;
    character.hurrying = false;
  }

  // ---- Pulses and envelopes ------------------------------------------ //

  private applyPulse(pulse: CommGraphPulse | null): void {
    if (pulse === null) return;
    if (pulse.kind === "agent") {
      // A half-edge has no second desk to fly between, so the visible agent
      // just acknowledges the message.
      this.showBubble(pulse.agentId, "bubble-hello", BUBBLE_HELLO_MS);
      return;
    }
    if (pulse.pulseKind === "notice") {
      // A notice travels back TO the agent that is waiting, so its `from` is
      // the stalled side - the one that owes the answer.
      this.showBubble(
        pulse.fromAgentId,
        "bubble-notice",
        Math.max(this.stepMs, REDUCED_MOTION_ARRIVAL_MS),
      );
    }
    if (!this.characters.has(pulse.fromAgentId)) return;
    if (!this.characters.has(pulse.toAgentId)) return;
    // The DESK sends and the desk receives, so an agent caught mid-floor does
    // not have to be anywhere for the flight to be correct. What it does is
    // HURRY: cancel whatever it was doing and run for its chair. Snapping it
    // there instead - which this replaced - read as the sprite teleporting.
    this.startHurry(pulse.fromAgentId);
    this.startHurry(pulse.toAgentId);
    if (this.reducedMotion) {
      this.deliver(pulse.toAgentId, pulse.pulseKind);
      return;
    }
    this.envelopes.push({
      fromAgentId: pulse.fromAgentId,
      toAgentId: pulse.toAgentId,
      pulseKind: pulse.pulseKind,
      edgeId: pulse.edgeId,
      elapsedMs: 0,
      durationMs: clamp(
        this.stepMs * ENVELOPE_STEP_FRACTION,
        ENVELOPE_MIN_MS,
        ENVELOPE_MAX_MS,
      ),
    });
    while (this.envelopes.length > MAX_LIVE_ENVELOPES) this.envelopes.shift();
  }

  /**
   * The envelope has landed on the receiver's DESK. If its owner is in the
   * chair, that is an acknowledgement now; if not, the message sits on the desk
   * as one more item on the pile and is acknowledged the moment they sit.
   *
   * Which is what a message actually is - waiting work, not a thing that can
   * only exist while someone is looking at it.
   */
  private deliver(agentId: string, pulseKind: CommGraphPulseKind): void {
    const character = this.characters.get(agentId);
    if (character === undefined) return;
    const item: PendingItem = {
      bubble: pulseKind === "notice" ? "bubble-notice" : "bubble-hello",
      sparkle: pulseKind === "created",
      inOpenCount: pulseKind === "request",
    };
    if (!character.seated) {
      character.pending.push(item);
      return;
    }
    character.bubble = { sprite: item.bubble, remainingMs: BUBBLE_HELLO_MS };
    if (item.sparkle) character.sparkleMs = SPARKLE_MS;
  }

  /** The pile clears in one go when its owner is back; the newest is the one seen. */
  private flushPending(character: OfficeCharacter): void {
    const item = character.pending.at(-1);
    if (item === undefined) return;
    character.pending = [];
    character.bubble = { sprite: item.bubble, remainingMs: BUBBLE_HELLO_MS };
    if (item.sparkle) character.sparkleMs = SPARKLE_MS;
  }

  /**
   * An agent with a message in the air, or one waiting on its desk, is in a
   * hurry: whatever it was doing is over and it is running for its chair.
   *
   * A character at reception is the one exception. It is standing there because
   * a PERSON is needed, which no envelope resolves; pulling it out of the queue
   * to collect a message would drop its place in line.
   */
  private startHurry(agentId: string): void {
    const character = this.characters.get(agentId);
    if (character === undefined) return;
    if (character.errand === "leaving") return;
    if (this.inReceptionQueue(character)) return;
    character.filler = null;
    if (character.seated) return;
    // A LATCH, not a window: the hurry lasts until the chair is reached, not
    // until the envelope lands. Dropping back to a stroll partway across the
    // floor - which is what tying it to the flight did - reads as a stutter.
    character.hurrying = true;
    // Already headed for the chair: a re-path would only restart the walk.
    if (character.errand === "arriving") return;
    if (character.errand === "returning") return;
    if (character.errand === "errand-return") return;
    this.returnToDesk(character);
  }

  /**
   * Whether this agent is running for its chair: latched while it walks, and
   * true for a seated one that still has a message in the air or on the desk,
   * which is what keeps it from wandering off in the middle of a delivery.
   */
  /**
   * Parked in the QUIET STACK: seated in a cubby rather than at a desk.
   *
   * A cubby is a waiting slot, not a workstation. Its occupant is cold by
   * definition, so it does not fidget at a desk it does not have and does not
   * wander off for coffee - it is waiting to be woken, and waking it is what
   * takes it to a real chair. One that is WALKING has already left the slot
   * and is an ordinary character again.
   */
  private seatedInCubby(agentId: string): boolean {
    const character = this.characters.get(agentId);
    if (character === undefined || !character.seated) return false;
    return this.seats.effectiveSeat(agentId)?.kind === "cubby";
  }

  private isHurrying(agentId: string): boolean {
    const character = this.characters.get(agentId);
    if (character !== undefined && character.hurrying) return true;
    if (character !== undefined && character.pending.length > 0) return true;
    for (const envelope of this.envelopes) {
      if (envelope.fromAgentId === agentId) return true;
      if (envelope.toAgentId === agentId) return true;
    }
    return false;
  }

  private showBubble(
    agentId: string,
    sprite: OfficeSpriteName,
    durationMs: number,
  ): void {
    const character = this.characters.get(agentId);
    if (character === undefined) return;
    character.bubble = { sprite, remainingMs: durationMs };
  }

  /**
   * Whether this input's cursor sits BEFORE the one last synced - a seek, a
   * step back, or leaving live for history. That lands on a prefix in which
   * whatever was mid-flight has not happened yet: an envelope from a later row
   * must not keep flying over the earlier floor, let alone land there.
   *
   * Two rows can share a millisecond, and a step between them moves the cursor
   * without moving `cursorMs`. The pulse key names the row, so a key change at
   * an equal time is a move too - taken as a rewind either way, because
   * dropping a flight the next row would restart costs nothing and keeping one
   * from a later row costs the truth of the earlier prefix.
   */
  private cursorRewoundBy(input: OfficeSceneInput): boolean {
    if (input.cursorMs === null) return false;
    if (this.cursorMs === null) return true;
    if (input.cursorMs < this.cursorMs) return true;
    return (
      input.cursorMs === this.cursorMs && input.pulseKey !== this.lastPulseKey
    );
  }

  /**
   * Re-plans the floor when the agent SET changed, and only re-letters it
   * when only names did.
   *
   * A rename is the one agent change that does NOT restack the floor - a
   * re-layout sends every errand-goer back to its chair - but the cabin signs
   * and pod plates carry names copied at layout time, so they are rewritten
   * in place and the floor's version moves, which is what makes the cached
   * floor and the static layer pick the new lettering up.
   */
  private adoptLayout(agents: ReadonlyArray<OfficeAgentInput>): void {
    const signature = agentSetSignature(agents);
    const names = agentNameSignature(agents);
    // TWO triggers and no others. The agent SET, as it always has been; and a
    // non-empty shortfall, because an agent the book could not seat is a
    // question only the next plan can answer. Never a status flip, a viewport
    // change or an activity change: each of those moves lights, not desks.
    const shortfall = this.seats.needsCapacity();
    const replan =
      signature !== this.agentSignature ||
      this.layoutOrNull === null ||
      shortfall.length > 0;
    this.agentSignature = signature;
    if (!replan) {
      if (names !== this.nameSignature) {
        const relettered = withRefreshedNames(
          this.currentLayout,
          this.agentById,
        );
        this.installLayout(relettered);
        // The book holds the layout it last adopted, and a re-lettering is a
        // new object with the same seats - so it takes this one up too rather
        // than answering out of a plan that no longer exists.
        this.seats.adopt(
          relettered,
          agents.map((agent) => agent.id),
        );
      }
      this.nameSignature = names;
      return;
    }
    this.nameSignature = names;
    const previous = this.layoutOrNull;
    const planned = this.view.plan({
      agents,
      partition: this.requirePartition(),
      occupancy: this.seats.occupancy(),
      needsCapacity: shortfall,
      activityById: this.activityById,
      viewport: this.viewport,
      previous,
    });
    this.installLayout(planned);
    this.applyShift(planned.shiftFromPrevious);
    const moved = this.seats.adopt(
      planned,
      agents.map((agent) => agent.id),
    );
    // Before reconciling, so a newly spawned walker is not immediately
    // re-pathed to the destination it was just given. On a STABLE layout the
    // moved set is empty by construction and this walks nobody.
    this.rehomeCharacters(moved);
  }

  /**
   * The whole world moved. Everything the scene holds that names a tile or a
   * point moves with it, so a building that grew a storey does not leave its
   * people standing where the storey used to be.
   *
   * The camera is the renderer's and is left for it to collect, which is what
   * keeps the office from appearing to jump while nothing in it moved.
   */
  private applyShift(shift: OfficeTilePos | null): void {
    if (shift === null) return;
    if (shift.col === 0 && shift.row === 0) return;
    const slide = (tile: OfficeTilePos): OfficeTilePos => ({
      col: tile.col + shift.col,
      row: tile.row + shift.row,
    });
    for (const character of this.characters.values()) {
      character.col += shift.col;
      character.row += shift.row;
      character.path = character.path.map(slide);
      if (character.queueTile !== null) {
        character.queueTile = slide(character.queueTile);
      }
      const target = character.errandTarget;
      if (target !== null) {
        character.errandTarget = {
          ...target,
          tile: slide(target.tile),
          actionTile:
            target.actionTile === null ? null : slide(target.actionTile),
        };
        // The key names a TILE, and the tile moved; a stale key would forbid
        // an errand to a spot this agent has never been to.
        character.lastErrandKey = tileKeyOf(character.errandTarget.tile);
      }
    }
    const origin = this.point(0, 0);
    const moved = this.point(shift.col, shift.row);
    const delta: OfficePoint = { x: moved.x - origin.x, y: moved.y - origin.y };
    this.paperBalls = this.paperBalls.map((ball) => ({
      ...ball,
      from: { x: ball.from.x + delta.x, y: ball.from.y + delta.y },
      to: { x: ball.to.x + delta.x, y: ball.to.y + delta.y },
    }));
    const pending = this.pendingShift;
    this.pendingShift =
      pending === null
        ? delta
        : { x: pending.x + delta.x, y: pending.y + delta.y };
  }

  private requirePartition(): OfficePopulation {
    const partition = this.partition;
    if (partition === null) {
      throw new Error("OfficeScene: no partition before the first sync");
    }
    return partition;
  }

  /**
   * Ends every motion in flight the way it would have ended: each envelope is
   * delivered, each walk lands on its last tile and does what arriving there
   * does (sit, stand at the spot, leave), and every thrown ball is gone. The
   * floor is left in the state a full playthrough would have reached, so
   * nothing downstream has to know the motion was cut short.
   */
  private settleMotion(): void {
    for (const envelope of this.envelopes) {
      this.deliver(envelope.toAgentId, envelope.pulseKind);
    }
    this.envelopes = [];
    this.paperBalls = [];
    for (const character of this.characters.values()) {
      if (character.pathIndex >= character.path.length) continue;
      const last = character.path[character.path.length - 1];
      character.col = last.col;
      character.row = last.row;
      character.pathIndex = character.path.length;
      // A zero-length step walks nowhere and runs the arrival branch alone.
      this.advanceWalk(character, 0);
    }
  }

  /**
   * Forgets every timeline-derived transient: envelopes in flight, messages
   * waiting on desks, the bubbles and sparkles they raised. Unlike
   * `settleMotion` nothing is delivered, because on the prefix the cursor now
   * shows those messages have not been sent. Walks are left alone - a
   * character's position is not a fact about the timeline.
   */
  private dropTransientMotion(): void {
    this.envelopes = [];
    // Thrown balls are live-only motion too; a historical floor has none.
    this.paperBalls = [];
    for (const character of this.characters.values()) {
      character.pending = [];
      character.bubble = null;
      character.sparkleMs = 0;
    }
  }

  private advanceEnvelopes(dtMs: number): void {
    if (this.envelopes.length === 0) return;
    const live: OfficeEnvelope[] = [];
    for (const envelope of this.envelopes) {
      envelope.elapsedMs += dtMs;
      if (envelope.elapsedMs < envelope.durationMs) {
        live.push(envelope);
        continue;
      }
      this.deliver(envelope.toAgentId, envelope.pulseKind);
    }
    this.envelopes = live;
  }

  // ---- Character animation ------------------------------------------- //

  private advanceCharacter(character: OfficeCharacter, dtMs: number): void {
    const bubble = character.bubble;
    if (bubble !== null) {
      bubble.remainingMs -= dtMs;
      if (bubble.remainingMs <= 0) character.bubble = null;
    }
    if (character.sparkleMs > 0) {
      character.sparkleMs = Math.max(0, character.sparkleMs - dtMs);
    }
    if (
      this.onCancellableErrand(character) &&
      this.errandMustEnd(character.agentId)
    ) {
      this.returnToDesk(character);
    }
    // A message on the way outranks anything an idle agent had planned.
    if (
      this.onCancellableErrand(character) &&
      this.isHurrying(character.agentId)
    ) {
      this.returnToDesk(character);
    }
    if (character.errand === "errand-wait") {
      this.advanceRally(character);
      this.advanceThrows(character, dtMs);
      character.waitMs -= dtMs;
      if (character.waitMs <= 0) this.finishLinger(character);
      return;
    }
    // Waiting at reception ends when the status does, which only a sync sees.
    if (character.errand === "queue-stand") return;
    if (!character.seated) {
      this.advanceWalk(character, dtMs);
      return;
    }
    if (this.statusOf(character.agentId) === "idle") character.idleMs += dtMs;
    else character.idleMs = 0;
    this.advanceFiller(character, dtMs);
  }

  // ---- Two-player games -------------------------------------------------- //

  /**
   * The agent on the OTHER side of this one's table, if somebody has taken it.
   *
   * The two are at one table when they stand at spots that name the same
   * FIXTURE. That used to be read off the geometry - same kind, same row -
   * which is true of this floor plan and of no other: an oblique storey puts
   * two tables of one kind on one row, and an isometric one puts the two ends
   * of a table on different rows entirely.
   */
  private rallyPartnerOf(character: OfficeCharacter): OfficeCharacter | null {
    const target = character.errandTarget;
    if (target === null || !isTwoPlayerKind(target.kind)) return null;
    if (target.fixtureId === null) return null;
    if (character.errand !== "errand-wait") return null;
    for (const other of this.orderedByAgentId()) {
      if (other.agentId === character.agentId) continue;
      if (other.errand !== "errand-wait") continue;
      const theirs = other.errandTarget;
      if (theirs === null || theirs.fixtureId !== target.fixtureId) continue;
      return other;
    }
    return null;
  }

  /**
   * Play starts the moment the second side is taken, and both players get the
   * SAME clock - a rally where one of them wandered off mid-point would read as
   * the other hitting to nobody. Only the lower id starts it, so which of the
   * two the tick happens to reach first cannot change the game's length.
   */
  private advanceRally(character: OfficeCharacter): void {
    if (character.rallying) return;
    const partner = this.rallyPartnerOf(character);
    if (partner === null || partner.rallying) return;
    if (character.agentId > partner.agentId) return;
    const seed = mixSeed(
      hashAgentId(character.agentId),
      Math.floor(this.nowMs / 1000),
    );
    const playMs = GAME_PLAY_MIN_MS + (seed % GAME_PLAY_SPREAD_MS);
    for (const player of [character, partner]) {
      player.rallying = true;
      player.waitMs = playMs;
      player.lingerTotalMs = playMs;
    }
  }

  /**
   * The ball, mid-rally: one stroke across the table and one back, on a clock
   * shared by both players so they are always hitting the same ball. Derived
   * from the scene time rather than stored, which is what keeps it identical on
   * two machines replaying the same ticks.
   *
   * Ping-pong and foosball both have one; chess is played with the two players
   * thinking at each other instead - see `errandBubbleFor`.
   */
  private pushRallyBall(
    overlay: OfficeDrawable[],
    character: OfficeCharacter,
    partner: OfficeCharacter,
  ): void {
    const here = this.headPointOfCharacter(character);
    const there = this.headPointOfCharacter(partner);
    const phase = (this.nowMs % (GAME_STROKE_MS * 2)) / GAME_STROKE_MS;
    const progress = easeInOut(phase <= 1 ? phase : 2 - phase);
    overlay.push({
      kind: "sprite",
      sprite: { name: "paper-ball" },
      x: here.x + (there.x - here.x) * progress,
      y:
        here.y +
        (there.y - here.y) * progress -
        ENVELOPE_ARC_LIFT * progress * (1 - progress),
    });
  }

  // ---- Paper tosses ---------------------------------------------------- //

  /**
   * The throws of a toss errand, while its owner stands at the line. Driven off
   * the same wait clock the linger runs on, so the errand can never end with a
   * throw still owed. A bin and a dartboard are the same errand aimed at
   * different furniture.
   */
  private advanceThrows(character: OfficeCharacter, dtMs: number): void {
    if (character.throwsLeft <= 0) return;
    const target = character.errandTarget;
    if (target === null || !targetIsThrowable(target.kind)) return;
    character.nextThrowMs -= dtMs;
    if (character.nextThrowMs > 0) return;
    character.nextThrowMs += BIN_THROW_GAP_MS;
    character.throwsLeft -= 1;
    this.throwPaperBall(character, target);
  }

  /**
   * One ball, from the thrower's head to what it is aimed at, and a missed
   * paper toss lands beside the bin rather than in it. A DART never misses:
   * darts on the floor around a board read as the arc being broken rather than
   * as somebody's aim.
   *
   * The target is LOOKED UP in the plan rather than derived from the spot by a
   * fixed offset: how far back the throwing line stands is the layout's
   * business, and a scene that hard-coded that distance would sail balls into
   * empty floor the day the plan moved the line.
   */
  private throwPaperBall(
    character: OfficeCharacter,
    target: OfficeErrandTarget,
  ): void {
    if (!targetIsThrowable(target.kind)) return;
    const targetTile = target.actionTile;
    if (targetTile === null) return;
    const seed = mixSeed(
      hashAgentId(character.agentId),
      character.throwsLeft + Math.floor(this.nowMs / 1000),
    );
    const missed = target.kind === "bin" && seed % 100 < PAPER_MISS_PERCENT;
    const aim = this.tileCenter(targetTile);
    this.paperBalls.push({
      from: this.headPointOfCharacter(character),
      to: {
        // A miss carries past the bin to one side; which side is seeded too, so
        // a floor of missed shots is not a floor of balls in one tidy pile.
        x: missed
          ? aim.x + (seed % 2 === 0 ? -PAPER_MISS_OFFSET : PAPER_MISS_OFFSET)
          : aim.x,
        y: missed ? aim.y + PAPER_MISS_OFFSET : aim.y,
      },
      missed,
      elapsedMs: 0,
    });
  }

  /** A tile's centre, PROJECTED - never `col * OFFICE_TILE` in this class. */
  private tileCenter(tile: OfficeTilePos): OfficePoint {
    const origin = this.point(tile.col, tile.row);
    return { x: origin.x + OFFICE_TILE / 2, y: origin.y + OFFICE_TILE / 2 };
  }

  private advancePaperBalls(dtMs: number): void {
    if (this.paperBalls.length === 0) return;
    const live: OfficePaperBall[] = [];
    for (const ball of this.paperBalls) {
      ball.elapsedMs += dtMs;
      const lifeMs =
        PAPER_BALL_FLIGHT_MS + (ball.missed ? PAPER_BALL_REST_MS : 0);
      if (ball.elapsedMs < lifeMs) live.push(ball);
    }
    this.paperBalls = live;
  }

  /** Where a ball is right now: along its arc, or lying where it missed. */
  private paperBallPointOf(ball: OfficePaperBall): OfficePoint {
    if (ball.elapsedMs >= PAPER_BALL_FLIGHT_MS) return ball.to;
    const progress = easeInOut(
      clamp(ball.elapsedMs / PAPER_BALL_FLIGHT_MS, 0, 1),
    );
    return {
      x: ball.from.x + (ball.to.x - ball.from.x) * progress,
      y:
        ball.from.y +
        (ball.to.y - ball.from.y) * progress -
        ENVELOPE_ARC_LIFT * 4 * progress * (1 - progress),
    };
  }

  // ---- Desk fillers --------------------------------------------------- //

  /**
   * The small things a seated idle agent does between errands. Only ONE cap is
   * needed here, unlike errands: a filler moves nobody across the floor, so a
   * room where everyone stretches at once is a room that looks alive rather
   * than a room being evacuated.
   */
  private advanceFiller(character: OfficeCharacter, dtMs: number): void {
    if (this.playing || this.cursorMs !== null || this.reducedMotion) {
      character.filler = null;
      return;
    }
    if (this.statusOf(character.agentId) !== "idle") {
      character.filler = null;
      return;
    }
    if (this.isHurrying(character.agentId)) {
      character.filler = null;
      return;
    }
    // A cubby has no desk to look up from, spin on or stretch at.
    if (this.seatedInCubby(character.agentId)) {
      character.filler = null;
      return;
    }
    const active = character.filler;
    if (active !== null) {
      active.elapsedMs += dtMs;
      if (active.elapsedMs < active.durationMs) return;
      character.filler = null;
      character.fillerCount += 1;
      character.nextFillerMs = this.fillerGapMs(character);
      return;
    }
    character.nextFillerMs -= dtMs;
    if (character.nextFillerMs > 0) return;
    character.filler = this.pickFiller(character);
  }

  private fillerGapMs(character: OfficeCharacter): number {
    const seed = mixSeed(hashAgentId(character.agentId), character.fillerCount);
    return FILLER_GAP_MIN_MS + (seed % FILLER_GAP_SPREAD_MS);
  }

  private pickFiller(character: OfficeCharacter): OfficeFiller {
    const kinds: OfficeFillerKind[] = ["look", "stretch", "spin"];
    const seed = mixSeed(
      hashAgentId(character.agentId),
      character.fillerCount + 1,
    );
    const kind = kinds[seed % kinds.length];
    return { kind, elapsedMs: 0, durationMs: fillerDurationMs(kind) };
  }

  // ---- Errands -------------------------------------------------------- //

  /** On the way to a spot, or standing at one - a break that can still be cut short. */
  private onCancellableErrand(character: OfficeCharacter): boolean {
    return (
      character.errand === "errand-out" || character.errand === "errand-wait"
    );
  }

  /**
   * Settled somewhere the character is OFF ITS FEET: a sofa, a sleeping bag, an
   * armchair, a console seat, a garden bench.
   *
   * The garden is the one kind that is both. Its bench seats and its stroll
   * spots are the same errand kind, so the layout is asked which this tile is by
   * looking for the bench that would be standing over it - the same question
   * the bin and the plant already put to it.
   */
  private onSeatedErrand(character: OfficeCharacter): boolean {
    const target = character.errandTarget;
    if (target === null || character.errand !== "errand-wait") return false;
    if (!isSeatedErrandKind(target.kind)) return false;
    if (target.kind !== "garden") return true;
    // A garden BENCH spot names the bench it sits in front of; a garden
    // stroll spot names nothing, which is the difference between the two.
    return target.actionTile !== null;
  }

  /**
   * Whether this stint on the sofa has turned into a doze: only a LONG sit
   * does, and only in its second half.
   *
   * Keyed on the stint rather than on the agent, which is the difference
   * between a floor where anyone might nod off and a floor with one designated
   * narcoleptic - the sofa linger is already seeded per stint, so reading its
   * length costs nothing and varies the way a person does.
   */
  private dozingOnSofa(character: OfficeCharacter): boolean {
    const longSit = SOFA_LINGER_MIN_MS + SOFA_LINGER_SPREAD_MS / 2;
    if (character.lingerTotalMs < longSit) return false;
    return character.waitMs <= character.lingerTotalMs / 2;
  }

  /** ...plus the walk back, which is still time spent away from the desk. */
  private onErrand(character: OfficeCharacter): boolean {
    return (
      this.onCancellableErrand(character) ||
      character.errand === "errand-return"
    );
  }

  /**
   * An errand belongs to a LIVE floor and to an agent that is still idle, still
   * on it, and still nothing is happening to it. Playback makes every agent
   * idle between its own rows, so an errand during it would fire constantly.
   */
  private errandMustEnd(agentId: string): boolean {
    if (this.playing) return true;
    // A paused historical view is a still photograph of that moment; the
    // people in it do not wander off for coffee while it is looked at.
    if (this.cursorMs !== null) return true;
    if (!this.visibleAgentIds.has(agentId)) return true;
    if (this.archivedIds.has(agentId)) return true;
    return this.statusOf(agentId) !== "idle";
  }

  /** Spots somebody is already using, or walking to, or walking back from. */
  private claimedSpotKeys(): Set<string> {
    const claimed = new Set<string>();
    for (const character of this.characters.values()) {
      const target = character.errandTarget;
      if (target === null) continue;
      claimed.add(tileKeyOf(target.tile));
    }
    return claimed;
  }

  /**
   * EVERY idle agent past its threshold gets up - there is no cap, so this is a
   * plain sweep rather than a budget being spent. Canonical order still decides
   * who claims a contested spot first, which is what keeps that a fact about
   * their ids rather than about map insertion order.
   */
  private updateErrandStarts(): void {
    if (this.playing || this.cursorMs !== null || this.reducedMotion) return;
    const claimed = this.claimedSpotKeys();
    for (const character of this.orderedByAgentId()) {
      if (!this.mayStartErrand(character)) continue;
      const target = this.nextErrandFor(character, claimed);
      if (target === null) continue;
      if (!this.startErrand(character, target)) continue;
      claimed.add(tileKeyOf(target.tile));
    }
  }

  private mayStartErrand(character: OfficeCharacter): boolean {
    if (character.errand !== "none") return false;
    if (!character.seated) return false;
    if (this.seatedInCubby(character.agentId)) return false;
    if (this.errandMustEnd(character.agentId)) return false;
    if (this.isHurrying(character.agentId)) return false;
    const threshold = IDLE_ERRAND_MS + errandStaggerMs(character.agentId);
    return character.idleMs >= threshold;
  }

  /**
   * Somewhere to be next: a free spot if the floor has one, and a corridor tile
   * to stroll between if it does not.
   *
   * The fallback is the whole reason an agent never has to go back to its desk.
   * A floor with more idle agents than spots used to put the surplus back in
   * their chairs, which is exactly the still office this replaced; now they walk
   * the corridors instead, and a corridor tile is claimed like any spot so two
   * of them never stand in the same place.
   */
  private nextErrandFor(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
  ): OfficeErrandTarget | null {
    const spot = this.pickErrandTarget(character, claimed);
    if (spot !== null) return spot;
    return this.strollTargetFor(character, claimed);
  }

  /**
   * Where this agent goes next. The seed folds the clock in at one-second
   * resolution so the same agent does not walk the same loop forever, and the
   * last destination is excluded outright - twice to the same window reads as
   * the animation being stuck rather than as a habit.
   */
  private pickErrandTarget(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
  ): OfficeErrandTarget | null {
    const seed = mixSeed(
      hashAgentId(character.agentId),
      Math.floor(this.nowMs / 1000),
    );
    const options = this.errandOptionsFor(character, claimed, seed);
    // Somebody is holding a side of a table open. Taking the other one beats
    // any roll: a game needs two, and leaving it to the weights means the
    // waiter usually gives up before a second player happens to choose it.
    for (const kind of TWO_PLAYER_KINDS) {
      const table = options.find((option) => option.kind === kind);
      if (table !== undefined && this.someoneWaitingToPlay(kind)) return table;
    }
    return this.weightedPick(options, seed);
  }

  /**
   * Somebody has a side of THIS game's table, or is on their way to one, with
   * nobody opposite - an open invitation.
   *
   * EN ROUTE counts, and has to. The game room is across the floor from the
   * desks, so a player spends far longer walking to the table than the few
   * seconds it will then wait at it: a bias that only answered an agent already
   * standing there would send the second player off a moment before the first
   * gave up, and no game would ever happen on a floor big enough to have a game
   * room.
   */
  private someoneWaitingToPlay(kind: OfficeErrandTargetKind): boolean {
    for (const character of this.characters.values()) {
      if (character.rallying) continue;
      if (!this.onCancellableErrand(character)) continue;
      const target = character.errandTarget;
      if (target !== null && target.kind === kind) return true;
    }
    return false;
  }

  private errandOptionsFor(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
    seed: number,
  ): ReadonlyArray<OfficeErrandTarget> {
    const floor = this.floorOfAgent(character.agentId);
    const options: OfficeErrandTarget[] = [];
    for (const spot of floor.errandSpots) {
      // Claimed by the tile a walker would STAND on, which is what two agents
      // can collide over. An aliased spot - one storey's copy of a plaza's -
      // therefore blocks the physical spot for the whole building, which is
      // the point of aliasing it in the first place.
      const key = tileKeyOf(spot.approachTile);
      if (claimed.has(key)) continue;
      if (key === character.lastErrandKey) continue;
      if (spot.kind === character.lastErrandKind) continue;
      if (!this.spotSuitsAgent(character, spot)) continue;
      options.push(targetOfSpot(spot));
    }
    if (character.lastErrandKind !== "visit") {
      const visit = this.visitTargetFor(character, claimed, seed);
      if (visit !== null) options.push(visit);
    }
    return options;
  }

  /**
   * Whether this spot is one THIS agent has any business at: its own storey,
   * and then whoever the plan says the spot is FOR.
   *
   * The rule used to be read off the kind - a bin belongs to the cabin it
   * stands in, a peek is somebody else's door - which is a fact about this one
   * floor plan wearing the costume of a fact about errands. A plaza plant
   * belongs to no cabin and a leads-only board belongs to a class of agent,
   * and neither can be said in kinds without the scene learning view names.
   */
  private spotSuitsAgent(
    character: OfficeCharacter,
    spot: OfficeErrandSpot,
  ): boolean {
    const seat = this.seats.effectiveSeat(character.agentId);
    if (seat === null) return false;
    if (spot.floorIndex !== seat.floorIndex) return false;
    const audience = spot.audience;
    if (audience.kind === "nobody") return false;
    if (audience.kind === "floor") return true;
    if (audience.kind === "room") return seat.roomId === audience.roomId;
    // A peek: anybody with a cabin of their own that is not this one. Having a
    // cabin is part of the test rather than an afterthought - a solo at an
    // open-plan desk belongs to no room, and giving it every cabin's doorway
    // would be a change, not a migration.
    if (audience.kind === "not-room") {
      return seat.roomId !== null && seat.roomId !== audience.roomId;
    }
    return this.leadsATeam(character.agentId);
  }

  /**
   * Whether this agent runs something: a team's lead, or the one the host's HQ
   * belongs to. Read off the partition, which is the single answer every
   * layout, board and directory row already shares.
   */
  private leadsATeam(agentId: string): boolean {
    const partition = this.partition;
    if (partition === null) return false;
    if (partition.teamOf(agentId)?.leadAgentId === agentId) return true;
    return partition.hosts.some((host) => host.hqAgentId === agentId);
  }

  /**
   * A corridor tile to stand on when every spot is taken - the floor's OWN
   * corridors, which is where somebody with nowhere to be would actually be.
   *
   * The tiles are carried by the storey rather than scanned for, because "the
   * rows between the wall face and the lobby, minus the rooms" is a fact about
   * one storey of one view: an oblique aisle and an isometric district street
   * are both corridors and neither is above a lobby.
   */
  private strollTargetFor(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
  ): OfficeErrandTarget | null {
    const options = this.corridorTilesFor(character, claimed);
    if (options.length === 0) return null;
    const seed = mixSeed(
      hashAgentId(character.agentId),
      character.errandLegs + Math.floor(this.nowMs / 1000),
    );
    const floor = this.floorOfAgent(character.agentId);
    return derivedTarget({
      kind: "corridor",
      tile: options[seed % options.length],
      facing: floor.queueFacing,
      partnerId: null,
    });
  }

  private corridorTilesFor(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
  ): ReadonlyArray<OfficeTilePos> {
    const floor = this.floorOfAgent(character.agentId);
    const tiles: OfficeTilePos[] = [];
    for (const tile of floor.corridorTiles) {
      const key = tileKeyOf(tile);
      if (claimed.has(key)) continue;
      if (key === character.lastErrandKey) continue;
      tiles.push(tile);
    }
    return tiles;
  }

  /** Weighted by kind; an empty list is a floor with nowhere to go. */
  private weightedPick(
    options: ReadonlyArray<OfficeErrandTarget>,
    seed: number,
  ): OfficeErrandTarget | null {
    let total = 0;
    for (const option of options) total += ERRAND_WEIGHTS[option.kind];
    if (total === 0) return null;
    let roll = seed % total;
    for (const option of options) {
      roll -= ERRAND_WEIGHTS[option.kind];
      if (roll < 0) return option;
    }
    return options[options.length - 1];
  }

  /**
   * A call on somebody in the SAME cabin: the aisle tile under their desk,
   * facing them. Same cabin because a visit is meant to read as two people who
   * work together talking, and because the aisle under a desk in another room
   * is a corridor the visitor has no business standing in.
   *
   * The colleague has to be at their desk and either idle or working - there is
   * no point calling on somebody who is themselves out, and an agent that needs
   * a person has a queue to stand in.
   */
  private visitTargetFor(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
    seed: number,
  ): OfficeErrandTarget | null {
    const mySeat = this.seats.effectiveSeat(character.agentId);
    if (mySeat === null || mySeat.roomId === null) return null;
    const room = this.roomOfSeat(mySeat);
    const hosts: OfficeErrandTarget[] = [];
    for (const seated of this.visibleSeats()) {
      if (seated.agentId === character.agentId) continue;
      if (seated.seat.roomId !== mySeat.roomId) continue;
      const colleague = this.characters.get(seated.agentId);
      if (colleague === undefined || !colleague.seated) continue;
      const status = this.statusOf(seated.agentId);
      if (status !== "idle" && status !== "working") continue;
      // Under the colleague's OWN chair, which is what makes a visit read as
      // two people talking rather than as a queue at one tile. The room's
      // `visitTile` is the fallback for a view whose chairs have nothing
      // walkable under them.
      const tile = this.visitTileNear(seated.seat, room);
      if (tile === null) continue;
      const key = tileKeyOf(tile);
      if (claimed.has(key) || key === character.lastErrandKey) continue;
      hosts.push(
        derivedTarget({
          kind: "visit",
          tile,
          facing: seated.seat.facing,
          partnerId: seated.agentId,
        }),
      );
    }
    if (hosts.length === 0) return null;
    hosts.sort((left, right) =>
      left.partnerId === right.partnerId ||
      left.partnerId === null ||
      right.partnerId === null
        ? 0
        : left.partnerId.localeCompare(right.partnerId),
    );
    return hosts[seed % hosts.length];
  }

  private startErrand(
    character: OfficeCharacter,
    target: OfficeErrandTarget,
  ): boolean {
    const start = this.startTileOf(character);
    const path = findOfficePath(this.currentLayout, start, target.tile);
    // No route means no errand: a character must never be teleported out of its
    // chair for something as incidental as a coffee.
    if (path === null || path.length === 0) return false;
    character.col = start.col;
    character.row = start.row;
    character.seated = false;
    character.path = path;
    character.pathIndex = 0;
    character.walkPhaseMs = 0;
    character.idleMs = 0;
    character.errand = "errand-out";
    character.errandTarget = target;
    character.rallying = false;
    character.errandLegs = 0;
    character.errandLegsWanted = this.strollLegsFor(character);
    character.lastErrandKey = tileKeyOf(target.tile);
    character.lastErrandKind = target.kind;
    character.waitMs = 0;
    character.filler = null;
    return true;
  }

  /**
   * How many corridor spots this stroll takes in. Only a corridor errand reads
   * it; standing in one corridor and turning round is not a stroll.
   */
  private strollLegsFor(character: OfficeCharacter): number {
    const seed = mixSeed(
      hashAgentId(character.agentId),
      Math.floor(this.nowMs / 1000),
    );
    return STROLL_MIN_LEGS + (seed % STROLL_LEG_SPREAD);
  }

  /** Continues an errand in progress: the next leg keeps the walk's own state. */
  private startErrandLeg(
    character: OfficeCharacter,
    target: OfficeErrandTarget,
  ): boolean {
    const legs = character.errandLegs + 1;
    const wanted = character.errandLegsWanted;
    const kind = character.lastErrandKind;
    if (!this.startErrand(character, target)) return false;
    character.errandLegs = legs;
    character.errandLegsWanted = wanted;
    // A leg is the SAME errand, so the kind it may not repeat next is still the
    // one this whole errand started as.
    character.lastErrandKind = kind;
    return true;
  }

  /**
   * How long this character stands where it has arrived. Three answers, in
   * order: a beat whose length is part of what the activity IS, a toss that
   * lasts exactly as long as the throws it owes, or a seeded stint so a pair at
   * the cooler do not finish in lockstep.
   */
  private lingerMsFor(
    character: OfficeCharacter,
    target: OfficeErrandTarget,
  ): number {
    const fixed = fixedLingerMsFor(target.kind);
    if (fixed !== null) return fixed;
    const seed = mixSeed(
      hashAgentId(character.agentId),
      character.errandLegs + Math.floor(this.nowMs / 1000),
    );
    if (targetIsThrowable(target.kind)) {
      return this.armThrows(character, target.kind, seed);
    }
    const range = seededLingerRangeOf(target.kind);
    return range.minMs + (seed % range.spreadMs);
  }

  /**
   * A toss is as long as the throws it holds: a beat to line up, then one per
   * throw. Arming the counters here rather than in the walk is what keeps the
   * linger and the throws from ever disagreeing about how many are coming.
   */
  private armThrows(
    character: OfficeCharacter,
    kind: OfficeErrandTargetKind,
    seed: number,
  ): number {
    // A dart player throws a fixed three; a paper toss varies, because two
    // people lobbing exactly the same number of balls reads as a loop.
    const throws =
      kind === "darts"
        ? DARTS_THROWS
        : BIN_MIN_THROWS + (seed % BIN_THROW_SPREAD);
    character.throwsLeft = throws;
    character.nextThrowMs = BIN_STAND_MS;
    return BIN_STAND_MS + throws * BIN_THROW_GAP_MS;
  }

  /**
   * The linger is over, so the NEXT errand begins - from here, not from the
   * desk. Chaining is the rule: an idle agent has nothing to go back for, and a
   * walk home between every two errands was what made the floor look like it
   * was commuting rather than living.
   *
   * A stroll is the one errand with several legs, because standing in one
   * corridor and turning round is not a stroll. Only a floor with nowhere left
   * to go at all puts somebody back in a chair.
   */
  private finishLinger(character: OfficeCharacter): void {
    const target = character.errandTarget;
    if (
      target !== null &&
      target.kind === "corridor" &&
      character.errandLegs + 1 < character.errandLegsWanted
    ) {
      const next = this.nextStrollSpot(character);
      if (next !== null && this.startErrandLeg(character, next)) return;
    }
    const claimed = this.claimedSpotKeys();
    // Its own spot is free the moment it steps off it, and it is the one place
    // this agent may not go next anyway.
    if (target !== null) claimed.delete(tileKeyOf(target.tile));
    const next = this.nextErrandFor(character, claimed);
    if (next !== null && this.startErrand(character, next)) return;
    this.returnToDesk(character);
  }

  private nextStrollSpot(
    character: OfficeCharacter,
  ): OfficeErrandTarget | null {
    const claimed = this.claimedSpotKeys();
    const here = character.errandTarget;
    if (here !== null) claimed.delete(tileKeyOf(here.tile));
    const floor = this.floorOfAgent(character.agentId);
    const options: OfficeErrandTarget[] = [];
    for (const spot of floor.errandSpots) {
      if (spot.kind !== "corridor") continue;
      const key = tileKeyOf(spot.approachTile);
      if (claimed.has(key) || key === character.lastErrandKey) continue;
      options.push(targetOfSpot(spot));
    }
    if (options.length === 0) return this.strollTargetFor(character, claimed);
    const seed = mixSeed(hashAgentId(character.agentId), character.errandLegs);
    return options[seed % options.length];
  }

  // ---- Conversations -------------------------------------------------- //

  /**
   * Who this character is talking to, if anyone. Two agents lingering on
   * NEIGHBOURING spots of the same kind are together - which is exactly what
   * the two cooler spots and each table's two seats were laid out to produce -
   * and a visitor is together with the colleague it called on.
   */
  private chatPartnerOf(character: OfficeCharacter): OfficeCharacter | null {
    const target = character.errandTarget;
    if (target !== null && character.errand === "errand-wait") {
      if (target.kind === "visit") {
        return this.seatedPartner(target.partnerId);
      }
      if (target.kind === "cooler" || target.kind === "cafe") {
        return this.neighbourAt(character, target);
      }
    }
    // The other half of a visit: this character is the one being called on.
    if (!character.seated) return null;
    let visitor: OfficeCharacter | null = null;
    for (const other of this.characters.values()) {
      if (other.errand !== "errand-wait") continue;
      const theirs = other.errandTarget;
      if (theirs === null || theirs.kind !== "visit") continue;
      if (theirs.partnerId !== character.agentId) continue;
      // Lowest id wins, so two callers at once is still one conversation and
      // still the SAME one on every machine.
      if (visitor === null || other.agentId < visitor.agentId) visitor = other;
    }
    return visitor;
  }

  private seatedPartner(agentId: string | null): OfficeCharacter | null {
    if (agentId === null) return null;
    const partner = this.characters.get(agentId);
    if (partner === undefined || !partner.seated) return null;
    return partner;
  }

  private neighbourAt(
    character: OfficeCharacter,
    target: OfficeErrandTarget,
  ): OfficeCharacter | null {
    for (const other of this.orderedByAgentId()) {
      if (other.agentId === character.agentId) continue;
      if (other.errand !== "errand-wait") continue;
      const theirs = other.errandTarget;
      if (theirs === null || theirs.kind !== target.kind) continue;
      if (!areAdjacent(theirs.tile, target.tile)) continue;
      return other;
    }
    return null;
  }

  /**
   * Whose turn it is to talk. One bubble at a time, swapping on a shared clock:
   * two bubbles at once reads as two people waiting rather than as two people
   * in a conversation.
   */
  private chatBubbleFor(character: OfficeCharacter): OfficeSpriteName | null {
    const partner = this.chatPartnerOf(character);
    if (partner === null) return null;
    const speaksFirst = character.agentId < partner.agentId;
    const onBeat = Math.floor(this.nowMs / CHAT_ALTERNATE_MS) % 2 === 0;
    return speaksFirst === onBeat ? "bubble-awaiting" : null;
  }

  // ---- Walking -------------------------------------------------------- //

  /**
   * A walk in from the door outruns a stroll, and a walk with a message waiting
   * outruns both. The arrival speed exists because a newcomer's first message
   * lands within a step; the hurry speed exists because that message can arrive
   * for anyone, at any point on the floor.
   */
  private walkSpeedOf(character: OfficeCharacter): number {
    if (this.isHurrying(character.agentId)) return HURRY_TILES_PER_SECOND;
    if (character.errand === "arriving") return ARRIVAL_TILES_PER_SECOND;
    return WALK_TILES_PER_SECOND;
  }

  private advanceWalk(character: OfficeCharacter, dtMs: number): void {
    character.walkPhaseMs += dtMs;
    const speed = this.walkSpeedOf(character);
    let budget = (dtMs / 1000) * speed;
    while (budget > 0 && character.pathIndex < character.path.length) {
      const target = character.path[character.pathIndex];
      const dCol = target.col - character.col;
      const dRow = target.row - character.row;
      // Steps are axis-aligned single tiles, so Manhattan distance IS the
      // distance travelled.
      const distance = Math.abs(dCol) + Math.abs(dRow);
      const nextFacing = facingFor(dCol, dRow);
      if (nextFacing !== null) character.facing = nextFacing;
      if (distance <= budget) {
        character.col = target.col;
        character.row = target.row;
        character.pathIndex += 1;
        budget -= distance;
        continue;
      }
      const fraction = budget / distance;
      character.col += dCol * fraction;
      character.row += dRow * fraction;
      budget = 0;
    }
    if (character.pathIndex < character.path.length) return;
    if (character.errand === "leaving") {
      // Out of the door and off the floor; the desk takes its dust sheet.
      this.depart(character.agentId);
      return;
    }
    if (character.errand === "errand-out") {
      // Arrived: standing where the spot says to stand, turned the way it says
      // to face, for as long as this agent's own seeded linger runs.
      const target = character.errandTarget;
      character.errand = "errand-wait";
      character.waitMs =
        target === null
          ? ERRAND_LINGER_MIN_MS
          : this.lingerMsFor(character, target);
      character.lingerTotalMs = character.waitMs;
      character.facing = arrivalFacingOf(target);
      character.path = [];
      character.pathIndex = 0;
      character.walkPhaseMs = 0;
      return;
    }
    if (character.errand === "queue-out") {
      character.errand = "queue-stand";
      character.facing = this.queueFacingOf(character.agentId);
      character.path = [];
      character.pathIndex = 0;
      character.walkPhaseMs = 0;
      return;
    }
    this.settleInChair(character);
  }

  private statusOf(agentId: string): OfficeAgentStatus {
    return this.statusById.get(agentId) ?? "idle";
  }

  /**
   * How a character is drawn this frame. Pose and facing come back together
   * because a desk filler changes BOTH - the seated sprite ignores facing
   * entirely, so "look left" is only visible on a standing body, and a filler
   * that set facing alone would animate nothing at all.
   */
  private renderStateOf(character: OfficeCharacter): {
    readonly pose: OfficeCharacterPose;
    readonly facing: OfficeFacing;
    readonly accessory: OfficeCharacterAccessory | undefined;
  } {
    const seat = this.seats.effectiveSeat(character.agentId);
    const seatFacing = seat === null ? "up" : seat.facing;
    const filler = character.filler;
    if (filler !== null && character.seated) {
      return { ...fillerPoseOf(filler, seatFacing), accessory: undefined };
    }
    return {
      pose: this.poseFor(character),
      facing: character.facing,
      accessory: this.accessoryFor(character),
    };
  }

  /**
   * Headphones, and only while an agent is seated at its own desk working in
   * the BACKGROUND. It is the one state with nothing else to show for itself -
   * a background turn types at a quarter of the speed of a real one - and a
   * pair of headphones is what "head down, not interruptible" looks like from
   * behind.
   */
  private accessoryFor(
    character: OfficeCharacter,
  ): OfficeCharacterAccessory | undefined {
    if (!character.seated) return undefined;
    return this.statusOf(character.agentId) === "background"
      ? "headphones"
      : undefined;
  }

  /**
   * How a seated character SITS, which is what its status looks like from
   * behind. The precedence is the status precedence, unchanged: a crashed
   * screen outranks a raised hand outranks a wait, and anything the record
   * says is actually happening - a turn, a background turn - outranks all of
   * them, because a typing body is the more informative reading.
   */
  private poseFor(character: OfficeCharacter): OfficeCharacterPose {
    if (!character.seated) {
      // Off a desk and off its feet: a sofa, a sleeping bag, an armchair, a
      // bench. `sit` without being `seated` - seated means "in its own chair",
      // which is what every errand and delivery rule keys on.
      if (this.onSeatedErrand(character)) return "sit";
      // On a treadmill: walking, and going nowhere. The belt is the whole
      // point, so the frames alternate even though the tile never changes.
      if (this.onTreadmill(character)) {
        return this.walkingPose(character.agentId, TREADMILL_FRAME_MS);
      }
      // On foot but with nothing left to walk: standing at a spot or in the
      // queue.
      if (character.pathIndex >= character.path.length) return "stand";
      return Math.floor(character.walkPhaseMs / WALK_FRAME_MS) % 2 === 0
        ? "walk1"
        : "walk2";
    }
    const status = this.statusOf(character.agentId);
    if (status === "working") {
      return this.typingPose(character.agentId, TYPING_FRAME_MS);
    }
    if (status === "background") {
      return this.typingPose(character.agentId, BACKGROUND_FRAME_MS);
    }
    if (status === "failure") return "crash";
    if (status === "attention") return "hand-up";
    if (status === "awaiting") return "lean";
    return "sit";
  }

  private typingPose(agentId: string, frameMs: number): OfficeCharacterPose {
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0 ? "type1" : "type2";
  }

  /**
   * The walking frames for a character that is not going anywhere. Phased off
   * the scene clock rather than off `walkPhaseMs`, which only advances while a
   * path is being walked and would leave a treadmill runner frozen mid-stride.
   */
  private walkingPose(agentId: string, frameMs: number): OfficeCharacterPose {
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0 ? "walk1" : "walk2";
  }

  /** On a treadmill, walking in place: the one errand taken at a running pace. */
  private onTreadmill(character: OfficeCharacter): boolean {
    const target = character.errandTarget;
    if (target === null || target.kind !== "treadmill") return false;
    return character.errand === "errand-wait";
  }

  // ---- Frame assembly ------------------------------------------------ //

  /**
   * Whether anything on the floor is MOVING right now.
   *
   * A renderer that draws sixty identical frames a second is spending a
   * laptop's battery to redraw a still life, and a floor of seated agents
   * between turns is exactly that. This is the cheap test for "is another
   * frame going to differ from this one": something in flight, someone off
   * their chair, a bubble or sparkle up, or a screen mid-alternation.
   *
   * Deliberately CONSERVATIVE. Anything it is unsure about counts as animating,
   * because a false "no" freezes the floor and a false "yes" costs one frame.
   */
  isAnimating(): boolean {
    if (this.envelopes.length > 0) return true;
    if (this.paperBalls.length > 0) return true;
    for (const character of this.characters.values()) {
      if (!character.seated) return true;
      if (character.hurrying || character.rallying) return true;
      if (character.bubble !== null || character.sparkleMs > 0) return true;
      if (character.filler !== null) return true;
      // A lit screen alternates its frame while its agent has a turn running,
      // so a working desk is never a still frame.
      const status = this.statusOf(character.agentId);
      if (status === "working" || status === "background") return true;
      // The attention bubble bobs, so a flagged agent animates even seated.
      // The awaiting bubble does not: a seated agent waiting on a reply is a
      // still frame, and a request can stay open for hours.
      if (status === "attention" || status === "failure") return true;
    }
    return false;
  }

  /** Sheeted once the archive is real AND the person has actually gone. */
  private isDeskSheeted(agentId: string): boolean {
    return this.departedIds.has(agentId) && this.archivedIds.has(agentId);
  }

  // ---- The per-layout index ------------------------------------------- //

  /**
   * Seats and spots bucketed by index chunk, built once per layout.
   *
   * Without it, drawing the forty desks a viewport holds means walking all
   * thousand of them, thirty times a second, to find out which forty. The
   * index is a pure function of the layout, which is why it can be built once
   * and thrown away wholesale when the layout is replaced or the canvas goes
   * off screen.
   *
   * Spots are DEDUPED by the tile a walker stands on. A storey may alias
   * another's plaza spot - same tile, same fixture, its own `floorIndex` - so
   * that the whole building can reach one coffee machine; the painter must
   * still be asked about that coffee machine exactly once.
   */
  private index(): FrameChunkIndex {
    const cached = this.chunkIndex;
    if (cached !== null && this.chunkIndexVersion === this.layoutVersion) {
      return cached;
    }
    const layout = this.currentLayout;
    const seats = new Map<string, OfficeSeat[]>();
    for (const seat of layout.seats.values()) {
      const key = chunkKeyOf(seat.deskTile.col, seat.deskTile.row);
      const bucket = seats.get(key);
      if (bucket === undefined) seats.set(key, [seat]);
      else bucket.push(seat);
    }
    const spots = new Map<string, OfficeErrandSpot[]>();
    const seen = new Set<string>();
    for (const floor of layout.floors) {
      for (const spot of floor.errandSpots) {
        const tileKey = tileKeyOf(spot.approachTile);
        if (seen.has(tileKey)) continue;
        seen.add(tileKey);
        const key = chunkKeyOf(spot.approachTile.col, spot.approachTile.row);
        const bucket = spots.get(key);
        if (bucket === undefined) spots.set(key, [spot]);
        else bucket.push(spot);
      }
    }
    const built: FrameChunkIndex = { seats, spots };
    this.chunkIndex = built;
    this.chunkIndexVersion = this.layoutVersion;
    return built;
  }

  /** Every index chunk key a world-pixel rect reaches. */
  private chunkKeysFor(rect: OfficeRect): ReadonlyArray<string> {
    const tiles = tileRectOf(rect);
    const firstCol = Math.floor(tiles.col / FRAME_CHUNK_TILES);
    const lastCol = Math.floor(
      (tiles.col + Math.max(0, tiles.cols - 1)) / FRAME_CHUNK_TILES,
    );
    const firstRow = Math.floor(tiles.row / FRAME_CHUNK_TILES);
    const lastRow = Math.floor(
      (tiles.row + Math.max(0, tiles.rows - 1)) / FRAME_CHUNK_TILES,
    );
    const keys: string[] = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1)
        keys.push(`${col},${row}`);
    }
    return keys;
  }

  /**
   * The seats the rect touches, with the agent in each - the OCCUPIED ones
   * only, because an empty seat on the Floor is a seat for somebody who does
   * not exist at this cursor, and drawing it would leak the future.
   *
   * A chunk is indexed by the seat's own tile, and a projector may place a
   * seat's art well away from it, so every candidate is tested against the
   * rect before it is kept.
   */
  private seatsIn(rect: OfficeRect): ReadonlyArray<SeatedAgent> {
    const index = this.index();
    const found: SeatedAgent[] = [];
    for (const key of this.chunkKeysFor(rect)) {
      const bucket = index.seats.get(key);
      if (bucket === undefined) continue;
      for (const seat of bucket) {
        const agentId = this.seats.occupant(seat.seatId);
        if (agentId === null) continue;
        if (!this.visibleAgentIds.has(agentId)) continue;
        if (!rectsOverlap(this.seatBox(seat), rect)) continue;
        found.push({ agentId, seat });
      }
    }
    // Canonical order, so the same input and rect give the same frame twice.
    found.sort((left, right) => compareIdPair(left.agentId, right.agentId));
    return found;
  }

  /**
   * The floor inside a tile rect, from the painter, remembered.
   *
   * A still office asks for the same floor sixty times a second - same plan,
   * same band, same rectangle - and the floor is the largest thing in a frame
   * by an order of magnitude. Handing back the SAME array is also what tells
   * the renderer's bitmap cache it has nothing to repaint.
   */
  private floorIn(
    layout: OfficeLayout,
    tiles: OfficeTileRect,
    lod: OfficeLod,
  ): ReadonlyArray<OfficeDrawable> {
    const key = floorKeyOf(this.layoutVersion, lod, tiles);
    const cached = this.floorCache;
    if (cached !== null && cached.key === key) return cached.drawables;
    const drawables = this.view.painter.floor(layout, tiles, lod);
    this.floorCache = { key, drawables };
    return drawables;
  }

  /** The spots the rect touches, already deduped by the index. */
  private spotsIn(rect: OfficeRect): ReadonlyArray<OfficeErrandSpot> {
    const index = this.index();
    const found: OfficeErrandSpot[] = [];
    for (const key of this.chunkKeysFor(rect)) {
      const bucket = index.spots.get(key);
      if (bucket === undefined) continue;
      for (const spot of bucket) {
        const origin = this.point(spot.approachTile.col, spot.approachTile.row);
        const box: OfficeRect = {
          x: origin.x,
          y: origin.y,
          width: OFFICE_TILE,
          height: OFFICE_TILE,
        };
        if (!rectsOverlap(box, rect)) continue;
        found.push(spot);
      }
    }
    return found;
  }

  /** A seat's projected box - what the rect test and the hit region both use. */
  private seatBox(seat: OfficeSeat): OfficeRect {
    const origin = this.point(seat.deskTile.col, seat.deskTile.row);
    return {
      x: origin.x,
      y: origin.y,
      width: seat.hitTiles.width * OFFICE_TILE,
      height: seat.hitTiles.height * OFFICE_TILE,
    };
  }

  /** A character's projected box: the sprite standing on its own foot point. */
  private characterBox(character: OfficeCharacter): OfficeRect {
    const corner = this.spriteCornerOf(
      this.footPoint(character.col, character.row),
    );
    return {
      x: corner.x,
      y: corner.y,
      width: OFFICE_CHARACTER_WIDTH,
      height: OFFICE_CHARACTER_HEIGHT,
    };
  }

  /**
   * The characters inside the rect, in draw order.
   *
   * Not indexed: characters MOVE, so an index of them would be rebuilt every
   * tick to answer a question a single pass over the population already
   * answers in microseconds. The index exists for the things that stand still.
   */
  private charactersIn(rect: OfficeRect): ReadonlyArray<OfficeCharacter> {
    const found: OfficeCharacter[] = [];
    for (const character of this.orderedCharacters()) {
      if (!this.agentById.has(character.agentId)) continue;
      if (!rectsOverlap(this.characterBox(character), rect)) continue;
      found.push(character);
    }
    return found;
  }

  /** What one desk LOOKS like right now, as the painter needs to see it. */
  private deskStateOf(seated: SeatedAgent): OfficeDeskState {
    const agentId = seated.agentId;
    const agent = this.agentById.get(agentId);
    const status = this.statusOf(agentId);
    const character = this.characters.get(agentId);
    // A message that landed while its owner was away is on the desk in exactly
    // the sense the pile already draws: waiting, unanswered, in front of them.
    // Except one that the open-request count already holds - that is the same
    // envelope seen from two sides, not two envelopes.
    const waiting =
      character === undefined
        ? 0
        : character.pending.filter((item) => !item.inOpenCount).length;
    return {
      agentId,
      name: agent?.name ?? null,
      status,
      sheeted: this.isDeskSheeted(agentId),
      openRequests: (this.openRequestsByReceiver.get(agentId) ?? 0) + waiting,
      screenFrame: this.screenFrameOf(agentId, status),
      harnessId: agent?.harnessId ?? null,
      modelTier: agent?.modelTier ?? "medium",
      // The member's OWN `teamId`, never `teamOf`. A solo stranded on another
      // host carries its team's id - that is the whole point of the field,
      // keeping one team one colour across two buildings - while `teamOf`
      // answers null for it, because no roster for that team exists on this
      // host to return. `teamOf` is the roster; `teamId` is the accent.
      accentId: this.partition?.members.get(agentId)?.teamId ?? null,
    };
  }

  /** Which of a lit screen's two frames this desk is on. Shares the typing phase. */
  private screenFrameOf(agentId: string, status: OfficeAgentStatus): 0 | 1 {
    if (status !== "working" && status !== "background") return 0;
    const frameMs =
      status === "working"
        ? MONITOR_WORKING_FRAME_MS
        : MONITOR_BACKGROUND_FRAME_MS;
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0 ? 0 : 1;
  }

  /**
   * The static half of the frame: what each visible seat and each spot in the
   * rect looks like, from the painter.
   *
   * Cached per seat and keyed by the desk state that produced it, so a floor of
   * idle agents rebuilds nothing between frames and a desk whose screen just
   * flickered rebuilds only itself.
   */
  private buildSeatProps(args: {
    readonly layout: OfficeLayout;
    readonly seats: ReadonlyArray<SeatedAgent>;
    readonly rect: OfficeRect;
    readonly lod: OfficeLod;
  }): ReadonlyArray<OfficeWorldDrawable> {
    const { layout, lod, rect, seats } = args;
    if (this.seatPropVersion !== this.layoutVersion) {
      this.seatPropCache.clear();
      this.seatPropVersion = this.layoutVersion;
    }
    const out: OfficeWorldDrawable[] = [];
    for (const seated of seats) {
      const state = this.deskStateOf(seated);
      const key = `${lod}|${deskStateKey(state)}`;
      const cached = this.seatPropCache.get(seated.seat.seatId);
      if (cached !== undefined && cached.key === key) {
        out.push(...cached.drawables);
        continue;
      }
      const drawables = this.view.painter.seatProps(
        layout,
        seated.seat,
        state,
        lod,
      );
      this.seatPropCache.set(seated.seat.seatId, { key, drawables });
      out.push(...drawables);
    }
    for (const spot of this.spotsIn(rect)) {
      out.push(...this.view.painter.spotProps(layout, spot, lod));
    }
    // Stable, so two drawables at one depth keep the order they were made in:
    // a screen belongs in front of the desk it stands on.
    out.sort((left, right) => left.depth - right.depth);
    return out;
  }

  /** One pip per character in view, and nothing else: this is overview zoom. */
  private buildPips(
    characters: ReadonlyArray<OfficeCharacter>,
  ): ReadonlyArray<OfficeDrawable> {
    const pips: OfficeDrawable[] = [];
    for (const character of characters) {
      const status = this.statusOf(character.agentId);
      const point = this.point(character.col, character.row);
      pips.push({
        kind: "pip",
        x: point.x + OFFICE_TILE / 2,
        y: point.y + OFFICE_TILE / 2,
        status,
        glyph: pipGlyphOf(status),
        agentId: character.agentId,
      });
    }
    return pips;
  }

  /** Whoever in the rect is not in their own chair - the culled set, as promised. */
  private awayAgentIdsAmong(
    characters: ReadonlyArray<OfficeCharacter>,
  ): ReadonlySet<string> {
    const away = new Set<string>();
    for (const character of characters) {
      if (character.seated) continue;
      away.add(character.agentId);
    }
    return away;
  }

  /**
   * The characters, in draw order, with their name tags.
   *
   * A CUBBY occupant is the exception, and the reason is that a cubby is a
   * waiting slot rather than a workstation: below close-up its painter draws a
   * silhouette in the slot, so drawing the character too would put two bodies
   * in one one-tile box. At close-up the character itself is drawn, dimmed - a
   * cold agent is present rather than working. One that is WALKING is an
   * ordinary actor at every level: it has left the slot.
   */
  private buildActors(
    characters: ReadonlyArray<OfficeCharacter>,
    lod: OfficeLod,
  ): ReadonlyArray<OfficeWorldDrawable> {
    const actors: OfficeWorldDrawable[] = [];
    for (const character of characters) {
      const agent = this.agentById.get(character.agentId);
      if (agent === undefined) continue;
      const inCubby = this.seatedInCubby(character.agentId);
      if (inCubby && lod < 2) continue;
      const archived = this.archivedIds.has(character.agentId);
      const foot = this.footPoint(character.col, character.row);
      const corner = this.spriteCornerOf(foot);
      const x = corner.x;
      const y = corner.y;
      const render = this.renderStateOf(character);
      // Sorted by the FEET, which is what "in front of" means on a floor: a
      // taller sprite does not stand nearer, and a world painter interleaves
      // its props against this same number.
      const depth = foot.y;
      actors.push({
        drawable: {
          kind: "sprite",
          sprite: {
            name: "character",
            facing: render.facing,
            pose: render.pose,
            appearance: agent.appearance,
            accessory: render.accessory,
          },
          x,
          y,
          alpha: characterAlpha(archived, inCubby),
        },
        depth,
        ownerAgentId: character.agentId,
      });
      actors.push({
        drawable: {
          kind: "label",
          text: truncate(agent.name, MAX_LABEL_CHARS),
          x: x + OFFICE_CHARACTER_WIDTH / 2,
          y: y + OFFICE_CHARACTER_HEIGHT + LABEL_GAP,
          tone: archived ? "muted" : "default",
          ownerAgentId: character.agentId,
        },
        depth,
        ownerAgentId: character.agentId,
      });
    }
    return actors;
  }

  /** The envelopes in flight. Always built: there are at most two dozen. */
  private buildEnvelopes(): ReadonlyArray<OfficeDrawable> {
    const overlay: OfficeDrawable[] = [];
    for (const envelope of this.envelopes) {
      const from = this.seatPointOf(envelope.fromAgentId);
      const to = this.seatPointOf(envelope.toAgentId);
      if (from === null || to === null) continue;
      const progress = easeInOut(
        clamp(envelope.elapsedMs / envelope.durationMs, 0, 1),
      );
      overlay.push({
        kind: "envelope",
        x: from.x + (to.x - from.x) * progress,
        y:
          from.y +
          (to.y - from.y) * progress -
          ENVELOPE_ARC_LIFT * 4 * progress * (1 - progress),
        pulseKind: envelope.pulseKind,
        progress,
        edgeId: envelope.edgeId,
      });
    }
    return overlay;
  }

  private buildOverlay(rect: OfficeRect): ReadonlyArray<OfficeDrawable> {
    const overlay: OfficeDrawable[] = [];
    const clockSize = officeSpriteSize({ name: "clock" });
    for (const floor of this.currentLayout.floors) {
      // CENTER anchored on the face the `clock` prop just drew, so the hands
      // pivot on the dial rather than on its corner.
      const face = this.point(floor.clockTile.col, floor.clockTile.row);
      // How far the art reaches ABOVE its own tile - a sprite-space constant,
      // so it is added to the PROJECTED tile top rather than recomputed from
      // an unprojected row.
      const overhang = OFFICE_TILE - clockSize.height;
      const y = face.y + overhang;
      if (
        !rectsOverlap(
          { x: face.x, y, width: clockSize.width, height: clockSize.height },
          rect,
        )
      ) {
        continue;
      }
      overlay.push({
        kind: "clock",
        x: face.x + clockSize.width / 2,
        y: y + clockSize.height / 2,
        timeMs: this.clockMs,
      });
    }
    for (const character of this.charactersIn(rect)) {
      const head = this.headPointOfCharacter(character);
      const bubble = this.bubbleFor(character);
      if (bubble !== null) {
        // Only the attention bubble bobs; a floor where every bubble moved
        // would read as noise rather than as a call for help.
        const bobOffset =
          Math.floor(this.nowMs / BUBBLE_BOB_MS) % 2 === 0 ? -1 : 1;
        const bob = bubble === "bubble-attention" ? bobOffset : 0;
        overlay.push({
          kind: "sprite",
          sprite: { name: bubble },
          x: head.x,
          y: head.y - BUBBLE_GAP + bob,
        });
      }
      if (character.sparkleMs > 0) {
        overlay.push({
          kind: "sprite",
          sprite: { name: "sparkle" },
          x: head.x,
          y: head.y - BUBBLE_GAP,
        });
      }
      this.pushWateringDrawables(overlay, character, head);
      this.pushScreenSparkle(overlay, character, "arcade");
      this.pushScreenSparkle(overlay, character, "tv");
      // Once per PAIR, from the lower id, or the ball would be drawn twice on
      // top of itself. Chess is played without one - see `errandBubbleFor`.
      if (character.rallying && character.errandTarget?.kind !== "chess") {
        const partner = this.rallyPartnerOf(character);
        if (partner !== null && character.agentId < partner.agentId) {
          this.pushRallyBall(overlay, character, partner);
        }
      }
    }
    for (const ball of this.paperBalls) {
      const point = this.paperBallPointOf(ball);
      overlay.push({
        kind: "sprite",
        sprite: { name: "paper-ball" },
        x: point.x,
        y: point.y,
      });
    }
    // Envelopes are never culled: there are at most two dozen, and one flying
    // in from off screen is exactly the thing worth seeing arrive.
    overlay.push(...this.buildEnvelopes());
    return overlay;
  }

  /**
   * The can in the waterer's hand, and the sparkle on the plant that ends the
   * job. The can hangs beside the body rather than over the head: it is held,
   * not thought, and every other overlay sprite is a bubble.
   *
   * The sparkle lands on the PLANT the spot names, so what reads as watered
   * is the plant and not the person - and it lands there in an isometric view
   * too, because the tile goes through the projector like everything else.
   */
  private pushWateringDrawables(
    overlay: OfficeDrawable[],
    character: OfficeCharacter,
    head: OfficePoint,
  ): void {
    const target = character.errandTarget;
    if (target === null || target.kind !== "water-plant") return;
    if (character.errand !== "errand-wait") return;
    overlay.push({
      kind: "sprite",
      sprite: { name: "watering-can" },
      x: head.x + WATERING_CAN_X_OFFSET,
      y: head.y + WATERING_CAN_Y_OFFSET,
    });
    if (character.waitMs > SPARKLE_MS) return;
    const plantTile = target.actionTile;
    if (plantTile === null) return;
    const plant = this.tileCenter(plantTile);
    overlay.push({
      kind: "sprite",
      sprite: { name: "sparkle" },
      x: plant.x,
      y: plant.y,
    });
  }

  /**
   * A screen flashing every couple of seconds while somebody is at it: the
   * arcade cabinet, and the television over the console sofa. On the SCREEN
   * rather than over the player's head - what is happening is on the screen,
   * and the player is only sitting or standing there.
   *
   * The screen is the one the SPOT names rather than an offset from where the
   * player stands, so how far back the sofa is stays the plan's business.
   */
  private pushScreenSparkle(
    overlay: OfficeDrawable[],
    character: OfficeCharacter,
    screen: OfficeSpriteName,
  ): void {
    const target = character.errandTarget;
    if (target === null || character.errand !== "errand-wait") return;
    const wanted = screen === "arcade" ? "arcade" : "console";
    if (target.kind !== wanted) return;
    const gapMs =
      screen === "arcade" ? ARCADE_SPARKLE_GAP_MS : CONSOLE_SPARKLE_GAP_MS;
    const played = character.lingerTotalMs - character.waitMs;
    if (played % gapMs >= SPARKLE_MS) return;
    const tile = target.actionTile;
    if (tile === null) return;
    const point = this.tileCenter(tile);
    overlay.push({
      kind: "sprite",
      sprite: { name: "sparkle" },
      x: point.x,
      y: point.y,
    });
  }

  /**
   * A transient acknowledgement outranks a standing state: it lasts under a
   * second and reports the row the cursor is on, which is what the viewer is
   * looking at. The standing bubble is still there when it expires.
   */
  private bubbleFor(character: OfficeCharacter): OfficeSpriteName | null {
    const transient = character.bubble;
    if (transient !== null) return transient.sprite;
    const status = this.statusOf(character.agentId);
    // A failure needs a person exactly as much as an interview does, and the
    // crashed screen at the desk is what says which of the two it is.
    if (status === "failure" || status === "attention") {
      return "bubble-attention";
    }
    if (status === "awaiting") return "bubble-awaiting";
    // Standing at the board is thinking out loud; talking to somebody is the
    // same bubble, alternating so only one of the pair holds it at a time.
    // Looking in at somebody else's door is the same shape of thought.
    const errandBubble = this.errandBubbleFor(character);
    if (errandBubble !== null) return errandBubble;
    return this.chatBubbleFor(character);
  }

  /**
   * The bubble an agent wears because of WHERE it is, not because of what its
   * agent record says. Standing at the board is thinking out loud; talking to
   * somebody is the same bubble; looking in at somebody else's door is the
   * same shape of thought.
   */
  private errandBubbleFor(character: OfficeCharacter): OfficeSpriteName | null {
    const target = character.errandTarget;
    if (character.errand !== "errand-wait" || target === null) return null;
    if (target.kind === "whiteboard" || target.kind === "peek") {
      return "bubble-awaiting";
    }
    // Holding a side of a table open. Once somebody takes the other one the
    // game itself is what says the two are together, so the bubble goes - for
    // chess, which has no ball, the thinking bubble takes over instead.
    if (isTwoPlayerKind(target.kind) && !character.rallying) {
      return "bubble-awaiting";
    }
    if (target.kind === "chess") return this.chessThoughtFor(character);
    // A sofa is where an agent dozes off, on the long sits and in their second
    // half - see `dozingOnSofa`. A bag is where one is asleep outright, once it
    // has had a moment to settle onto it.
    if (target.kind === "sofa" && this.dozingOnSofa(character)) {
      return "bubble-sleep";
    }
    if (target.kind === "nap") {
      const settled = character.lingerTotalMs - character.waitMs;
      return settled >= NAP_SETTLE_MS ? "bubble-sleep" : null;
    }
    // Reading: the thought comes and goes on its own beat, a page at a time,
    // rather than standing for the whole sit the way a status bubble would.
    if (target.kind === "read") {
      const read = character.lingerTotalMs - character.waitMs;
      return read % READ_THOUGHT_CYCLE_MS < READ_THOUGHT_ON_MS
        ? "bubble-awaiting"
        : null;
    }
    return null;
  }

  /**
   * Whose turn it is to think at the chess table. One bubble at a time, passed
   * between the two players on a shared clock - the same shape as a
   * conversation, because that is what a game without a ball looks like from
   * above.
   */
  private chessThoughtFor(character: OfficeCharacter): OfficeSpriteName | null {
    if (!character.rallying) return null;
    const partner = this.rallyPartnerOf(character);
    if (partner === null) return null;
    const movesFirst = character.agentId < partner.agentId;
    const onBeat = Math.floor(this.nowMs / CHESS_THINK_MS) % 2 === 0;
    return movesFirst === onBeat ? "bubble-awaiting" : null;
  }

  /**
   * FRONT-MOST FIRST, which is the reverse of the order the frame is drawn in:
   * a character walking across somebody else's desk is what the pointer is
   * over, and so is the nearer of two overlapping towers. The renderer and
   * `hitTest` both take the FIRST match, so the order IS the precedence.
   */
  private buildHitRegions(
    characters: ReadonlyArray<OfficeCharacter>,
    seats: ReadonlyArray<SeatedAgent>,
  ): ReadonlyArray<OfficeHitRegion> {
    const regions: OfficeHitRegion[] = [];
    for (let index = characters.length - 1; index >= 0; index -= 1) {
      const character = characters[index];
      regions.push({
        agentId: character.agentId,
        rect: this.characterBox(character),
      });
    }
    for (let index = seats.length - 1; index >= 0; index -= 1) {
      const seated = seats[index];
      regions.push({
        agentId: seated.agentId,
        rect: this.seatBox(seated.seat),
      });
    }
    return regions;
  }

  private focusPoint(): OfficePoint | null {
    const inFlight = this.envelopes.at(0);
    if (inFlight !== undefined) return this.seatPointOf(inFlight.fromAgentId);
    const senderId = pulseSenderId(this.pulse);
    if (senderId === null) return null;
    return this.headPointOf(senderId);
  }

  // ---- Shared derivations -------------------------------------------- //

  /**
   * Every agent that exists at the cursor and has somewhere to sit, with the
   * seat it is actually in - the CLAIM where it holds one, never the plan's
   * opening offer.
   */
  private visibleSeats(): ReadonlyArray<SeatedAgent> {
    const seated: SeatedAgent[] = [];
    for (const agentId of this.seats.knownAgentIds()) {
      if (!this.visibleAgentIds.has(agentId)) continue;
      const seat = this.seats.effectiveSeat(agentId);
      if (seat === null) continue;
      seated.push({ agentId, seat });
    }
    return seated;
  }

  /**
   * Canonical order by id. Every decision that has to break a tie between two
   * equally eligible agents reads this, so WHO gets up, WHO speaks first and
   * WHO is visited are facts about their ids rather than about insertion order.
   */
  private orderedByAgentId(): ReadonlyArray<OfficeCharacter> {
    if (
      this.byAgentIdCache !== null &&
      this.byAgentIdVersion === this.membershipVersion
    ) {
      return this.byAgentIdCache;
    }
    const ordered = Array.from(this.characters.values()).sort((left, right) =>
      compareIdPair(left.agentId, right.agentId),
    );
    this.byAgentIdCache = ordered;
    this.byAgentIdVersion = this.membershipVersion;
    return ordered;
  }

  /** The cabin a seat stands in, by the id the plan put on the seat. */
  private roomOfSeat(seat: OfficeSeat): OfficeRoom | null {
    const roomId = seat.roomId;
    if (roomId === null) return null;
    for (const room of this.currentLayout.rooms) {
      if (room.rootAgentId === roomId) return room;
    }
    return null;
  }

  /** Baseline order: a character lower on the floor overlaps one above it. */
  private orderedCharacters(): ReadonlyArray<OfficeCharacter> {
    const cached = this.orderedCache;
    if (cached !== null) return cached;
    const ordered = Array.from(this.characters.values()).sort((left, right) => {
      if (left.row !== right.row) return left.row - right.row;
      if (left.col !== right.col) return left.col - right.col;
      return compareIdPair(left.agentId, right.agentId);
    });
    this.orderedCache = ordered;
    return ordered;
  }

  private headPointOf(agentId: string): OfficePoint | null {
    const character = this.characters.get(agentId);
    if (character === undefined) return null;
    return this.headPointOfCharacter(character);
  }

  private headPointOfCharacter(character: OfficeCharacter): OfficePoint {
    const foot = this.footPoint(character.col, character.row);
    return { x: foot.x, y: foot.y - OFFICE_CHARACTER_HEIGHT };
  }

  /**
   * Where an agent's head is WHEN SEATED - the endpoint every envelope uses.
   * A flight aimed at a live position lands in an empty chair the moment its
   * owner is walking in or standing at reception.
   *
   * Lifted by the seat's own `seatLift`, so a message between two rooftops in
   * the City flies between the rooftops rather than through the streets.
   */
  private seatPointOf(agentId: string): OfficePoint | null {
    const seat = this.seats.effectiveSeat(agentId);
    if (seat === null) return null;
    const foot = this.footPoint(seat.chairTile.col, seat.chairTile.row);
    return {
      x: foot.x,
      y: foot.y - OFFICE_CHARACTER_HEIGHT - this.projector.seatLift(seat),
    };
  }

  /** The storey an agent lives on; its door, lobby and reception are that one's. */
  private floorIndexOfAgent(agentId: string): number {
    const seat = this.seats.effectiveSeat(agentId);
    if (seat === null) return 0;
    const floors = this.currentLayout.floors;
    if (seat.floorIndex < 0 || seat.floorIndex >= floors.length) return 0;
    return seat.floorIndex;
  }

  private floorOfAgent(agentId: string): OfficeFloor {
    return this.currentLayout.floors[this.floorIndexOfAgent(agentId)];
  }

  private queueFacingOf(agentId: string): OfficeFacing {
    return this.floorOfAgent(agentId).queueFacing;
  }

  private isWalkable(tile: OfficeTilePos): boolean {
    const layout = this.currentLayout;
    if (tile.row < 0 || tile.row >= layout.rows) return false;
    if (tile.col < 0 || tile.col >= layout.cols) return false;
    return layout.walkable[tile.row][tile.col];
  }

  /**
   * Where a visitor stands to call on somebody: BEHIND their chair, looking at
   * them, which is the aisle tile under a desk on this floor.
   *
   * Per PARTNER rather than per room, which is what makes a visit read as two
   * people talking. The room's own `visitTile` is the fallback for a view
   * whose chairs have nothing standable behind them - one tile for a whole
   * cabin is a queue, not a conversation, so it is the last resort and not the
   * rule.
   */
  private visitTileNear(
    seat: OfficeSeat,
    room: OfficeRoom | null,
  ): OfficeTilePos | null {
    const behind = stepAgainst(seat.chairTile, seat.facing);
    if (this.isWalkable(behind)) return behind;
    const fallback = room?.visitTile ?? null;
    if (fallback === null || !this.isWalkable(fallback)) return null;
    return fallback;
  }

  /**
   * WAKING. A cold agent in a cubby whose status turns hot takes the first free
   * reserve seat it can, and gives it back once it has gone quiet and is home.
   *
   * Attention and failure still queue at reception first; the claim is made
   * here all the same, so the seat is spoken for from the moment the wake is
   * decided rather than from the moment the walk ends - otherwise somebody
   * else takes it while this one is standing in line.
   */
  private updateSeatClaims(): void {
    const rehome: string[] = [];
    for (const agentId of this.seats.knownAgentIds()) {
      const assigned = this.seats.assignedSeat(agentId);
      if (assigned === null || assigned.kind !== "cubby") continue;
      const before = this.seats.effectiveSeat(agentId);
      const hot =
        this.visibleAgentIds.has(agentId) &&
        !this.archivedIds.has(agentId) &&
        isOfficeHotStatus(this.statusById.get(agentId));
      if (hot) {
        this.seats.claim(agentId, {
          roomId: assigned.roomId,
          floorIndex: assigned.floorIndex,
        });
      } else {
        this.seats.endClaim(agentId);
        // The seat is free once the character is OUT of it, which on a floor
        // with motion means once it is back home and seated again.
        const character = this.characters.get(agentId);
        const home =
          character === undefined ||
          (character.seated &&
            character.col === assigned.chairTile.col &&
            character.row === assigned.chairTile.row);
        if (home) this.seats.vacated(agentId);
      }
      const after = this.seats.effectiveSeat(agentId);
      if (before?.seatId !== after?.seatId) rehome.push(agentId);
    }
    // A wake and a cooling-off both MOVE somebody, so the character walks -
    // which is the whole visible point of a reserve seat.
    this.rehomeCharacters(rehome);
  }

  /** The named place an agent standing somewhere is AT, for the hover card. */
  private awayWhereabouts(
    layout: OfficeLayout,
    character: OfficeCharacter,
  ): string {
    if (this.inReceptionQueue(character)) return "Reception";
    if (character.errand === "arriving" || character.errand === "leaving") {
      return "Lobby";
    }
    const target = character.errandTarget;
    if (target !== null && target.kind === "visit") return "Visiting";
    const tile = {
      col: Math.round(character.col),
      row: Math.round(character.row),
    };
    return this.placeNameAt(
      layout,
      tile,
      this.floorIndexOfAgent(character.agentId),
    );
  }

  /**
   * What the plan calls the place a tile is in: an amenity's name, a cabin's,
   * or the open floor. Read off the layout rather than off a label the plan
   * carried, so it stays true when somebody walks.
   */
  private placeNameAt(
    layout: OfficeLayout,
    tile: OfficeTilePos,
    floorIndex: number,
  ): string {
    // A layout always has at least one storey, so an index off the end falls
    // back to the first rather than to nothing.
    const floor = layout.floors[floorIndex] ?? layout.floors[0];
    for (const amenity of floor.amenities) {
      if (withinTileRect(amenity.bounds, tile)) return amenity.name;
    }
    for (const room of layout.rooms) {
      if (withinTileRect(room.bounds, tile)) return room.name;
    }
    return "Open floor";
  }
}
