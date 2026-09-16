/**
 * A thousand-agent office without a thousand-agent epic: the dev bench.
 *
 * The performance work is quoted at 309 and 1,000 agents, and the second of
 * those does not exist to open: nobody has a thousand-agent epic on disk, and
 * making one would mean a thousand real chats on a real host. So in DEV builds
 * the comm-graph tile takes its agent set from `?officeBench=<n>` instead of
 * from the epic, feeding `makeTestEpic` through the tile's ORDINARY input
 * path - the same projection, the same partition, the same scene - so what is
 * measured is the office as it ships and not a bench harness standing in for
 * it.
 *
 * ```
 * ?officeBench=1000                          triage, the shape every estimate is quoted at
 * ?officeBench=1000&officeBenchShape=many-roots   the review's 101 MiB case
 * ?officeBench=400&officeBenchShape=two-hosts&officeBenchScript=outbreak&officeBenchOutbreak=12
 *                                            twelve crash on one floor, then recover one by one
 * ?officeBench=400&officeBenchScript=waiting  more agents wait than the lounge seats
 * ```
 *
 * THE BENCH ALSO MOVES, because a still office is the wrong subject for a p95
 * frame time and a long-task profile. An agent reads as `working`, `awaiting`,
 * `attention` or `failure` through the activity store, the open requests in the
 * event feed and the notification indicators - none of which the tile owns, and
 * none of which a synthetic agent set has an entry in - so the canvas takes the
 * bench's statuses from `officeBenchStatuses` instead, the FIXTURE's own map:
 * about 9 % of the population hot, and the same 9 % on every run, because a
 * bench whose busy agents were a dice roll would not be a bench.
 *
 * WHAT IT STILL DOES NOT CARRY is the event feed: no envelopes fly, nobody is
 * summoned to reception and no desk collects an open request, since all three
 * are read off rows the bench has no source for. So the 309-agent staging epic
 * stays the real-data row of the acceptance pass, and the bench answers the
 * question it can answer honestly - what a thousand agents cost when a tenth of
 * them are animating and the rest are strolling.
 *
 * DEV ONLY, and gone from production rather than merely unreachable:
 * `officeBenchOverride` returns on `import.meta.env.DEV` before it touches
 * anything, which the production build folds to a constant `false` - after
 * which nothing reachable references `makeTestEpic` and the fixtures drop out
 * of the bundle with it.
 */
import { useEffect, useState } from "react";
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import { civicCapacityFor } from "@/lib/comm-graph/office/office-layout";
import {
  makeTestEpic,
  outbreakScript,
  waitingScript,
  type OfficeStatusScript,
  type OfficeTestEpic,
  type OfficeTestEpicShape,
} from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";

export const OFFICE_BENCH_PARAM = "officeBench";
export const OFFICE_BENCH_SHAPE_PARAM = "officeBenchShape";
export const OFFICE_BENCH_SCRIPT_PARAM = "officeBenchScript";
export const OFFICE_BENCH_OUTBREAK_PARAM = "officeBenchOutbreak";

/**
 * The seed the plan's every measured number is quoted at. Not a parameter:
 * a bench whose population changed between two runs would not be a bench.
 */
export const OFFICE_BENCH_SEED = 1;

/**
 * As many agents as the bench will build. Well past the thousand every budget
 * is stated at, and low enough that a typo in the address bar costs a dev a
 * moment rather than the window.
 */
export const OFFICE_BENCH_MAX_AGENTS = 5000;

const BENCH_SHAPES: ReadonlyArray<OfficeTestEpicShape> = [
  "triage",
  "one-team",
  "many-roots",
  "two-hosts",
];

/**
 * WHAT HAPPENS TO A BENCHED OFFICE, as opposed to what one is made of.
 *
 * The civic layer is driven by status TRANSITIONS - a bed is claimed on the
 * sync a crash arrives and released on the sync it clears - so a bench that
 * only ever carried one frozen map could show a ward with people in it and
 * never show anybody being taken there. These are the same two sequences the
 * scene suite drives (`outbreakScript`, `waitingScript`), applied on top of
 * whichever population the URL asked for, so a live sitting judges the rows
 * the suites already pin rather than something adjacent to them.
 */
const BENCH_SCRIPTS = ["outbreak", "waiting"] as const;

export type OfficeBenchScript = (typeof BENCH_SCRIPTS)[number];

/**
 * How many agents `outbreak` crashes when the URL does not say.
 *
 * TWO, because that is the ambulance row. K3's dispatch rule sends an ENGINE
 * rather than a van once three or more agents enter `failure` on the same sync
 * with the ward's count at three or above, so a default of three would hand a
 * bare `&officeBenchScript=outbreak` the wrong vehicle for the row it exists to
 * drive. Two crashers, two beds, one coalesced van, the counter reading
 * `2 of n`. It was 3 until the resting map stopped arriving full of crashes,
 * at which point the count started meaning what it says.
 */
export const OFFICE_BENCH_OUTBREAK_DEFAULT = 2;

/**
 * HOW MANY MORE AGENTS WAIT THAN THE LOUNGE CAN SEAT.
 *
 * `waiting` exists to show the overflow keeping its desk glyph (C2) and the
 * freed chair going to the earliest waiter (C3), and neither is visible unless
 * the lounge is genuinely short. Taken from `civicCapacityFor` rather than
 * written down, so it stays an overflow when the live sitting moves the
 * capacity numbers.
 */
const OFFICE_BENCH_WAITING_OVERFLOW = 2;

/**
 * HOW LONG THE BENCH HOLDS ONE STEP OF A SCRIPT.
 *
 * Long enough to watch a step land: a civic walk crosses a large storey in a
 * few seconds, and a vehicle's trip is its drive in, a kerb wait of at least
 * four seconds (`Vehicles → Dispatch`) and its drive out. Eight seconds leaves
 * the slowest of those finished before the next step moves the statuses under
 * it, which is what makes a step a thing a person can actually see happen.
 */
export const OFFICE_BENCH_SCRIPT_STEP_MS = 8_000;

/** What one bench URL asked for. */
export interface OfficeBenchRequest {
  readonly shape: OfficeTestEpicShape;
  readonly agents: number;
  /**
   * The sequence to play on top of the population, or `null` for a still
   * office.
   */
  readonly script: OfficeBenchScript | null;
  /** How many agents `outbreak` crashes; ignored by every other script. */
  readonly outbreak: number;
}

function benchShapeOf(raw: string | null): OfficeTestEpicShape {
  const named = BENCH_SHAPES.find((shape) => shape === raw);
  // An unreadable shape is the shape every estimate is quoted at, not an
  // error page: this is an address bar, and the fallback is the common case.
  return named ?? "triage";
}

/**
 * The script a URL names, or `null` for one that names none OR names one that
 * does not exist.
 *
 * A typo is IGNORED rather than defaulted, which is the opposite of the shape
 * above and deliberately so: the default shape is a real bench somebody wanted
 * either way, while defaulting an unknown script would put an outbreak on a
 * floor a dev asked to leave still.
 */
function benchScriptOf(raw: string | null): OfficeBenchScript | null {
  return BENCH_SCRIPTS.find((script) => script === raw) ?? null;
}

/** How many crash in an `outbreak`: what the URL says, or the default. */
function benchOutbreakOf(raw: string | null, agents: number): number {
  const asked = Number((raw ?? "").trim());
  if (raw === null || raw.trim() === "" || !Number.isFinite(asked)) {
    return OFFICE_BENCH_OUTBREAK_DEFAULT;
  }
  const rounded = Math.floor(asked);
  if (rounded < 1) return OFFICE_BENCH_OUTBREAK_DEFAULT;
  // Nobody can crash who is not there. The script itself takes what one floor
  // can give, so this only keeps the number honest in the request.
  return Math.min(rounded, agents);
}

/**
 * The bench a query string asks for, or `null` for one that asks for none.
 *
 * Pure, and exported for its own sake: what a URL means is the half of this
 * that can be wrong, and it is the half that needs no DOM to test.
 */
export function parseOfficeBenchSearch(
  search: string,
): OfficeBenchRequest | null {
  const params = new URLSearchParams(search);
  const raw = params.get(OFFICE_BENCH_PARAM);
  if (raw === null) return null;
  const agents = Number(raw.trim());
  if (!Number.isFinite(agents)) return null;
  const rounded = Math.floor(agents);
  if (rounded < 1) return null;
  const capped = Math.min(rounded, OFFICE_BENCH_MAX_AGENTS);
  return {
    shape: benchShapeOf(params.get(OFFICE_BENCH_SHAPE_PARAM)),
    agents: capped,
    script: benchScriptOf(params.get(OFFICE_BENCH_SCRIPT_PARAM)),
    outbreak: benchOutbreakOf(params.get(OFFICE_BENCH_OUTBREAK_PARAM), capped),
  };
}

function benchKeyOf(request: OfficeBenchRequest): string {
  const script = request.script ?? "still";
  return `${request.shape}/${request.agents}/${script}/${request.outbreak}`;
}

/** One bench, built once: the agents the tile draws and the statuses they wear. */
interface BuiltBench {
  readonly agents: ReadonlyArray<CommGraphAgentNode>;
  /**
   * The statuses the office OPENS in, which is `steps[0]` and not the
   * fixture's own roll.
   *
   * The two were the same map until the scripts started resting their civic
   * statuses, and the difference is not cosmetic: a scripted bench's fixture
   * roll says eighteen agents are already crashed while the office it draws
   * opens with none. Deriving this from `steps` rather than assigning the
   * fixture's map beside it means the two CANNOT drift - the shape this
   * module already guards for agents and statuses, applied to the statuses
   * and the script.
   */
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  /**
   * The statuses the office wears in turn, RESTING STATE FIRST.
   *
   * A one-entry list for a bench that asked for no script. The resting state
   * leads even when one did, and that is the load-bearing part: the scene
   * seeds its outgoing statuses without dispatching anything at build (see
   * `Vehicles → Rulings`), so an office that opened with three agents already
   * crashed has watched nobody crash - no ambulance, no walk, nothing to
   * judge. Stepping off the resting map is what makes the first step a
   * TRANSITION.
   */
  readonly steps: ReadonlyArray<ReadonlyMap<string, OfficeAgentStatus>>;
}

/**
 * The last bench built, kept for the life of the page.
 *
 * Building a thousand agents is real work, and the tile asks for them on every
 * render - and again on every remount, which a view switch is. One entry
 * rather than a map: a window benches one office at a time. The statuses are
 * held with the agents rather than beside them, so the two halves of a bench
 * can never come from different fixtures.
 */
let builtKey: string | null = null;
let built: BuiltBench = {
  agents: [],
  statusById: new Map(),
  steps: [new Map()],
};

/**
 * THE STATUSES THAT WANT A CIVIC ROOM, which a script's resting state must not
 * already be carrying.
 *
 * One per room: `failure` asks for a bed, `awaiting` for a lounge chair,
 * `attention` for a place in the help desk's queue.
 */
const CIVIC_WANTING_STATUSES: ReadonlySet<OfficeAgentStatus> = new Set([
  "failure",
  "awaiting",
  "attention",
]);

/**
 * The fixture's statuses with every civic-wanting one stood down to `idle`.
 *
 * WITHOUT THIS A SCRIPT HAS NOWHERE TO PUT ANYBODY. `makeTestEpic` cycles its
 * hot statuses over about a tenth of the population, so at `many-roots/1000`
 * some eighteen agents are already `failure` and eighteen already `awaiting`
 * before a script does anything - and a floor has eight beds and sixteen
 * chairs. Every seat is claimed at rest, the named crashers cannot walk to a
 * bed, the counter opens full, and `waiting`'s cleared chair can go to
 * somebody who was never in the queue. The sitting would then be judging a
 * room that was full when it arrived rather than the transition the row names.
 *
 * ON EVERY HOST, not just the one the script acts on: the rows are judged over
 * the whole view, and at `two-hosts/400` the second building is in frame in
 * Towers, in Building and in the Floor's stacked storeys. A ward already full
 * with its van already spent contradicts the picture even when the subject's
 * own building is clean.
 *
 * `working` and `background` are LEFT ALONE, and `archived` with them. None of
 * them wants a room, and they are what keeps the frame-cadence rows honest -
 * an office standing perfectly still is the wrong subject for a p95.
 */
function civicRestingStatuses(
  statusById: ReadonlyMap<string, OfficeAgentStatus>,
): ReadonlyMap<string, OfficeAgentStatus> {
  const rested = new Map<string, OfficeAgentStatus>();
  for (const [agentId, status] of statusById) {
    rested.set(agentId, CIVIC_WANTING_STATUSES.has(status) ? "idle" : status);
  }
  return rested;
}

/**
 * The sequence this request plays, resting state first.
 *
 * The scripts are the scene suite's own (`office-test-epic.ts`), so the live
 * office replays exactly what the cases pin. `waiting` takes its count from
 * the capacity formula rather than from the URL: the row it exists for is the
 * OVERFLOW, and a count a dev happened to type could silently be one the
 * lounge has chairs for.
 *
 * The scripts are built FROM the rested map rather than from the fixture's, so
 * a step adds only what the script says; building them from the hot map and
 * merely showing a clean frame first would put every claim back on step one.
 */
function benchSteps(
  request: OfficeBenchRequest,
  epic: OfficeTestEpic,
): ReadonlyArray<ReadonlyMap<string, OfficeAgentStatus>> {
  if (request.script === null) return [epic.statusById];
  const resting = civicRestingStatuses(epic.statusById);
  const rested: OfficeTestEpic = { ...epic, statusById: resting };
  const script: OfficeStatusScript =
    request.script === "outbreak"
      ? outbreakScript(rested, request.outbreak)
      : waitingScript(
          rested,
          civicCapacityFor(request.agents).chairs +
            OFFICE_BENCH_WAITING_OVERFLOW,
        );
  return [resting, ...script];
}

/**
 * The bench a URL asks for, built or remembered. Its agents are in the SAME
 * node shape the epic's own chats and terminal agents become, so everything
 * downstream is on its ordinary path.
 */
export function officeBench(request: OfficeBenchRequest): BuiltBench {
  const key = benchKeyOf(request);
  if (builtKey === key) return built;
  const epic = makeTestEpic(request.shape, request.agents, OFFICE_BENCH_SEED);
  // `benchSteps` never returns an empty list - a scriptless bench is its one
  // resting map - so the opening map below is always a real entry.
  const steps = benchSteps(request, epic);
  built = {
    agents: epic.agents.map<CommGraphAgentNode>((agent) => ({
      id: agent.id,
      kind: agent.kind,
      name: agent.name,
      hostId: agent.hostId,
      parentId: agent.parentId,
      harnessId: agent.harnessId,
      model: agent.model,
      archived: agent.archived,
      archivedAt: agent.archivedAt,
      createdAt: agent.createdAt,
    })),
    statusById: steps[0],
    steps,
  };
  builtKey = key;
  return built;
}

/**
 * What this window's address bar asks for, or `null` in every build and every
 * URL that asks for nothing.
 *
 * Read from `window.location` rather than the router's search: the bench is a
 * dev instrument, and putting it in the route's validated search would add a
 * parameter to the typed contract of a screen that ships. The DEV gate is the
 * FIRST line of both readers below, which is what makes the fixtures fall out
 * of a production bundle rather than merely sitting there unreachable.
 */
function requestedBench(): BuiltBench | null {
  if (!import.meta.env.DEV) return null;
  const request = parseOfficeBenchSearch(window.location.search);
  if (request === null) return null;
  return officeBench(request);
}

/** The agents the tile draws instead of the epic's, or `null` for no bench. */
export function officeBenchOverride(): ReadonlyArray<CommGraphAgentNode> | null {
  return requestedBench()?.agents ?? null;
}

/**
 * The statuses the canvas dresses a bench office in instead of deriving them,
 * or `null` for no bench.
 *
 * The FIXTURE's map, not a fresh roll: the same tenth of the population is hot
 * on every run at a given seed and size, so two profiles of the same bench are
 * comparable and a regression is the code's rather than the dice's.
 *
 * `step` is where the script has got to, and it is CLAMPED rather than wrapped:
 * a script is a sequence with an end, and an office that looped back to the
 * resting map would heal everybody the moment the last one recovered. A bench
 * with no script has one step and reads the same map at every number.
 */
export function officeBenchStatuses(
  step: number,
): ReadonlyMap<string, OfficeAgentStatus> | null {
  const bench = requestedBench();
  if (bench === null) return null;
  // `steps` is never empty - a scriptless bench is its one resting map - so
  // the clamp always lands on a real entry.
  const last = bench.steps.length - 1;
  return bench.steps[Math.max(0, Math.min(step, last))];
}

/** How many status maps this window's bench walks; 0 where there is no bench. */
function benchStepCount(): number {
  return requestedBench()?.steps.length ?? 0;
}

/**
 * WHERE THE BENCH'S SCRIPT HAS GOT TO, advanced on a timer.
 *
 * The canvas takes its bench statuses from a RENDER, and nothing re-renders a
 * synthetic office on its own - it has no host, no feed and no store behind
 * it - so a script would otherwise sit on its first map forever. This is the
 * one piece of the bench that has to be a hook: the step is React state
 * precisely so that moving it re-renders the tile, which re-derives the
 * statuses, which syncs the scene with a TRANSITION in it.
 *
 * A self-rescheduling timeout rather than an interval, so it stops of its own
 * accord at the last step instead of waking a settled office every few seconds
 * for the rest of the session. `benchStepCount` is 0 in production and on any
 * URL that asks for no bench, so the effect returns before it schedules
 * anything.
 */
export function useOfficeBenchScriptStep(): number {
  const [step, setStep] = useState(0);
  const total = benchStepCount();
  const last = Math.max(total - 1, 0);
  const current = Math.min(step, last);
  useEffect(() => {
    if (current >= last) return;
    const timer = window.setTimeout(() => {
      setStep(current + 1);
    }, OFFICE_BENCH_SCRIPT_STEP_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [current, last]);
  return current;
}
