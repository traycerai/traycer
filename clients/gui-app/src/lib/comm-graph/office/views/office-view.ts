/**
 * The seam every office view implements.
 *
 * One `OfficeScene` runs the simulation for all of them, so a view is not a
 * subclass and not a renderer: it is three PURE pieces and nothing mutable.
 *
 * - The **plan** says where everything is, in tiles, with stable ids. It is
 *   handed the population partition, the seat book's occupancy, the viewport
 *   and exactly one previous layout, and it returns a whole `OfficeLayout`.
 * - The **measure** answers how big that layout would be, from the same
 *   packing arithmetic, without the walkability pass, the spots or the flood
 *   fills. Auto uses it to choose a view and nothing else does.
 * - The **painter** turns a layout into sprites: a projector per layout, the
 *   floor of one chunk, a seat's props for one desk state, a spot's props.
 *
 * What is deliberately NOT here: any state. A view is a value, held in a
 * registry and read; caching belongs to the scene and the renderer, which know
 * when it may be thrown away.
 */
import type { GuiHarnessId } from "@traycer/protocol/persistence/epic/foundation";
import type { OfficePopulation } from "@/lib/comm-graph/office/office-population";
import {
  TOWERS_VIEW,
  BUILDING_VIEW,
} from "@/lib/comm-graph/office/views/oblique/oblique-plan";
import { floorPainter } from "@/lib/comm-graph/office/views/floor/floor-painter";
import { measureFloor } from "@/lib/comm-graph/office/views/floor/floor-measure";
import { planFloor } from "@/lib/comm-graph/office/views/floor/floor-plan";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeDrawable,
  OfficeErrandSpot,
  OfficeLayout,
  OfficeLod,
  OfficeModelTier,
  OfficePoint,
  OfficeRect,
  OfficeSeat,
  OfficeSize,
  OfficeTileRect,
  OfficeViewId,
  OfficeWorldDrawable,
} from "@/lib/comm-graph/office/office-types";

/**
 * Everything a plan is allowed to know. It is the whole input: a plan that
 * reached for anything else would be reading state the scene owns, and two
 * plans of the same input have to be the same layout for scrub-back to work.
 */
export interface OfficePlanInput {
  /** EVERY agent in the epic, not only the ones visible at the cursor. */
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  /** HQ, teams and solos per host; frozen for agents that were here before. */
  readonly partition: OfficePopulation;
  /**
   * `seatId` to `agentId` from the seat book. A seat named here is SPOKEN
   * FOR - the plan may move it, but it may not give it to somebody else.
   */
  readonly occupancy: ReadonlyMap<string, string>;
  /** Agents the book could not seat; this plan has to make room for them. */
  readonly needsCapacity: ReadonlyArray<string>;
  /** Edge counts over the displayed graph. Only City's heights read it. */
  readonly activityById: ReadonlyMap<string, number>;
  /**
   * The canvas in CSS pixels at plan time. A shape decision reads the aspect
   * ONCE and freezes it; a plan that re-read it would re-shape the office
   * every time the window changed size.
   */
  readonly viewport: OfficeSize;
  /** Exactly one layout back, never a chain. */
  readonly previous: OfficeLayout | null;
}

export type OfficePlanFn = (input: OfficePlanInput) => OfficeLayout;

/**
 * The size the plan WOULD come to, in world pixels. Auto compares this against
 * the canvas, so it must follow the plan's own packing arithmetic - a measure
 * that guessed would pick a view the plan then contradicts.
 */
export type OfficeMeasureFn = (input: OfficePlanInput) => OfficeSize;

/**
 * Tiles to canvas points, for one layout. Built once per layout and immutable:
 * every point the scene emits goes through it, so a projector that changed
 * under the scene would move things that had not moved.
 */
export interface OfficeProjector {
  /** Fractional tiles are allowed - a walker is between two of them. */
  readonly project: (col: number, row: number) => OfficePoint;
  /**
   * The union of every projected drawable, origin folded in so nothing in the
   * layout ever projects to a negative coordinate.
   */
  readonly bounds: OfficeRect;
  /** How far above the floor a seat sits - City rooftops; `0` everywhere else. */
  readonly seatLift: (seat: OfficeSeat) => number;
}

/**
 * What one desk currently LOOKS like, as the scene sees it. The painter is
 * pure, so everything that varies with the simulation arrives here rather than
 * being looked up: a painter holds no reference to the scene.
 */
export interface OfficeDeskState {
  /** Who sits here, or `null` for a reserve seat nobody has taken. */
  readonly agentId: string | null;
  /** The occupant's display name, or `null` where nobody sits here. */
  readonly name: string | null;
  readonly status: OfficeAgentStatus;
  /** Archived and gone: the desk wears a dust sheet and a box beside it. */
  readonly sheeted: boolean;
  /** Unanswered requests piled on the desk; `0` draws no stack. */
  readonly openRequests: number;
  /** Which frame a lit screen is on, so a working monitor flickers. */
  readonly screenFrame: 0 | 1;
  /** The logo on the nameplate, or `null` for a record that carries none. */
  readonly harnessId: GuiHarnessId | null;
  /** Decides the screen: laptop, single monitor, or dual wide. */
  readonly modelTier: OfficeModelTier;
  /**
   * The occupant's TEAM, as the partition names it - the lead's agent id, and
   * the same id a solo stranded on another host still carries, so the two read
   * as one team across two buildings. `null` for HQ, an unattributed solo and
   * an empty seat.
   *
   * A painter that tints by team (the quiet stack's silhouettes) reads it; the
   * Floor, whose rooms ARE the teams, does not.
   */
  readonly accentId: string | null;
}

/**
 * How a view is DRAWN. `depth` is the one structural choice: a `layered`
 * painter emits props and then actors, as the office always has; a `world`
 * painter emits one depth-ordered stream because its props and its characters
 * genuinely interleave and no amount of sorting actors alone can fix that.
 */
export interface OfficePainter {
  readonly depth: "layered" | "world";
  readonly projector: (layout: OfficeLayout) => OfficeProjector;
  /** One chunk of floor. At lod 0 this is a block map, not tiles. */
  readonly floor: (
    layout: OfficeLayout,
    tiles: OfficeTileRect,
    lod: OfficeLod,
  ) => ReadonlyArray<OfficeDrawable>;
  readonly seatProps: (
    layout: OfficeLayout,
    seat: OfficeSeat,
    state: OfficeDeskState,
    lod: OfficeLod,
  ) => ReadonlyArray<OfficeWorldDrawable>;
  readonly spotProps: (
    layout: OfficeLayout,
    spot: OfficeErrandSpot,
    lod: OfficeLod,
  ) => ReadonlyArray<OfficeWorldDrawable>;
}

/** One view, whole. Stateless: the registry hands the same value out forever. */
export interface OfficeView {
  readonly id: OfficeViewId;
  /** What the picker calls it. */
  readonly label: string;
  /** One line under the label, saying what this view is good for. */
  readonly description: string;
  readonly plan: OfficePlanFn;
  readonly measure: OfficeMeasureFn;
  readonly painter: OfficePainter;
}

/**
 * EVERY view that ships, by id.
 *
 * The record is exhaustive over `OfficeViewId` by its type, which is the whole
 * point of registering a view here and in the union together: a half-registered
 * view does not compile, so the picker, the persisted choice, the parser and
 * every `describe.each` below cannot disagree about what exists.
 *
 * Stateless, and never a cache. A view is three pure functions and two strings;
 * whatever is expensive belongs to the scene and the renderer, which know when
 * it may be thrown away.
 */
export const OFFICE_VIEWS: Readonly<Record<OfficeViewId, OfficeView>> = {
  floor: {
    id: "floor",
    label: "Floor",
    description:
      "One walled cabin per team on a single storey. Every desk is drawn; best up to a few dozen agents.",
    plan: planFloor,
    measure: measureFloor,
    painter: floorPainter,
  },
  towers: TOWERS_VIEW,
  building: BUILDING_VIEW,
};

/**
 * The registry's order, which is the order the picker lists and every shared
 * suite enumerates. Derived rather than written down, so registering a view is
 * one edit and enrolling it in the tests is none.
 */
export const OFFICE_VIEW_IDS: ReadonlyArray<OfficeViewId> =
  Object.keys(OFFICE_VIEWS).filter(isOfficeViewId);

/**
 * Narrows a key of {@link OFFICE_VIEWS} back to its own type. `Object.keys`
 * erases to `string[]`, and a cast to put the type back would re-introduce
 * exactly the drift deriving the list removes.
 */
function isOfficeViewId(id: string): id is OfficeViewId {
  return Object.hasOwn(OFFICE_VIEWS, id);
}
