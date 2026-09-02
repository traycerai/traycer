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
 * - A character sits at `(col * OFFICE_TILE, row * OFFICE_TILE - 4)`: its feet
 *   land on its tile and its head rises above it.
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
import { findOfficePath } from "@/lib/comm-graph/office/office-path";
import {
  OFFICE_CHARACTER_HEIGHT,
  OFFICE_CHARACTER_WIDTH,
  OFFICE_TILE,
  officeTileCenter,
  type OfficeAgentInput,
  type OfficeAgentStatus,
  type OfficeCharacterPose,
  type OfficeDesk,
  type OfficeDrawable,
  type OfficeEnvelopeHitRegion,
  type OfficeErrandKind,
  type OfficeErrandSpot,
  type OfficeFacing,
  type OfficeFloor,
  type OfficeFrame,
  type OfficeHitRegion,
  type OfficeLayout,
  type OfficeModelTier,
  type OfficePod,
  type OfficePodStyle,
  type OfficePoint,
  type OfficeProp,
  type OfficeRect,
  type OfficeRoom,
  type OfficeSceneInput,
  type OfficeSpriteName,
  type OfficeSpriteRef,
  type OfficeTilePos,
  type OfficeTileRect,
} from "@/lib/comm-graph/office/office-types";

export type OfficeLayoutFn = (
  agents: ReadonlyArray<OfficeAgentInput>,
) => OfficeLayout;

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
const CHARACTER_Y_OFFSET = -4;
const BUBBLE_GAP = 2;
const LABEL_GAP = 8;
const MAX_LABEL_CHARS = 14;
/** A cabin's sign is two tiles wide, so its name gets less room than a desk's. */
const MAX_ROOM_LABEL_CHARS = 12;
/** A pod's plate is ONE tile, so its name gets less room again. */
const MAX_POD_LABEL_CHARS = 10;
/** Baseline of the pod name, measured down from the plate sprite's own top. */
const POD_PLATE_LABEL_BASELINE = 11;
/**
 * How each pod style draws its outline. The vertical piece takes the corners
 * too: a corner belongs to the side that carries the run, and a horizontal
 * piece turned on its end reads as a mistake.
 */
interface OfficePodOutlineArt {
  readonly vertical: OfficeSpriteName;
  readonly horizontal: OfficeSpriteName;
}

const POD_OUTLINE_ART: Readonly<Record<OfficePodStyle, OfficePodOutlineArt>> = {
  glass: { vertical: "partition", horizontal: "partition-h" },
  // A planter box reads the same from any side, so one sprite serves the ring.
  planters: { vertical: "planter", horizontal: "planter" },
  shelves: { vertical: "shelf", horizontal: "shelf-h" },
};

/**
 * The tinted floor inside a pod, as a checker. Depth swaps which variant lands
 * on an even tile, so a pod nested inside another never lines up with its
 * parent's floor even where the two share a tint.
 */
const POD_FLOOR_ART: Readonly<
  Record<"cool" | "warm", readonly [OfficeSpriteName, OfficeSpriteName]>
> = {
  cool: ["floor-pod-a", "floor-pod-b"],
  warm: ["floor-pod-warm-a", "floor-pod-warm-b"],
};
/** Baseline of the cabin name, measured down from the sign sprite's own top. */
const SIGN_LABEL_BASELINE = 11;
const SIGN_WIDTH_TILES = 2;
/**
 * A lit screen is never still: two frames alternate while an agent is in a
 * turn, and far more slowly while it is only working in the background.
 */
const MONITOR_WORKING_FRAME_MS = 260;
const MONITOR_BACKGROUND_FRAME_MS = 700;
/** The plate on the desk's right half, and the logo standing on top of it. */
const NAMEPLATE_Y_OFFSET = 4;
const LOGO_Y_OFFSET = 1;
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
const IDLE_MONITOR_ALPHA = 0.6;
const ARCHIVED_ALPHA = 0.45;
const DESK_WIDTH_TILES = 2;
/** Desk row plus chair row - what a click on "that person's desk" means. */
const DESK_HIT_ROWS = 2;
/** Spread of the per-agent animation phase offset. */
const PHASE_SPREAD_MS = 1000;
/**
 * The unanswered-request pile, indexed by how many are waiting (1, 2, 3+).
 * Every height shares one BASE line on the desk, so the pile grows upward as
 * it deepens instead of floating off the furniture.
 */
interface OfficeEnvelopeStack {
  readonly sprite: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
}

const ENVELOPE_STACKS: ReadonlyArray<OfficeEnvelopeStack> = [
  { sprite: "envelope-stack-1", xOffset: 1, yOffset: -2 },
  { sprite: "envelope-stack-2", xOffset: 1, yOffset: -4 },
  { sprite: "envelope-stack-3", xOffset: 1, yOffset: -6 },
];

/**
 * The screen on a desk, by the coarse size class of the agent's model: a
 * laptop, a single monitor, or dual wide displays. `onB` is the second lit
 * frame, and a tier that has none simply does not animate.
 *
 * Offsets sit the screen on the desk's back edge, aligned to where the desk
 * sprite draws its keyboard rather than to the desk's own centre - the screen
 * belongs behind the keys, not behind the middle of the furniture. The crash
 * map is one 16x12 for every tier, so it carries its OWN offset rather than
 * borrowing a wide screen's.
 *
 * The plate moves with the screen for the same reason: a wide display reaches
 * across the desk's right half, so a large tier sets its own plate and badge
 * columns instead of overlapping them.
 */
interface OfficeScreenArt {
  readonly on: OfficeSpriteName;
  readonly onB: OfficeSpriteName | null;
  readonly off: OfficeSpriteName;
  readonly xOffset: number;
  readonly yOffset: number;
  readonly crashXOffset: number;
  readonly crashYOffset: number;
  readonly plateXOffset: number;
  readonly logoXOffset: number;
}

const SCREEN_ART: Readonly<Record<OfficeModelTier, OfficeScreenArt>> = {
  small: {
    on: "monitor-small-on",
    onB: null,
    off: "monitor-small-off",
    xOffset: 5,
    yOffset: -5,
    crashXOffset: 3,
    crashYOffset: -8,
    plateXOffset: 18,
    logoXOffset: 24,
  },
  medium: {
    on: "monitor-on",
    onB: "monitor-on-b",
    off: "monitor-off",
    xOffset: 3,
    yOffset: -8,
    crashXOffset: 3,
    crashYOffset: -8,
    plateXOffset: 18,
    logoXOffset: 24,
  },
  large: {
    on: "monitor-wide-on",
    onB: "monitor-wide-on-b",
    off: "monitor-wide-off",
    xOffset: 0,
    yOffset: -8,
    crashXOffset: 4,
    crashYOffset: -8,
    plateXOffset: 20,
    logoXOffset: 26,
  },
};

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
  readonly tile: OfficeTilePos;
  readonly facing: OfficeFacing;
  /** The colleague a `visit` is paid to; `null` for every other kind. */
  readonly partnerId: string | null;
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

interface SortedProp {
  readonly drawable: OfficeDrawable;
  readonly sortY: number;
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
 * What a thrower is aiming at, or `null` for an errand that throws nothing.
 * A dart and a crumpled page fly the same arc at the same cadence; only the
 * target prop and whether a shot can miss differ.
 */
function throwTargetSpriteOf(
  kind: OfficeErrandTargetKind,
): OfficeSpriteName | null {
  if (kind === "bin") return "bin";
  if (kind === "darts") return "dartboard";
  return null;
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

/** Which way a character is turned partway through a filler, and how it sits. */
function fillerPoseOf(filler: OfficeFiller): {
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
  return { pose: "stand", facing: "up" };
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

/**
 * Where a prop's sprite is drawn, given that props are TOP-LEFT anchored.
 *
 * A prop taller than its tile would otherwise spill DOWN over whatever sits
 * on the row below - a plant over its own chair, a rug over the doorway.
 * Lifting by the overhang puts the sprite's FOOT on its tile, which is where
 * a standing object actually stands; a one-tile prop is unaffected.
 */
function spriteFootY(sprite: OfficeSpriteRef, tileRow: number): number {
  return (
    tileRow * OFFICE_TILE - (officeSpriteSize(sprite).height - OFFICE_TILE)
  );
}

function propDrawY(prop: OfficeProp): number {
  return spriteFootY(prop.sprite, prop.tile.row);
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

function seatedCharacter(agentId: string, desk: OfficeDesk): OfficeCharacter {
  return {
    ...blankCharacter(agentId),
    col: desk.chairTile.col,
    row: desk.chairTile.row,
    // Seated means facing the screen, which is up the floor and away from us.
    facing: "up",
    seated: true,
  };
}

export class OfficeScene {
  private readonly layoutOf: OfficeLayoutFn;
  private currentLayout: OfficeLayout;
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

  /** `layoutOffice` in production; injected so tests can pin a floor plan. */
  constructor(layoutOf: OfficeLayoutFn) {
    this.layoutOf = layoutOf;
    this.currentLayout = layoutOf([]);
  }

  layout(): OfficeLayout {
    return this.currentLayout;
  }

  sync(input: OfficeSceneInput): void {
    const firstSync = !this.synced;
    this.synced = true;
    this.visibleAgentIds = input.visibleAgentIds;
    this.statusById = input.statusById;
    this.openRequestsByReceiver = input.openRequestsByReceiver;
    this.playing = input.playing;
    this.reducedMotion = input.reducedMotion;
    this.stepMs = input.stepMs;
    this.cursorMs = input.cursorMs;
    this.clockMs = input.clockMs;
    this.pulse = input.pulse;
    this.agentById = new Map(input.agents.map((agent) => [agent.id, agent]));

    const signature = agentSetSignature(input.agents);
    const layoutChanged = signature !== this.agentSignature;
    if (layoutChanged) {
      this.agentSignature = signature;
      this.currentLayout = this.layoutOf(input.agents);
      // Before reconciling, so a newly spawned walker is not immediately
      // re-pathed to the destination it was just given.
      this.rehomeCharacters();
    }
    this.applyArchivalTransitions(input, firstSync);
    this.reconcileCharacters(input, firstSync);
    this.returningIds.clear();
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
  }

  tick(dtMs: number): void {
    if (dtMs <= 0) return;
    this.nowMs += dtMs;
    for (const character of this.characters.values()) {
      this.advanceCharacter(character, dtMs);
    }
    this.updateErrandStarts();
    this.advanceEnvelopes(dtMs);
    this.advancePaperBalls(dtMs);
  }

  frame(): OfficeFrame {
    const overlay = this.buildOverlay();
    return {
      size: {
        width: this.currentLayout.cols * OFFICE_TILE,
        height: this.currentLayout.rows * OFFICE_TILE,
      },
      floor: this.buildFloor(),
      props: this.buildProps(),
      actors: this.buildActors(),
      overlay,
      hitRegions: this.buildHitRegions(),
      envelopeHitRegions: envelopeHitRegionsOf(overlay),
      focus: this.focusPoint(),
    };
  }

  /** Characters win over desks: a person is the more specific target. */
  hitTest(point: OfficePoint): string | null {
    const ordered = this.orderedCharacters();
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const character = ordered[index];
      const x = character.col * OFFICE_TILE;
      const y = character.row * OFFICE_TILE + CHARACTER_Y_OFFSET;
      if (
        point.x >= x &&
        point.x < x + OFFICE_CHARACTER_WIDTH &&
        point.y >= y &&
        point.y < y + OFFICE_CHARACTER_HEIGHT
      ) {
        return character.agentId;
      }
    }
    for (const desk of this.visibleDesks()) {
      const x = desk.deskTile.col * OFFICE_TILE;
      const y = desk.deskTile.row * OFFICE_TILE;
      if (
        point.x >= x &&
        point.x < x + DESK_WIDTH_TILES * OFFICE_TILE &&
        point.y >= y &&
        point.y < y + DESK_HIT_ROWS * OFFICE_TILE
      ) {
        return desk.agentId;
      }
    }
    return null;
  }

  /**
   * The pair edge of the envelope under the point, topmost first - a message
   * is a more specific target than the floor it happens to be flying over, so
   * the canvas asks this BEFORE `hitTest`.
   */
  hitTestEnvelope(point: OfficePoint): string | null {
    const regions = envelopeHitRegionsOf(this.buildOverlay());
    for (let index = regions.length - 1; index >= 0; index -= 1) {
      const region = regions[index];
      if (containsPoint(region.rect, point)) return region.edgeId;
    }
    return null;
  }

  // ---- Population ---------------------------------------------------- //

  /**
   * Archived AS OF THE CURSOR, which is the only reading a scrubbable floor
   * can use: `archivedAt` is a moment on the same timeline the cursor sits on,
   * so a record archived after the cursor is still at its desk in that view.
   */
  private isArchivedAsOf(agent: OfficeAgentInput): boolean {
    const archivedAt = agent.archivedAt;
    if (archivedAt === null) return false;
    return this.cursorMs === null || archivedAt <= this.cursorMs;
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
      const desk = this.currentLayout.desks.get(agent.id);
      if (desk === undefined) continue;
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
        this.characters.set(agent.id, this.spawnAtDoor(agent.id, desk));
        continue;
      }
      const character = seatedCharacter(agent.id, desk);
      if (announced) character.sparkleMs = SPARKLE_MS;
      this.characters.set(agent.id, character);
    }
  }

  private removeCharacter(agentId: string): void {
    this.characters.delete(agentId);
    this.envelopes = this.envelopes.filter(
      (envelope) =>
        envelope.fromAgentId !== agentId && envelope.toAgentId !== agentId,
    );
  }

  private spawnAtDoor(agentId: string, desk: OfficeDesk): OfficeCharacter {
    const door = this.floorOfAgent(agentId).doorTile;
    const path = findOfficePath(this.currentLayout, door, desk.chairTile);
    if (path === null || path.length === 0) {
      return seatedCharacter(agentId, desk);
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
  private rehomeCharacters(): void {
    for (const character of this.characters.values()) {
      if (character.errand === "leaving") continue;
      if (this.inReceptionQueue(character)) continue;
      const desk = this.currentLayout.desks.get(character.agentId);
      if (desk === undefined) continue;
      const destination = this.destinationOf(character);
      if (
        destination.col === desk.chairTile.col &&
        destination.row === desk.chairTile.row
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
    const desk = this.currentLayout.desks.get(character.agentId);
    if (desk === undefined) {
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
    if (this.walkTo(character, desk.chairTile)) {
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
    character.facing = "up";
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
      // Facing the counter, which is the way a person waiting actually stands.
      character.facing = "down";
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
   * A game's two spots are laid on the same ROW a couple of tiles apart, so the
   * table they belong to is the one they share a row with - and the kind has to
   * match, because a floor with a foosball table has a ping-pong one beside it.
   */
  private rallyPartnerOf(character: OfficeCharacter): OfficeCharacter | null {
    const target = character.errandTarget;
    if (target === null || !isTwoPlayerKind(target.kind)) return null;
    if (character.errand !== "errand-wait") return null;
    for (const other of this.orderedByAgentId()) {
      if (other.agentId === character.agentId) continue;
      if (other.errand !== "errand-wait") continue;
      const theirs = other.errandTarget;
      if (theirs === null || theirs.kind !== target.kind) continue;
      if (theirs.tile.row !== target.tile.row) continue;
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
    if (target === null || throwTargetSpriteOf(target.kind) === null) return;
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
    const sprite = throwTargetSpriteOf(target.kind);
    if (sprite === null) return;
    const targetTile = this.propTileAbove(target.tile, sprite);
    if (targetTile === null) return;
    const seed = mixSeed(
      hashAgentId(character.agentId),
      character.throwsLeft + Math.floor(this.nowMs / 1000),
    );
    const missed = target.kind === "bin" && seed % 100 < PAPER_MISS_PERCENT;
    const aim = officeTileCenter(targetTile);
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

  /**
   * The nearest prop of this name standing above a spot, in the spot's own
   * column. Every spot that acts ON something is laid out looking up at it, so
   * this is how the scene asks the plan what a spot is FOR without knowing how
   * the plan spaced the two apart.
   */
  private propTileAbove(
    tile: OfficeTilePos,
    name: OfficeSpriteName,
  ): OfficeTilePos | null {
    let found: OfficeTilePos | null = null;
    for (const prop of this.currentLayout.props) {
      if (prop.sprite.name !== name) continue;
      if (prop.tile.col !== tile.col) continue;
      if (prop.tile.row >= tile.row) continue;
      if (found !== null && prop.tile.row <= found.row) continue;
      found = prop.tile;
    }
    return found;
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
    if (this.playing || this.reducedMotion) {
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
    return this.propTileAbove(target.tile, "bench") !== null;
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
    if (this.playing || this.reducedMotion) return;
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
      const key = tileKeyOf(spot.tile);
      if (claimed.has(key)) continue;
      if (key === character.lastErrandKey) continue;
      if (spot.kind === character.lastErrandKind) continue;
      if (!this.spotSuitsAgent(character, spot)) continue;
      options.push({
        kind: spot.kind,
        tile: spot.tile,
        facing: spot.facing,
        partnerId: null,
      });
    }
    if (character.lastErrandKind !== "visit") {
      const visit = this.visitTargetFor(character, claimed, seed);
      if (visit !== null) options.push(visit);
    }
    return options;
  }

  /**
   * Whether this spot is one THIS agent has any business at. Three kinds are
   * about whose room you are in rather than about what is on the floor:
   *
   * - a bin and a plant belong to the cabin they stand in, and walking into
   *   somebody else's room to throw paper away is not a break, it is trespass;
   * - a peek is the exact opposite - the point of it is another team's door.
   *
   * A deskless agent has no cabin, so it is refused all three rather than being
   * given the run of every room on the floor.
   */
  private spotSuitsAgent(
    character: OfficeCharacter,
    spot: OfficeErrandSpot,
  ): boolean {
    if (spot.kind === "bin" || spot.kind === "water-plant") {
      const room = this.roomOfAgent(character.agentId);
      if (room === null) return false;
      return withinTileRect(room.bounds, spot.tile);
    }
    if (spot.kind !== "peek") return true;
    const room = this.roomOfAgent(character.agentId);
    if (room === null) return false;
    // The tile is the corridor OUTSIDE a door, so the cabin it belongs to is
    // the one whose door is the tile above it.
    return !sameTile(
      { col: spot.tile.col, row: spot.tile.row - 1 },
      room.doorTile,
    );
  }

  /**
   * A corridor tile to stand on when every spot is taken. Any walkable tile
   * that is not inside a room, the break room, the lobby row or the reception
   * queue - the floor's own corridors, which is where somebody with nowhere to
   * be would actually be.
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
    return {
      kind: "corridor",
      tile: options[seed % options.length],
      facing: "down",
      partnerId: null,
    };
  }

  private corridorTilesFor(
    character: OfficeCharacter,
    claimed: ReadonlySet<string>,
  ): ReadonlyArray<OfficeTilePos> {
    const layout = this.currentLayout;
    const floor = this.floorOfAgent(character.agentId);
    const reserved = new Set<string>([
      tileKeyOf(floor.doorTile),
      tileKeyOf(floor.lobbyTile),
      ...floor.receptionQueueTiles.map(tileKeyOf),
      // A tile the plan already named is that errand's, not somewhere to
      // stand about: a stroll that stopped on the peek spot outside a door
      // would be paying somebody a visit it never chose.
      ...floor.errandSpots.map((spot) => tileKeyOf(spot.tile)),
    ]);
    const first = floor.bounds.row + 2;
    const last = floor.lobbyTile.row - 1;
    const tiles: OfficeTilePos[] = [];
    for (let row = first; row <= last; row += 1) {
      for (let col = 1; col < layout.cols - 1; col += 1) {
        if (!layout.walkable[row][col]) continue;
        const tile: OfficeTilePos = { col, row };
        const key = tileKeyOf(tile);
        if (claimed.has(key) || reserved.has(key)) continue;
        if (key === character.lastErrandKey) continue;
        if (layout.rooms.some((room) => withinTileRect(room.bounds, tile))) {
          continue;
        }
        // Inside an amenity you are AT that amenity; a stroll that wandered
        // through the nap room would be somebody standing between the beds.
        if (floor.amenities.some((room) => withinTileRect(room.bounds, tile))) {
          continue;
        }
        tiles.push(tile);
      }
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
    const room = this.roomOfAgent(character.agentId);
    if (room === null) return null;
    const layout = this.currentLayout;
    const hosts: OfficeErrandTarget[] = [];
    for (const desk of this.visibleDesks()) {
      if (desk.agentId === character.agentId) continue;
      if (!withinTileRect(room.bounds, desk.deskTile)) continue;
      const colleague = this.characters.get(desk.agentId);
      if (colleague === undefined || !colleague.seated) continue;
      const status = this.statusOf(desk.agentId);
      if (status !== "idle" && status !== "working") continue;
      const tile: OfficeTilePos = {
        col: desk.chairTile.col,
        row: desk.chairTile.row + 1,
      };
      if (tile.row >= layout.rows) continue;
      if (!layout.walkable[tile.row][tile.col]) continue;
      const key = tileKeyOf(tile);
      if (claimed.has(key) || key === character.lastErrandKey) continue;
      hosts.push({
        kind: "visit",
        tile,
        facing: "up",
        partnerId: desk.agentId,
      });
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
    if (throwTargetSpriteOf(target.kind) !== null) {
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
      const key = tileKeyOf(spot.tile);
      if (claimed.has(key) || key === character.lastErrandKey) continue;
      options.push({
        kind: spot.kind,
        tile: spot.tile,
        facing: spot.facing,
        partnerId: null,
      });
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
      character.facing = "down";
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
  } {
    const filler = character.filler;
    if (filler !== null && character.seated) return fillerPoseOf(filler);
    return { pose: this.poseFor(character), facing: character.facing };
  }

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
   * A cabin's own walls. They sit ON the floor tiles and UNDER the lobby rug:
   * the building's inner structure, not furniture standing on it.
   */
  private pushCabinWalls(floor: OfficeDrawable[], room: OfficeRoom): void {
    const { col, row, cols, rows } = room.bounds;
    const right = col + cols - 1;
    const bottom = row + rows - 1;
    const wallAt = (wallCol: number, wallRow: number): void => {
      const isDoor =
        wallRow === room.doorTile.row && wallCol === room.doorTile.col;
      floor.push({
        kind: "sprite",
        sprite: { name: isDoor ? "door" : "wall" },
        x: wallCol * OFFICE_TILE,
        y: wallRow * OFFICE_TILE,
      });
    };
    for (let scanCol = col; scanCol <= right; scanCol += 1) {
      floor.push({
        kind: "sprite",
        sprite: { name: "wall-top" },
        x: scanCol * OFFICE_TILE,
        y: row * OFFICE_TILE,
      });
      wallAt(scanCol, row + 1);
      wallAt(scanCol, bottom);
    }
    for (let scanRow = row + 2; scanRow < bottom; scanRow += 1) {
      wallAt(col, scanRow);
      wallAt(right, scanRow);
    }
  }

  /**
   * A pod's tinted carpet, on TOP of the cabin's own floor and under
   * everything that stands on it - a tinted region is a different bit of
   * carpet, not a thing in the room.
   *
   * Deepest LAST, so a nested pod's tint wins over its parent's on the tiles
   * the two share.
   */
  private pushPodFloors(floor: OfficeDrawable[], room: OfficeRoom): void {
    for (const pod of [...room.pods].sort((a, b) => a.depth - b.depth)) {
      const [even, odd] = POD_FLOOR_ART[pod.tint];
      const lastRow = pod.bounds.row + pod.bounds.rows;
      const lastCol = pod.bounds.col + pod.bounds.cols;
      for (let row = pod.bounds.row; row < lastRow; row += 1) {
        for (let col = pod.bounds.col; col < lastCol; col += 1) {
          const alternate = (col + row + pod.depth) % 2 === 0;
          floor.push({
            kind: "sprite",
            sprite: { name: alternate ? even : odd },
            x: col * OFFICE_TILE,
            y: row * OFFICE_TILE,
          });
        }
      }
    }
  }

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
      if (status === "attention" || status === "failure") return true;
      if (this.statusById.get(character.agentId) === "awaiting") return true;
    }
    return false;
  }

  private buildFloor(): ReadonlyArray<OfficeDrawable> {
    const layout = this.currentLayout;
    const floor: OfficeDrawable[] = [];
    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < layout.cols; col += 1) {
        floor.push({
          kind: "sprite",
          sprite: { name: this.floorSpriteAt(col, row) },
          x: col * OFFICE_TILE,
          y: row * OFFICE_TILE,
        });
      }
    }
    for (const room of layout.rooms) this.pushCabinWalls(floor, room);
    for (const room of layout.rooms) this.pushPodFloors(floor, room);
    // Every amenity's ring is drawn with the cabins' own two sprites, and the
    // garden's with a hedge instead. Their doors are not carried in the plan
    // and do not need to be: a ring tile the grid still says is walkable IS
    // the door, by construction.
    for (const floorPlan of layout.floors) {
      for (const room of floorPlan.amenities) {
        this.pushRoomRing(floor, room.bounds, room.kind === "garden");
      }
    }
    // A stairwell is a hole in the FLOOR, not a thing standing on it, so it is
    // drawn from its own top-left tile with no foot lift at all.
    for (const floorPlan of layout.floors) {
      const stairsTile = floorPlan.stairsTile;
      if (stairsTile === null) continue;
      floor.push({
        kind: "sprite",
        sprite: { name: "stairs" },
        x: stairsTile.col * OFFICE_TILE,
        y: stairsTile.row * OFFICE_TILE,
      });
    }
    for (const prop of layout.props) {
      if (prop.sprite.name !== "rug") continue;
      // Centred on its tile as well as lifted onto it: the rug is wider than
      // one tile and the door sits directly below the lobby, so a top-left
      // draw would carpet over the way in.
      const overhang = officeSpriteSize(prop.sprite).width - OFFICE_TILE;
      floor.push({
        kind: "sprite",
        sprite: prop.sprite,
        x: prop.tile.col * OFFICE_TILE - overhang / 2,
        y: propDrawY(prop),
      });
    }
    return floor;
  }

  /**
   * One amenity's ring: cap, wall face, sides, and its own doorway.
   *
   * A HEDGE is the same ring in a different material - a garden is bounded, not
   * built - so the two share every tile and differ only in the sprite. Its
   * opening is still the one ring tile the grid says is walkable, exactly as a
   * walled room's door is.
   */
  private pushRoomRing(
    floor: OfficeDrawable[],
    room: OfficeTileRect,
    hedge: boolean,
  ): void {
    const { col, row, cols, rows } = room;
    const right = col + cols - 1;
    const bottom = row + rows - 1;
    const ringAt = (ringCol: number, ringRow: number): void => {
      const name = this.ringSpriteAt(ringCol, ringRow, { hedge, cap: false });
      if (name === null) return;
      floor.push({
        kind: "sprite",
        sprite: { name },
        x: ringCol * OFFICE_TILE,
        y: ringRow * OFFICE_TILE,
      });
    };
    for (let scanCol = col; scanCol <= right; scanCol += 1) {
      const capName = this.ringSpriteAt(scanCol, row, { hedge, cap: true });
      if (capName !== null) {
        floor.push({
          kind: "sprite",
          sprite: { name: capName },
          x: scanCol * OFFICE_TILE,
          y: row * OFFICE_TILE,
        });
      }
      ringAt(scanCol, row + 1);
      ringAt(scanCol, bottom);
    }
    for (let scanRow = row + 2; scanRow < bottom; scanRow += 1) {
      ringAt(col, scanRow);
      ringAt(right, scanRow);
    }
  }

  /**
   * One tile of a room's boundary: its cap row, or the wall below and around
   * it. `null` means draw nothing, which is what a gap in a hedge is - a garden
   * is bounded rather than built, so its way in has no door hanging in it.
   */
  private ringSpriteAt(
    col: number,
    row: number,
    style: { readonly hedge: boolean; readonly cap: boolean },
  ): OfficeSpriteName | null {
    const open = this.currentLayout.walkable[row][col];
    if (style.hedge) return open ? null : "planter";
    if (style.cap) return "wall-top";
    return open ? "door" : "wall";
  }

  private floorSpriteAt(col: number, row: number): OfficeSpriteName {
    const layout = this.currentLayout;
    for (const floor of layout.floors) {
      if (row === floor.doorTile.row && col === floor.doorTile.col) {
        return "door";
      }
    }
    // A storey's cap wins over the storey above's bottom wall on the row the
    // two SHARE: what a viewer sees between two floors is one capped wall.
    for (const floor of layout.floors) {
      if (row === floor.bounds.row) return "wall-top";
    }
    for (const floor of layout.floors) {
      const top = floor.bounds.row;
      if (row === top + 1 || row === top + floor.bounds.rows - 1) return "wall";
    }
    if (col === 0 || col === layout.cols - 1) return "wall";
    // A garden's ground is GRASS, and grass is floor rather than a thing
    // standing on it: drawn here, under the hedge and under everyone in it.
    if (this.inGarden(col, row)) {
      return (col + row) % 2 === 0 ? "floor-grass-a" : "floor-grass-b";
    }
    return (col + row) % 2 === 0 ? "floor-a" : "floor-b";
  }

  /**
   * Inside a garden's hedge, the hedge itself excluded. The boundary is two
   * rows deep at the top exactly as a wall is - the cap and the face under it -
   * because it is the same ring in another material.
   */
  private inGarden(col: number, row: number): boolean {
    for (const floor of this.currentLayout.floors) {
      for (const room of floor.amenities) {
        if (room.kind !== "garden") continue;
        const { bounds } = room;
        if (col <= bounds.col || col >= bounds.col + bounds.cols - 1) continue;
        if (row <= bounds.row + 1 || row >= bounds.row + bounds.rows - 1) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  private buildProps(): ReadonlyArray<OfficeDrawable> {
    const sorted: SortedProp[] = [];
    for (const desk of this.visibleDesks()) {
      const deskX = desk.deskTile.col * OFFICE_TILE;
      const deskY = desk.deskTile.row * OFFICE_TILE;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "desk" },
          x: deskX,
          y: deskY,
        },
        sortY: deskY,
      });
      if (this.isDeskSheeted(desk.agentId)) {
        this.pushSheetedDesk(sorted, desk);
        continue;
      }
      // Shares the desk's sort key so it always lands ON the desk, even though
      // it is drawn above the desk's own top edge.
      const art = this.screenArtFor(desk.agentId);
      const screen = this.monitorSpriteFor(desk.agentId);
      const crashed = screen === "monitor-crash";
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: screen },
          x: deskX + (crashed ? art.crashXOffset : art.xOffset),
          y: deskY + (crashed ? art.crashYOffset : art.yOffset),
          alpha: this.monitorAlphaFor(desk.agentId),
        },
        sortY: deskY,
      });
      // After the screen, in the same bucket: the paper is in FRONT of the
      // display's lower-left corner, not behind it.
      const stack = this.envelopeStackFor(desk.agentId);
      if (stack !== null) {
        sorted.push({
          drawable: {
            kind: "sprite",
            sprite: { name: stack.sprite },
            x: deskX + stack.xOffset,
            y: deskY + stack.yOffset,
          },
          sortY: deskY,
        });
      }
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "chair" },
          x: desk.chairTile.col * OFFICE_TILE,
          y: desk.chairTile.row * OFFICE_TILE,
        },
        sortY: desk.chairTile.row * OFFICE_TILE,
      });
      // The plate and its logo share the desk's sort key for the same reason
      // the monitor does: they are ON the desk, drawn above its own top edge.
      const plateX = deskX + art.plateXOffset;
      const plateY = deskY + NAMEPLATE_Y_OFFSET;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: { name: "nameplate" },
          x: plateX,
          y: plateY,
        },
        sortY: deskY,
      });
      const agent = this.agentById.get(desk.agentId);
      // The scene places the logo and never sees the icon; a record that
      // carries no harness simply has an empty plate.
      if (agent !== undefined && agent.harnessId !== null) {
        sorted.push({
          drawable: {
            kind: "logo",
            harnessId: agent.harnessId,
            x: deskX + art.logoXOffset,
            y: deskY + LOGO_Y_OFFSET,
          },
          sortY: deskY,
        });
      }
    }
    for (const room of this.currentLayout.rooms) {
      this.pushSign(sorted, room.signTile, room.name);
      for (const pod of room.pods) this.pushPodOutline(sorted, pod);
    }
    // The break room and the game room are named the same way a cabin is: a
    // walled room nobody owns still has to say what it is for.
    for (const floorPlan of this.currentLayout.floors) {
      for (const sign of floorPlan.areaSigns) {
        this.pushSign(sorted, sign.signTile, sign.name);
      }
    }
    for (const prop of this.currentLayout.props) {
      if (prop.sprite.name === "rug") continue;
      sorted.push({
        drawable: {
          kind: "sprite",
          sprite: prop.sprite,
          x: prop.tile.col * OFFICE_TILE,
          y: propDrawY(prop),
        },
        // Keyed by the prop's TILE, never by its lifted draw position: a tall
        // prop still belongs to the row it occupies, and sorting on the lift
        // would file it behind the row above.
        sortY: prop.tile.row * OFFICE_TILE,
      });
    }
    // Stable, so same-row props keep the order they were pushed in.
    sorted.sort((left, right) => left.sortY - right.sortY);
    return sorted.map((entry) => entry.drawable);
  }

  /**
   * A pod's boundary: its outline, drawn in the style the plan gave it, and the
   * plate carrying the sub-team's name.
   *
   * The OPENING is the ring tile the grid still says is walkable, exactly as a
   * room's door is - the scene never has to be told twice where a way in is.
   * The plate's own tile carries the plate instead of a length of outline,
   * which is what makes the name look mounted on the boundary rather than
   * floating beside it.
   */
  private pushPodOutline(sorted: SortedProp[], pod: OfficePod): void {
    const { col, row, cols, rows } = pod.bounds;
    const left = col - 1;
    const top = row - 1;
    const right = col + cols;
    const bottom = row + rows;
    for (let scanCol = left; scanCol <= right; scanCol += 1) {
      for (let scanRow = top; scanRow <= bottom; scanRow += 1) {
        const name = this.podOutlineSpriteAt(pod, scanCol, scanRow);
        if (name === null) continue;
        sorted.push({
          drawable: {
            kind: "sprite",
            sprite: { name },
            x: scanCol * OFFICE_TILE,
            y: spriteFootY({ name }, scanRow),
          },
          sortY: scanRow * OFFICE_TILE,
        });
      }
    }
    this.pushPodPlate(sorted, pod);
  }

  /**
   * Which piece of a pod's outline stands on one tile, or `null` where none
   * does: off the ring, on the plate's own tile, or on a tile the grid says is
   * WALKABLE - which is how the single opening stays open. A corner takes the
   * vertical piece, so the two runs meet rather than butting end to end.
   */
  private podOutlineSpriteAt(
    pod: OfficePod,
    col: number,
    row: number,
  ): OfficeSpriteName | null {
    const left = pod.bounds.col - 1;
    const top = pod.bounds.row - 1;
    const right = pod.bounds.col + pod.bounds.cols;
    const bottom = pod.bounds.row + pod.bounds.rows;
    const onRing =
      col === left || col === right || row === top || row === bottom;
    if (!onRing) return null;
    if (col === pod.plateTile.col && row === pod.plateTile.row) return null;
    if (this.isWalkableTile(col, row)) return null;
    const art = POD_OUTLINE_ART[pod.style];
    // A corner is on a side column too, so this covers it: the two runs meet
    // at the vertical piece rather than butting end to end.
    const vertical = col === left || col === right;
    return vertical ? art.vertical : art.horizontal;
  }

  /**
   * The pod's name plate, and its name written across it. On the outline's
   * corner, so a nested pod's plate cannot land on a tile its parent's outline
   * already owns.
   */
  private pushPodPlate(sorted: SortedProp[], pod: OfficePod): void {
    const plateX = pod.plateTile.col * OFFICE_TILE;
    const plateY = spriteFootY({ name: "pod-plate" }, pod.plateTile.row);
    const sortY = pod.plateTile.row * OFFICE_TILE;
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "pod-plate" },
        x: plateX,
        y: plateY,
      },
      sortY,
    });
    sorted.push({
      drawable: {
        kind: "label",
        text: truncate(pod.name, MAX_POD_LABEL_CHARS),
        x: plateX + OFFICE_TILE / 2,
        y: plateY + POD_PLATE_LABEL_BASELINE,
        tone: "bright",
      },
      sortY,
    });
  }

  private isWalkableTile(col: number, row: number): boolean {
    const layout = this.currentLayout;
    if (row < 0 || row >= layout.rows) return false;
    if (col < 0 || col >= layout.cols) return false;
    return layout.walkable[row][col];
  }

  /**
   * A two-tile wall sign with its name written across it. Every named region on
   * the floor - a cabin, the break room, the game room - is signed the same way,
   * so one of them cannot drift into looking like a different kind of place.
   */
  private pushSign(
    sorted: SortedProp[],
    signTile: OfficeTilePos,
    name: string,
  ): void {
    const signX = signTile.col * OFFICE_TILE;
    const signY = spriteFootY({ name: "sign" }, signTile.row);
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "sign" },
        x: signX,
        y: signY,
      },
      sortY: signTile.row * OFFICE_TILE,
    });
    sorted.push({
      drawable: {
        kind: "label",
        text: truncate(name, MAX_ROOM_LABEL_CHARS),
        x: signX + (SIGN_WIDTH_TILES * OFFICE_TILE) / 2,
        y: signY + SIGN_LABEL_BASELINE,
        // The sign's field is dark in both themes, so the name is written on
        // it rather than in the floor's own text colour.
        tone: "bright",
      },
      sortY: signTile.row * OFFICE_TILE,
    });
  }

  /**
   * An archived agent's desk, once its character has left: sheeted over, its
   * chair holding a packed box, no screen and no plate. The name stays, muted,
   * because a nameless sheeted desk is a hole in the floor plan rather than a
   * record of who used to sit there.
   */
  private pushSheetedDesk(sorted: SortedProp[], desk: OfficeDesk): void {
    const deskX = desk.deskTile.col * OFFICE_TILE;
    const deskY = desk.deskTile.row * OFFICE_TILE;
    const chairX = desk.chairTile.col * OFFICE_TILE;
    const chairY = desk.chairTile.row * OFFICE_TILE;
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "dust-sheet" },
        x: deskX,
        y: deskY,
      },
      sortY: deskY,
    });
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "chair" },
        x: chairX,
        y: chairY,
      },
      sortY: chairY,
    });
    // Under the desk's RIGHT half - the chair is under its left, and a packed
    // box standing in the seat would read as furniture rather than as moving
    // out.
    const boxTile: OfficeTilePos = {
      col: desk.deskTile.col + 1,
      row: desk.deskTile.row + 1,
    };
    sorted.push({
      drawable: {
        kind: "sprite",
        sprite: { name: "box" },
        x: boxTile.col * OFFICE_TILE,
        y: spriteFootY({ name: "box" }, boxTile.row),
      },
      sortY: boxTile.row * OFFICE_TILE,
    });
    const agent = this.agentById.get(desk.agentId);
    if (agent === undefined) return;
    sorted.push({
      drawable: {
        kind: "label",
        text: truncate(agent.name, MAX_LABEL_CHARS),
        // Exactly where the seated character's own label was, so the desk does
        // not appear to shift when its owner leaves.
        x: chairX + OFFICE_CHARACTER_WIDTH / 2,
        y: chairY + CHARACTER_Y_OFFSET + OFFICE_CHARACTER_HEIGHT + LABEL_GAP,
        tone: "muted",
      },
      sortY: chairY,
    });
  }

  /** Sheeted once the archive is real AND the person has actually gone. */
  private isDeskSheeted(agentId: string): boolean {
    return this.departedIds.has(agentId) && this.archivedIds.has(agentId);
  }

  private envelopeStackFor(agentId: string): OfficeEnvelopeStack | null {
    const character = this.characters.get(agentId);
    // A message that landed while its owner was away is on the desk in exactly
    // the sense the pile already draws: waiting, unanswered, in front of them.
    const waiting = character === undefined ? 0 : character.pending.length;
    const open = (this.openRequestsByReceiver.get(agentId) ?? 0) + waiting;
    if (open <= 0) return null;
    const index = Math.min(open, ENVELOPE_STACKS.length) - 1;
    return ENVELOPE_STACKS[index];
  }

  private screenArtFor(agentId: string): OfficeScreenArt {
    const agent = this.agentById.get(agentId);
    if (agent === undefined) return SCREEN_ART.medium;
    return SCREEN_ART[agent.modelTier];
  }

  private monitorSpriteFor(agentId: string): OfficeSpriteName {
    const status = this.statusOf(agentId);
    // One crash map serves every tier; the renderer draws it at the tier's own
    // screen offset, which is where that desk's display already was.
    if (status === "failure") return "monitor-crash";
    const art = this.screenArtFor(agentId);
    if (status === "archived") return art.off;
    if (status === "working") {
      return this.screenFrame(agentId, art, MONITOR_WORKING_FRAME_MS);
    }
    if (status === "background") {
      return this.screenFrame(agentId, art, MONITOR_BACKGROUND_FRAME_MS);
    }
    return art.on;
  }

  /** Shares the typing phase offset, so a screen and its typist agree. */
  private screenFrame(
    agentId: string,
    art: OfficeScreenArt,
    frameMs: number,
  ): OfficeSpriteName {
    const second = art.onB;
    // A laptop has one lit frame, so it simply does not flicker.
    if (second === null) return art.on;
    const phase = this.nowMs + phaseOffsetMs(agentId);
    return Math.floor(phase / frameMs) % 2 === 0 ? art.on : second;
  }

  private monitorAlphaFor(agentId: string): number | undefined {
    const status = this.statusOf(agentId);
    // Idle keeps a LIT monitor, merely dimmed: the screen is on, nobody is at
    // it. Only an archived record actually powers down.
    if (status === "idle") return IDLE_MONITOR_ALPHA;
    if (status === "archived") return ARCHIVED_ALPHA;
    return undefined;
  }

  private buildActors(): ReadonlyArray<OfficeDrawable> {
    const actors: OfficeDrawable[] = [];
    for (const character of this.orderedCharacters()) {
      const agent = this.agentById.get(character.agentId);
      if (agent === undefined) continue;
      const archived = this.archivedIds.has(character.agentId);
      const x = character.col * OFFICE_TILE;
      const y = character.row * OFFICE_TILE + CHARACTER_Y_OFFSET;
      const render = this.renderStateOf(character);
      actors.push({
        kind: "sprite",
        sprite: {
          name: "character",
          facing: render.facing,
          pose: render.pose,
          appearance: agent.appearance,
        },
        x,
        y,
        alpha: archived ? ARCHIVED_ALPHA : undefined,
      });
      actors.push({
        kind: "label",
        text: truncate(agent.name, MAX_LABEL_CHARS),
        x: x + OFFICE_CHARACTER_WIDTH / 2,
        y: y + OFFICE_CHARACTER_HEIGHT + LABEL_GAP,
        tone: archived ? "muted" : "default",
      });
    }
    return actors;
  }

  private buildOverlay(): ReadonlyArray<OfficeDrawable> {
    const overlay: OfficeDrawable[] = [];
    const clockSize = officeSpriteSize({ name: "clock" });
    for (const floor of this.currentLayout.floors) {
      // CENTER anchored on the face the `clock` prop just drew, so the hands
      // pivot on the dial rather than on its corner.
      overlay.push({
        kind: "clock",
        x: floor.clockTile.col * OFFICE_TILE + clockSize.width / 2,
        y:
          spriteFootY({ name: "clock" }, floor.clockTile.row) +
          clockSize.height / 2,
        timeMs: this.clockMs,
      });
    }
    for (const character of this.orderedCharacters()) {
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

  /**
   * The can in the waterer's hand, and the sparkle on the plant that ends the
   * job. The can hangs beside the body rather than over the head: it is held,
   * not thought, and every other overlay sprite is a bubble.
   *
   * The sparkle lands on the PLANT, one tile up from where the character
   * stands, so what reads as watered is the plant and not the person.
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
    const plantTile = this.propTileAbove(target.tile, "plant");
    if (plantTile === null) return;
    const plant = officeTileCenter(plantTile);
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
   * The screen is looked up above the spot rather than offset from it, so how
   * far back the sofa stands stays the layout's business.
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
    const tile = this.propTileAbove(target.tile, screen);
    if (tile === null) return;
    const point = officeTileCenter(tile);
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

  private buildHitRegions(): ReadonlyArray<OfficeHitRegion> {
    const regions: OfficeHitRegion[] = [];
    for (const character of this.orderedCharacters()) {
      regions.push({
        agentId: character.agentId,
        rect: {
          x: character.col * OFFICE_TILE,
          y: character.row * OFFICE_TILE + CHARACTER_Y_OFFSET,
          width: OFFICE_CHARACTER_WIDTH,
          height: OFFICE_CHARACTER_HEIGHT,
        },
      });
    }
    for (const desk of this.visibleDesks()) {
      regions.push({
        agentId: desk.agentId,
        rect: {
          x: desk.deskTile.col * OFFICE_TILE,
          y: desk.deskTile.row * OFFICE_TILE,
          width: DESK_WIDTH_TILES * OFFICE_TILE,
          height: DESK_HIT_ROWS * OFFICE_TILE,
        },
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

  private visibleDesks(): ReadonlyArray<OfficeDesk> {
    const desks: OfficeDesk[] = [];
    for (const desk of this.currentLayout.desks.values()) {
      if (!this.visibleAgentIds.has(desk.agentId)) continue;
      desks.push(desk);
    }
    return desks;
  }

  /**
   * Canonical order by id. Every decision that has to break a tie between two
   * equally eligible agents reads this, so WHO gets up, WHO speaks first and
   * WHO is visited are facts about their ids rather than about insertion order.
   */
  private orderedByAgentId(): ReadonlyArray<OfficeCharacter> {
    return Array.from(this.characters.values()).sort((left, right) => {
      if (left.agentId === right.agentId) return 0;
      return left.agentId < right.agentId ? -1 : 1;
    });
  }

  /** The cabin an agent's desk stands in, or `null` for a desk-less record. */
  private roomOfAgent(agentId: string): OfficeRoom | null {
    const desk = this.currentLayout.desks.get(agentId);
    if (desk === undefined) return null;
    for (const room of this.currentLayout.rooms) {
      if (withinTileRect(room.bounds, desk.deskTile)) return room;
    }
    return null;
  }

  /** Baseline order: a character lower on the floor overlaps one above it. */
  private orderedCharacters(): ReadonlyArray<OfficeCharacter> {
    return Array.from(this.characters.values()).sort((left, right) => {
      if (left.row !== right.row) return left.row - right.row;
      if (left.col !== right.col) return left.col - right.col;
      if (left.agentId === right.agentId) return 0;
      return left.agentId < right.agentId ? -1 : 1;
    });
  }

  private headPointOf(agentId: string): OfficePoint | null {
    const character = this.characters.get(agentId);
    if (character === undefined) return null;
    return this.headPointOfCharacter(character);
  }

  private headPointOfCharacter(character: OfficeCharacter): OfficePoint {
    return {
      x: character.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
      y: character.row * OFFICE_TILE + CHARACTER_Y_OFFSET,
    };
  }

  /**
   * Where an agent's head is WHEN SEATED - the endpoint every envelope uses.
   * A flight aimed at a live position lands in an empty chair the moment its
   * owner is walking in or standing at reception.
   */
  private seatPointOf(agentId: string): OfficePoint | null {
    const desk = this.currentLayout.desks.get(agentId);
    if (desk === undefined) return null;
    return {
      x: desk.chairTile.col * OFFICE_TILE + OFFICE_CHARACTER_WIDTH / 2,
      y: desk.chairTile.row * OFFICE_TILE + CHARACTER_Y_OFFSET,
    };
  }

  /** The storey an agent lives on; its door, lobby and reception are that one's. */
  private floorIndexOfAgent(agentId: string): number {
    const desk = this.currentLayout.desks.get(agentId);
    if (desk === undefined) return 0;
    const floors = this.currentLayout.floors;
    for (let index = 0; index < floors.length; index += 1) {
      const top = floors[index].bounds.row;
      const bottom = top + floors[index].bounds.rows - 1;
      if (desk.deskTile.row >= top && desk.deskTile.row <= bottom) return index;
    }
    return 0;
  }

  private floorOfAgent(agentId: string): OfficeFloor {
    return this.currentLayout.floors[this.floorIndexOfAgent(agentId)];
  }
}
