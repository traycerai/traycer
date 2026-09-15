/**
 * Synthetic epics with STATED SHAPES, for the tests and the dev bench.
 *
 * A seed is not a definition. An epic generated entirely at random pins
 * nothing: the day a packing change halves the fit, a random fixture answers
 * "well, it depends what it generated". So each shape here is a topology
 * written out in words, with counts that follow from `n` alone, and the seed
 * decides only which agents happen to be busy and what their screens are.
 *
 * The shapes are the ones the real epics come in:
 *
 * - `triage` - one creator, a long tail of direct leaves, a few dozen small
 *   teams. The recording's epic, and the case every estimate is quoted at.
 * - `one-team` - everybody under one lead: the degenerate deep case.
 * - `many-roots` - `n` unrelated creators, which is the case that measured
 *   worst for memory because it is the most rooms.
 * - `two-hosts` - `triage` across two machines with one team straddling them,
 *   which is the only way to exercise a member whose lead is elsewhere.
 *
 * Lives beside the library rather than under `__tests__` because the dev bench
 * feeds it through the normal input path to stand up a thousand-agent office
 * in a real browser.
 */
import { agentAppearance } from "@/lib/comm-graph/office/office-appearance";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
  OfficeModelTier,
} from "@/lib/comm-graph/office/office-types";

export type OfficeTestEpicShape =
  | "triage"
  | "one-team"
  | "many-roots"
  | "two-hosts";

export interface OfficeTestEpic {
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
}

/** The recording's epic had thirty teams; more than that is a different shape. */
const TRIAGE_TEAM_CAP = 30;
/** One team per seven agents until the cap, so a small epic still has one. */
const TRIAGE_AGENTS_PER_TEAM = 7;
/** A team is two to four: the lead and one to three people under it. */
const TEAM_MAX_EXTRA_MEMBERS = 2;
/** Every fourth team puts its last member under the first, one level deeper. */
const NESTED_TEAM_EVERY = 4;
/** The rates the estimates are quoted at; the recording ran 24 hot of 309. */
const HOT_PERCENT = 9;
const ARCHIVED_PERCENT = 4;
/** Well past every `createdAt` below, so an archive is always after a birth. */
const ARCHIVED_AT_MS = 1_000_000;

const HOT_STATUS_CYCLE: ReadonlyArray<OfficeAgentStatus> = [
  "working",
  "awaiting",
  "attention",
  "failure",
  "background",
];

const MODEL_TIERS: ReadonlyArray<OfficeModelTier> = [
  "small",
  "medium",
  "large",
];

const HOST_A = "host-a";
const HOST_B = "host-b";

/** One agent's place in the lineage, before it is dressed as a real record. */
interface EpicNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly hostId: string | null;
}

/**
 * A 32-bit linear congruential generator: small, dependency-free and stable
 * across engines because every step stays inside `Math.imul`. Good enough to
 * spread choices about; deliberately not good enough to be mistaken for the
 * definition of a shape.
 */
class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }

  below(limit: number): number {
    if (limit <= 0) return 0;
    return this.next() % limit;
  }
}

/** One root, its teams, then the long tail of direct leaves under it. */
function triageNodes(count: number, rng: Rng): ReadonlyArray<EpicNode> {
  if (count <= 0) return [];
  const rootId = "agent-root";
  const nodes: EpicNode[] = [{ id: rootId, parentId: null, hostId: null }];
  const teams = Math.min(
    TRIAGE_TEAM_CAP,
    Math.floor((count - 1) / TRIAGE_AGENTS_PER_TEAM),
  );
  for (let team = 0; team < teams; team += 1) {
    const leadId = `team-${team}-lead`;
    nodes.push({ id: leadId, parentId: rootId, hostId: null });
    const members = 1 + rng.below(TEAM_MAX_EXTRA_MEMBERS + 1);
    const firstMemberId = `team-${team}-member-0`;
    for (let member = 0; member < members; member += 1) {
      // A few teams run one level deeper, so "deeper nesting folds into the
      // team" is exercised rather than assumed.
      const nested =
        member === members - 1 && members > 1 && team % NESTED_TEAM_EVERY === 0;
      nodes.push({
        id: `team-${team}-member-${member}`,
        parentId: nested ? firstMemberId : leadId,
        hostId: null,
      });
    }
  }
  for (let leaf = 0; nodes.length < count; leaf += 1) {
    nodes.push({ id: `leaf-${leaf}`, parentId: rootId, hostId: null });
  }
  return nodes;
}

/** The root, one lead under it, and everybody else under the lead. */
function oneTeamNodes(count: number): ReadonlyArray<EpicNode> {
  if (count <= 0) return [];
  const rootId = "agent-root";
  const nodes: EpicNode[] = [{ id: rootId, parentId: null, hostId: null }];
  if (count === 1) return nodes;
  const leadId = "team-lead";
  nodes.push({ id: leadId, parentId: rootId, hostId: null });
  for (let index = 0; nodes.length < count; index += 1) {
    nodes.push({ id: `member-${index}`, parentId: leadId, hostId: null });
  }
  return nodes;
}

/** `n` unrelated creators: the most cabins a floor of this size can have. */
function manyRootsNodes(count: number): ReadonlyArray<EpicNode> {
  const nodes: EpicNode[] = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({ id: `root-${index}`, parentId: null, hostId: null });
  }
  return nodes;
}

/**
 * `triage` dealt across two machines. Team 0 STRADDLES - its lead on one host,
 * its members on the other - which is the only case that produces a member
 * whose lead is in another building.
 */
function twoHostNodes(count: number, rng: Rng): ReadonlyArray<EpicNode> {
  let leafIndex = 0;
  return triageNodes(count, rng).map((node) => {
    if (node.parentId === null) return { ...node, hostId: HOST_A };
    if (node.id.startsWith("leaf-")) {
      const hostId = leafIndex % 2 === 0 ? HOST_A : HOST_B;
      leafIndex += 1;
      return { ...node, hostId };
    }
    const team = Number.parseInt(node.id.slice("team-".length), 10);
    if (team === 0) {
      return { ...node, hostId: node.id.endsWith("-lead") ? HOST_A : HOST_B };
    }
    return { ...node, hostId: team % 2 === 0 ? HOST_A : HOST_B };
  });
}

function nodesFor(
  shape: OfficeTestEpicShape,
  count: number,
  rng: Rng,
): ReadonlyArray<EpicNode> {
  if (shape === "one-team") return oneTeamNodes(count);
  if (shape === "many-roots") return manyRootsNodes(count);
  if (shape === "two-hosts") return twoHostNodes(count, rng);
  return triageNodes(count, rng);
}

interface SpecialAgents {
  /** Indices, as strings, of the agents that are busy. */
  readonly hot: ReadonlySet<string>;
  readonly archived: ReadonlySet<string>;
}

/**
 * Exactly `HOT_PERCENT` and `ARCHIVED_PERCENT` of the set, picked by a seeded
 * shuffle. Exact counts rather than a per-agent roll, so "9 % hot" is a fact
 * about the fixture and not an expectation about a coin.
 */
function pickSpecials(count: number, rng: Rng): SpecialAgents {
  const order: number[] = [];
  for (let index = 0; index < count; index += 1) order.push(index);
  for (let index = count - 1; index > 0; index -= 1) {
    const swap = rng.below(index + 1);
    const held = order[index];
    order[index] = order[swap];
    order[swap] = held;
  }
  const hotCount = Math.floor((count * HOT_PERCENT) / 100);
  const archivedCount = Math.floor((count * ARCHIVED_PERCENT) / 100);
  const hot = new Set<string>();
  const archived = new Set<string>();
  for (let index = 0; index < hotCount; index += 1) {
    hot.add(String(order[index]));
  }
  for (let index = 0; index < archivedCount; index += 1) {
    archived.add(String(order[hotCount + index]));
  }
  return { hot, archived };
}

/**
 * `n` agents in the named shape, with the statuses the estimates assume.
 *
 * Deterministic in `(shape, n, seed)`: the same three arguments give the same
 * agents in the same order with the same statuses, on any machine.
 */
export function makeTestEpic(
  shape: OfficeTestEpicShape,
  count: number,
  seed: number,
): OfficeTestEpic {
  const nodes = nodesFor(shape, Math.max(0, count), new Rng(seed));
  const specials = pickSpecials(nodes.length, new Rng(seed + 1));
  const agents: OfficeAgentInput[] = [];
  const statusById = new Map<string, OfficeAgentStatus>();
  let hotSeen = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const key = String(index);
    const hot = specials.hot.has(key);
    const archived = !hot && specials.archived.has(key);
    agents.push({
      id: node.id,
      name: node.id,
      kind: "chat",
      hostId: node.hostId,
      archivedAt: archived ? ARCHIVED_AT_MS : null,
      modelTier: MODEL_TIERS[index % MODEL_TIERS.length],
      harnessId: null,
      model: null,
      parentId: node.parentId,
      archived,
      // The index IS the creation order, so the canonical order the plan and
      // the partition both sort by is the order these come out in.
      createdAt: index,
      appearance: agentAppearance(node.id, "chat", null),
    });
    if (hot) {
      const cycle = hotSeen % HOT_STATUS_CYCLE.length;
      statusById.set(node.id, HOT_STATUS_CYCLE[cycle]);
      hotSeen += 1;
      continue;
    }
    statusById.set(node.id, archived ? "archived" : "idle");
  }
  return { agents, statusById };
}

/**
 * A STATUS SCRIPT: one `statusById` per sync, to be driven in order.
 *
 * The populations above are a topology and a resting state; a script is what
 * HAPPENS to one. They are separate because the civic layer's behaviour is a
 * function of status transitions - a bed is claimed on the sync a status
 * arrives and released on the sync it leaves - and a single frozen map cannot
 * express either end of that.
 */
export type OfficeStatusScript = ReadonlyArray<
  ReadonlyMap<string, OfficeAgentStatus>
>;

/**
 * The agents a script acts on: live, unarchived, and all on ONE floor.
 *
 * One floor because every civic rule is per-storey - a floor's beds are its
 * own, and an outbreak spread over three buildings would be three small
 * outbreaks that never fill anything. The first host with enough agents wins,
 * so the same call gives the same floor on any machine.
 */
function scriptSubjects(
  epic: OfficeTestEpic,
  count: number,
): ReadonlyArray<string> {
  const byHost = new Map<string, string[]>();
  for (const agent of epic.agents) {
    if (agent.archived) continue;
    const key = agent.hostId ?? "";
    const bucket = byHost.get(key);
    if (bucket === undefined) byHost.set(key, [agent.id]);
    else bucket.push(agent.id);
  }
  for (const bucket of byHost.values()) {
    if (bucket.length >= count) return bucket.slice(0, count);
  }
  // No single floor is big enough: take the biggest there is rather than
  // nothing, so a script is still a script on a two-agent epic.
  let best: ReadonlyArray<string> = [];
  for (const bucket of byHost.values()) {
    if (bucket.length > best.length) best = bucket;
  }
  return best.slice(0, count);
}

/** `base` with `ids` overridden to `status`. */
function withStatus(
  base: ReadonlyMap<string, OfficeAgentStatus>,
  ids: ReadonlyArray<string>,
  status: OfficeAgentStatus,
): ReadonlyMap<string, OfficeAgentStatus> {
  const next = new Map(base);
  for (const id of ids) next.set(id, status);
  return next;
}

/**
 * `count` agents on one floor crash in a SINGLE sync, then recover one at a
 * time.
 *
 * All at once on purpose: the interesting case is not one crash, it is
 * `count` claims resolved in one pass against a ward that may hold fewer -
 * which is what proves C2's cap and C3's arrival order. Recovering one at a
 * time is the other half: each freed bed must go to the earliest agent still
 * waiting for one, and a recovered agent must walk home.
 */
export function outbreakScript(
  epic: OfficeTestEpic,
  count: number,
): OfficeStatusScript {
  const subjects = scriptSubjects(epic, count);
  const steps = [withStatus(epic.statusById, subjects, "failure")];
  for (let healed = 1; healed <= subjects.length; healed += 1) {
    steps.push(
      withStatus(
        withStatus(epic.statusById, subjects.slice(healed), "failure"),
        subjects.slice(0, healed),
        "idle",
      ),
    );
  }
  return steps;
}

/**
 * More `awaiting` agents on one floor than its lounge holds, then one clears.
 *
 * `count` is the number that WAIT, and a caller picks it above
 * `civicCapacityFor(floorSize).chairs` so the overflow is real. The last step
 * frees exactly one chair, because "who gets the chair that just came free" is
 * the question C3 answers and two at once would not distinguish an ordered
 * queue from a lucky sort.
 */
export function waitingScript(
  epic: OfficeTestEpic,
  count: number,
): OfficeStatusScript {
  const subjects = scriptSubjects(epic, count);
  return [
    withStatus(epic.statusById, subjects, "awaiting"),
    withStatus(
      withStatus(epic.statusById, subjects.slice(1), "awaiting"),
      subjects.slice(0, 1),
      "idle",
    ),
  ];
}
