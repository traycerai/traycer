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
import type { CommGraphAgentNode } from "@/lib/comm-graph/comm-graph-model";
import {
  makeTestEpic,
  type OfficeTestEpicShape,
} from "@/lib/comm-graph/office/office-test-epic";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";

export const OFFICE_BENCH_PARAM = "officeBench";
export const OFFICE_BENCH_SHAPE_PARAM = "officeBenchShape";

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

/** What one bench URL asked for. */
export interface OfficeBenchRequest {
  readonly shape: OfficeTestEpicShape;
  readonly agents: number;
}

function benchShapeOf(raw: string | null): OfficeTestEpicShape {
  const named = BENCH_SHAPES.find((shape) => shape === raw);
  // An unreadable shape is the shape every estimate is quoted at, not an
  // error page: this is an address bar, and the fallback is the common case.
  return named ?? "triage";
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
  return {
    shape: benchShapeOf(params.get(OFFICE_BENCH_SHAPE_PARAM)),
    agents: Math.min(rounded, OFFICE_BENCH_MAX_AGENTS),
  };
}

function benchKeyOf(request: OfficeBenchRequest): string {
  return `${request.shape}/${request.agents}`;
}

/** One bench, built once: the agents the tile draws and the statuses they wear. */
interface BuiltBench {
  readonly agents: ReadonlyArray<CommGraphAgentNode>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
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
let built: BuiltBench = { agents: [], statusById: new Map() };

/**
 * The bench a URL asks for, built or remembered. Its agents are in the SAME
 * node shape the epic's own chats and terminal agents become, so everything
 * downstream is on its ordinary path.
 */
export function officeBench(request: OfficeBenchRequest): BuiltBench {
  const key = benchKeyOf(request);
  if (builtKey === key) return built;
  const epic = makeTestEpic(request.shape, request.agents, OFFICE_BENCH_SEED);
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
    statusById: epic.statusById,
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
 */
export function officeBenchStatuses(): ReadonlyMap<
  string,
  OfficeAgentStatus
> | null {
  return requestedBench()?.statusById ?? null;
}
