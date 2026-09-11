/**
 * Two overview-floor coverage regressions left open by T5's cold review of
 * `08ee4f038`, on top of the seam that review closed: the original eleven
 * Campus/City corner misses (see `original-corner-sweep` in the review
 * evidence) are not reopened here.
 *
 * H1 - `cornerOverhangOf` (`views/isometric/iso-painter.ts`) derives its bleed
 * from a symmetric diamond, but a NONSQUARE tile rectangle projects to a
 * parallelogram. City freezes a district's width across appends, so a real
 * append-grown district gets steadily narrower against its height, and the
 * declared overhang stops being conservative enough.
 *
 * H2 - `isoBlockOverhang` walks every floor, amenity and room on EVERY
 * overview frame, before the scene's floor cache is even consulted, which
 * reintroduces the full-population work T5's painter index removed.
 *
 * Both are pinned through a real `OfficeScene` and real plans - a City that
 * actually grew by append, a Campus/City that actually seated `many-roots` -
 * because the regression is in the scene's floor query meeting a shape or a
 * repeat count a hand-built layout literal cannot reproduce.
 */
import { describe, expect, it } from "vitest";
import {
  partitionOfficePopulation,
  type OfficePopulation,
} from "@/lib/comm-graph/office/office-population";
import { OfficeScene } from "@/lib/comm-graph/office/office-scene";
import { makeTestEpic } from "@/lib/comm-graph/office/office-test-epic";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeDrawable,
  OfficeLayout,
  OfficeRect,
  OfficeSceneInput,
} from "@/lib/comm-graph/office/office-types";
import {
  OFFICE_VIEWS,
  type OfficePlanInput,
  type OfficeView,
} from "@/lib/comm-graph/office/views/office-view";

const VIEWS: ReadonlyArray<OfficeView> = [
  OFFICE_VIEWS.campus,
  OFFICE_VIEWS.city,
];

/** The canvas every scene here is built against; only the sweep geometry and the real pan below read anything narrower. */
const VIEWPORT = { width: 1280, height: 700 };

function sceneInputFor(
  agents: ReadonlyArray<OfficeAgentInput>,
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
  previous: OfficePopulation | null,
): OfficeSceneInput {
  return {
    agents,
    visibleAgentIds: new Set(agents.map((agent) => agent.id)),
    statusById,
    partition: partitionOfficePopulation({ agents, statusById, previous }),
    activityById: new Map<string, number>(),
    viewport: VIEWPORT,
    openRequestsByReceiver: new Map<string, number>(),
    pulse: null,
    pulseKey: null,
    stepMs: 0,
    cursorMs: null,
    clockMs: 0,
    playing: false,
    reducedMotion: true,
  };
}

function rectsOverlap(a: OfficeRect, b: OfficeRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

type BlockDrawable = Extract<OfficeDrawable, { kind: "block" }>;

function isBlockDrawable(drawable: OfficeDrawable): drawable is BlockDrawable {
  return drawable.kind === "block";
}

/** Whole-layout floor at lod 0: the ground truth the sweep below checks a real frame against. */
function wholeMapBlocks(
  view: OfficeView,
  layout: OfficeLayout,
): ReadonlyArray<BlockDrawable> {
  return view.painter
    .floor(layout, { col: 0, row: 0, cols: layout.cols, rows: layout.rows }, 0)
    .filter(isBlockDrawable);
}

interface OverviewMiss {
  readonly point: OfficeRect;
  readonly wanted: BlockDrawable;
  readonly actual: BlockDrawable | undefined;
}

/**
 * Nine points per block - both near corners, both edge midpoints and the
 * centre, on each axis - checked against a real per-rect `scene.frame(0, …)`
 * query rather than the whole-map floor it is compared to. The T5 review's
 * own probe (`t5-overview-handoff.test.ts`) uses the same nine fractions.
 */
const SWEEP_FRACTIONS: ReadonlyArray<number> = [0.001, 0.5, 0.999];

function sweepOverviewBlocks(
  scene: OfficeScene,
  view: OfficeView,
  layout: OfficeLayout,
): ReadonlyArray<OverviewMiss> {
  const whole = wholeMapBlocks(view, layout);
  const misses: OverviewMiss[] = [];
  for (const block of whole) {
    for (const fx of SWEEP_FRACTIONS) {
      for (const fy of SWEEP_FRACTIONS) {
        const point: OfficeRect = {
          x: block.x + block.width * fx,
          y: block.y + block.height * fy,
          width: 1,
          height: 1,
        };
        const wanted = whole.findLast((candidate) =>
          rectsOverlap(candidate, point),
        );
        if (wanted === undefined) continue;
        const actual = scene
          .frame(0, point)
          .floor.filter(isBlockDrawable)
          .findLast((candidate) => rectsOverlap(candidate, point));
        if (actual === undefined || actual.fill !== wanted.fill) {
          misses.push({ point, wanted, actual });
        }
      }
    }
  }
  return misses;
}

// ---- H1: the grown-City parallelogram geometry ------------------------- //

/** City's own append growth: `makeTestEpic("one-team", 3, 1)` plus 90, then 1,000 more independent solos, all working. */
const CITY_APPEND_COUNTS: ReadonlyArray<number> = [0, 90, 1000];

/**
 * Grows one City scene the way a real epic does: the previous partition and
 * scene layout are carried through every append, exactly as
 * `t5-overview-handoff.test.ts`'s `grown-city-sweep` probe does. City
 * deliberately freezes a district's WIDTH across appends, so the roster
 * growing 3 -> 93 -> 1,003 grows the same 18-wide district from 18x13 to
 * 18x46 to 18x410 tiles - narrower against its height every append, not
 * larger on both axes.
 */
function growAppendedCity(): OfficeScene {
  const view = OFFICE_VIEWS.city;
  const scene = new OfficeScene(view, null);
  const base = makeTestEpic("one-team", 3, 1).agents;
  let previous: OfficePopulation | null = null;
  for (const appended of CITY_APPEND_COUNTS) {
    const extra: ReadonlyArray<OfficeAgentInput> = Array.from(
      { length: appended },
      (_unused, index): OfficeAgentInput => ({
        ...base[0],
        id: `appended-${index}`,
        name: `Appended ${index}`,
        parentId: null,
        createdAt: 100_000 + index,
        archived: false,
        archivedAt: null,
      }),
    );
    const agents = [...base, ...extra];
    const statusById = new Map<string, OfficeAgentStatus>(
      agents.map((agent) => [agent.id, "working"]),
    );
    const input = sceneInputFor(agents, statusById, previous);
    previous = input.partition;
    scene.sync(input);
  }
  return scene;
}

describe("the grown-City block overhang (H1)", () => {
  it("covers every block point of the final append-grown City district (18x410 tiles)", () => {
    const view = OFFICE_VIEWS.city;
    const scene = growAppendedCity();
    const layout = scene.layout();
    if (layout === null) throw new Error("no layout");
    expect({ cols: layout.cols, rows: layout.rows }).toEqual({
      cols: 18,
      rows: 410,
    });
    const misses = sweepOverviewBlocks(scene, view, layout);
    // The symmetric-diamond overhang answers 634.2683906914502px on this
    // layout and still misses six of the nine-point sweep, the first at
    // (1007.7086485, 575.8543242) - inside the whole-map storey block. At
    // 18x410 the narrow (18-tile) dimension puts a real edge three times
    // closer to the block's own corner than a diamond assumes.
    expect(misses).toEqual([]);
  });

  it("keeps the whole-map storey block visible at a real 1280x700 canvas panned to zoom 0.5", () => {
    const view = OFFICE_VIEWS.city;
    const scene = growAppendedCity();
    const layout = scene.layout();
    if (layout === null) throw new Error("no layout");
    // A real 1280x700 CSS canvas at zoom 0.5 asks the scene for exactly this
    // 2560x1400 world rect when panned into the district's lower-right
    // corner.
    const camera: OfficeRect = {
      x: -1527.1336187827387,
      y: -796.5668093913694,
      width: 2560,
      height: 1400,
    };
    const point: OfficeRect = {
      x: 1022.8663812172613,
      y: 593.4331906086306,
      width: 1,
      height: 1,
    };
    const wanted = wholeMapBlocks(view, layout).findLast(
      (block) => block.fill === "storey" && rectsOverlap(block, point),
    );
    if (wanted === undefined) {
      throw new Error("no whole-map storey block at the expected point");
    }
    const actual = scene
      .frame(0, camera)
      .floor.filter(isBlockDrawable)
      .findLast((block) => rectsOverlap(block, point));
    // Today `scene.frame(0, camera).floor` returns zero floor drawables at
    // all - the same tight inverse-projection miss as the sweep above, made
    // directly visible at a real pan.
    expect(actual).toEqual(wanted);
  });

  it("still covers the same nine block points on fresh, near-square Campus and City triage(1000) layouts", () => {
    // Anti-regression: an overhang widened enough for the tall grown
    // district must not shrink back down for the ordinary square-ish case
    // the original corner sweep already covers - a fix that only special-
    // cases the tall shape would pass the case above and fail this one.
    const misses: OverviewMiss[] = [];
    for (const view of VIEWS) {
      const epic = makeTestEpic("triage", 1000, 1);
      const scene = new OfficeScene(view, null);
      scene.sync(sceneInputFor(epic.agents, epic.statusById, null));
      const layout = scene.layout();
      if (layout === null) throw new Error("no layout");
      misses.push(...sweepOverviewBlocks(scene, view, layout));
    }
    expect(misses).toEqual([]);
  });
});

// ---- H2: the per-frame room-population memo ---------------------------- //

// `Reflect.get` is declared as returning `any`; read it through a narrower
// type so the trap hands back `unknown` rather than smuggling `any` out. Same
// shape as the counted-array proxy in `campus-plan.test.ts` / `city-plan.test.ts`.
const reflectGet: (
  target: object,
  key: string | symbol,
  receiver: unknown,
) => unknown = Reflect.get;

interface RoomReadCounter {
  reads: number;
}

/**
 * A transparent numeric-index counting Proxy over `layout.rooms`: the wrapped
 * array reads back the identical objects, in the identical order, and the
 * plan's own frozen index over it sees nothing different - only every INDEX
 * read (`for...of` reads indices through the iterator, so it counts too) is
 * tallied. A memo that never re-walks the room population reads zero here,
 * however large the roster or however many frames ask for it.
 */
function countedRooms<T>(
  items: ReadonlyArray<T>,
  counter: RoomReadCounter,
): ReadonlyArray<T> {
  return new Proxy(items, {
    get(target, prop, receiver): unknown {
      if (typeof prop === "string" && /^\d+$/.test(prop)) counter.reads += 1;
      return reflectGet(target, prop, receiver);
    },
  });
}

function withCountedRooms(
  view: OfficeView,
  counter: RoomReadCounter,
): OfficeView {
  return {
    ...view,
    plan: (planInput: OfficePlanInput): OfficeLayout => {
      const layout = view.plan(planInput);
      return { ...layout, rooms: countedRooms(layout.rooms, counter) };
    },
  };
}

/** 10 / 100 / 1,000 agents, the reviewer's own scale. */
const MANY_ROOTS_COUNTS: ReadonlyArray<number> = [10, 100, 1000];
/** The reviewer's measured room counts - identical for Campus and City, since both plan one room per lineage root/team. */
const MANY_ROOTS_ROOM_COUNTS: ReadonlyArray<number> = [6, 51, 501];

/** `many-roots(n, 1)`, with every odd-indexed agent made the child of the preceding root - turning a flat forest of loners into small real teams. */
function manyRootsAgents(count: number): {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
} {
  const epic = makeTestEpic("many-roots", count, 1);
  const agents = epic.agents.map((agent, index): OfficeAgentInput => ({
    ...agent,
    parentId: index % 2 === 1 ? epic.agents[index - 1].id : null,
    archived: false,
    archivedAt: null,
  }));
  const statusById = new Map<string, OfficeAgentStatus>(
    agents.map((agent) => [agent.id, "working"]),
  );
  return { agents, statusById };
}

interface RepeatedFrameRecord {
  readonly rooms: number;
  readonly reads: number;
  readonly frames: ReadonlyArray<ReadonlyArray<OfficeDrawable>>;
}

describe("the per-frame room-population memo (H2)", () => {
  for (const view of VIEWS) {
    it(`${view.id}: five repeated identical overview frames read no room entries at all`, () => {
      const records: RepeatedFrameRecord[] = [];
      for (const count of MANY_ROOTS_COUNTS) {
        const { agents, statusById } = manyRootsAgents(count);
        const counter: RoomReadCounter = { reads: 0 };
        const countedView = withCountedRooms(view, counter);
        const scene = new OfficeScene(countedView, null);
        scene.sync(sceneInputFor(agents, statusById, null));
        const layout = scene.layout();
        if (layout === null) throw new Error("no layout");
        const rect: OfficeRect = {
          x: -100_000,
          y: -100_000,
          width: 1280,
          height: 700,
        };
        // Warm the scene once - the first frame is never free, whatever the
        // fix - then reset the counter before the repeats the case is about.
        const warm = scene.frame(0, rect).floor;
        counter.reads = 0;
        const repeats: ReadonlyArray<OfficeDrawable>[] = [];
        for (let frame = 0; frame < 5; frame += 1) {
          repeats.push(scene.frame(0, rect).floor);
        }
        records.push({
          rooms: layout.rooms.length,
          reads: counter.reads,
          frames: [warm, ...repeats],
        });
      }
      expect(records.map((record) => record.rooms)).toEqual(
        MANY_ROOTS_ROOM_COUNTS,
      );
      // THE FIX: `isoBlockOverhang` walks every floor, amenity and room on
      // every overview frame, before `floorIn` ever gets to consult its
      // cache. Today this reads 30 / 255 / 2,505 room entries across the
      // five repeats - exactly five full walks of the 6 / 51 / 501-room
      // population, however unchanged the floor is between them.
      expect(records.map((record) => record.reads)).toEqual([0, 0, 0]);
      // A memo that returns a STALE or WRONG number is not a pass: the six
      // identical frames (the warm-up plus the five repeats) must still
      // agree on what they draw.
      for (const record of records) {
        const [warm, ...repeats] = record.frames;
        for (const repeat of repeats) expect(repeat).toEqual(warm);
      }
    });
  }
});
