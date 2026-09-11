/**
 * WHO BELONGS TO WHOM, decided once for the whole office.
 *
 * Every view's plan, every team board and every directory row reads this one
 * answer. They have to: a floor that seats an agent in a team's room while the
 * board beside it counts that agent as a solo is not two opinions, it is a bug
 * with two symptoms.
 *
 * The shape is deliberately small - HQ, teams, solos, per host - because it is
 * the ONLY thing six different geometries can agree on. A tower storey, a
 * quiet stack row, a console tier and a city block are all just "a team" seen
 * from somewhere.
 *
 * Read literally, "a root's subtree is a team" makes a 309-agent epic with one
 * creator into ONE team, which leaves the Building view with an empty quiet
 * stack and the boards with nothing to say. So the split is one level finer: a
 * root's direct children are where teams begin, and its direct leaves - the
 * overwhelming majority in a triage-shaped epic - are solos.
 *
 * CLASSIFICATION IS FROZEN. An agent's class is decided the first time it is
 * seen and kept from then on, because a class change moves a character to
 * another part of the building. A status flip changes boards and lights; it
 * must never move anybody's desk.
 */
import { compareByCreation } from "@/lib/comm-graph/office/office-layout";
import { isOfficeHotStatus } from "@/lib/comm-graph/office/office-status";
import type {
  OfficeAgentInput,
  OfficeAgentStatus,
} from "@/lib/comm-graph/office/office-types";

/**
 * Where an agent sits in the office's social order.
 *
 * - `hq` - the host's first-created root; it occupies HQ and leads no team.
 * - `team` - a member of exactly one team, the lead included.
 * - `solo` - everybody else: direct leaves, childless later roots, orphans,
 *   and members whose lead lives on another host.
 */
export type OfficeAgentClass = "hq" | "team" | "solo";

export interface OfficePopulationMember {
  readonly agentId: string;
  readonly hostId: string | null;
  readonly agentClass: OfficeAgentClass;
  /**
   * The team this agent is IN, for a `team` member. For a `solo` it is the
   * team whose accent it carries - a member stranded on another host keeps its
   * team's colour so the two read as one team across two buildings - and
   * `null` for a solo that belongs to no team at all.
   */
  readonly teamId: string | null;
  /** Hot AS OF this partition: recomputed every time, never frozen. */
  readonly hot: boolean;
  /**
   * Whether the agent was hot the first time it was classified. Frozen with
   * the class, because a plan that seats an arrival by its status must not
   * re-seat it the moment that status changes.
   */
  readonly hotAtArrival: boolean;
}

export interface OfficeTeam {
  /** The lead's agent id; a team is named by whoever leads it. */
  readonly teamId: string;
  readonly leadAgentId: string;
  readonly hostId: string | null;
  /**
   * The lead first, then the rest in creation order. Only members on the
   * team's OWN host: one that lives elsewhere is a solo over there, and a room
   * cannot seat somebody who is in another building.
   */
  readonly memberAgentIds: ReadonlyArray<string>;
  /** Any member hot. A live team gets a room; a cold one goes to the stack. */
  readonly live: boolean;
}

export interface OfficeHostPopulation {
  /** `null` is the "Unattributed" group: records that predate host binding. */
  readonly hostId: string | null;
  readonly hqAgentId: string | null;
  readonly teams: ReadonlyArray<OfficeTeam>;
  readonly solos: ReadonlyArray<OfficePopulationMember>;
}

export interface OfficePopulation {
  /** Host-id order with the hostless group last, exactly as floors stack. */
  readonly hosts: ReadonlyArray<OfficeHostPopulation>;
  readonly members: ReadonlyMap<string, OfficePopulationMember>;
  /** `null` for an id this partition has never seen. */
  classOf(agentId: string): OfficeAgentClass | null;
  /** The team an agent is in, or the one whose accent a stranded solo carries. */
  teamOf(agentId: string): OfficeTeam | null;
}

export interface OfficePopulationInput {
  /** EVERY agent in the epic, as the plan sees them. */
  readonly agents: ReadonlyArray<OfficeAgentInput>;
  readonly statusById: ReadonlyMap<string, OfficeAgentStatus>;
  /** The last partition, whose classes are kept for the agents it knew. */
  readonly previous: OfficePopulation | null;
}

/** The lineage, canonically ordered, with the roots picked out. */
interface Lineage {
  readonly byId: ReadonlyMap<string, OfficeAgentInput>;
  readonly ordered: ReadonlyArray<OfficeAgentInput>;
  readonly childrenByParent: ReadonlyMap<
    string,
    ReadonlyArray<OfficeAgentInput>
  >;
  /**
   * Agents with no parent AT ALL. Only these compete for HQ and for team
   * leadership: being unreachable is not the same as being in charge.
   */
  readonly trueRoots: ReadonlyArray<OfficeAgentInput>;
  /**
   * Agents whose parent is named but absent from the set (or is themselves).
   * They have nobody above them HERE, but that is a gap in what we can see,
   * not evidence of seniority - so they are solos, and so is everyone under
   * them, rather than a corner office built out of a missing record.
   */
  readonly orphans: ReadonlyArray<OfficeAgentInput>;
}

/** A class and a team, before freezing and before the cross-host pass. */
interface Draft {
  agentClass: OfficeAgentClass;
  teamId: string | null;
}

/**
 * The lineage, with the two ways of having nobody above you kept APART.
 *
 * The floor plan folds them together - both open a cabin, because both need a
 * room - but the partition must not: "the first-created root is HQ" is a claim
 * about who started this epic, and an agent whose creator merely is not in the
 * set has told us nothing of the kind. Treating the two alike hands the corner
 * office to whichever record happens to be missing a parent.
 */
function buildLineage(agents: ReadonlyArray<OfficeAgentInput>): Lineage {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered = [...agents].sort(compareByCreation);
  const childrenByParent = new Map<string, OfficeAgentInput[]>();
  const trueRoots: OfficeAgentInput[] = [];
  const orphans: OfficeAgentInput[] = [];
  for (const agent of ordered) {
    const parentId = agent.parentId;
    if (parentId === null) {
      trueRoots.push(agent);
      continue;
    }
    if (parentId === agent.id || !byId.has(parentId)) {
      orphans.push(agent);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) childrenByParent.set(parentId, [agent]);
    else siblings.push(agent);
  }
  return { byId, ordered, childrenByParent, trueRoots, orphans };
}

function childrenOf(
  lineage: Lineage,
  agentId: string,
): ReadonlyArray<OfficeAgentInput> {
  return lineage.childrenByParent.get(agentId) ?? [];
}

/**
 * One HQ per host: the first-created TRUE root that lives there. A host whose
 * agents are all somebody else's children has none, and says so - inventing an
 * HQ out of a middle manager would put a room's lead in the corner office.
 *
 * A host that already had an HQ keeps that agent. The office does not change
 * hands because an older record showed up late: the incumbent stays, and the
 * newcomer is classified as the arrival it is - a team lead if it brought
 * people, a solo if it did not.
 */
function hqIdsByHost(
  lineage: Lineage,
  knownByHostKey: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  // The incumbent is PINNED rather than the host being skipped: the office is
  // still that agent's, so its subtree is still drafted the way an HQ's
  // subtree is drafted. Skipping the host instead would drop the incumbent
  // into the "later root" branch and fold its whole epic into one team.
  const hqs = new Map<string, string>(knownByHostKey);
  for (const root of lineage.trueRoots) {
    const key = hostKey(root.hostId);
    if (hqs.has(key)) continue;
    hqs.set(key, root.id);
  }
  return hqs;
}

/**
 * A group key. `null` is a group of its own and needs a key no host id can
 * collide with: every named host's key is prefixed, so the bare word cannot be
 * produced by any host id at all.
 */
function hostKey(hostId: string | null): string {
  return hostId === null ? "unattributed" : `h:${hostId}`;
}

/**
 * Everyone under `rootId`, that agent included, given one draft.
 *
 * A team lead folds its whole subtree into its team; an orphan folds its whole
 * subtree into solos, because nobody under an agent we cannot place is any
 * more placeable than the agent itself.
 */
function foldSubtree(
  lineage: Lineage,
  rootId: string,
  drafts: Map<string, Draft>,
  draftOf: (agentId: string) => Draft,
): void {
  const pending: string[] = [rootId];
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined) continue;
    // A reparenting cycle names a child that is already somebody's; it keeps
    // the first team it was folded into rather than being claimed twice.
    if (drafts.has(currentId)) continue;
    drafts.set(currentId, draftOf(currentId));
    for (const child of childrenOf(lineage, currentId)) pending.push(child.id);
  }
}

function foldSubtreeIntoTeam(
  lineage: Lineage,
  leadId: string,
  drafts: Map<string, Draft>,
): void {
  foldSubtree(lineage, leadId, drafts, () => ({
    agentClass: "team",
    teamId: leadId,
  }));
}

function foldSubtreeAsSolos(
  lineage: Lineage,
  rootId: string,
  drafts: Map<string, Draft>,
): void {
  foldSubtree(lineage, rootId, drafts, () => ({
    agentClass: "solo",
    teamId: null,
  }));
}

/**
 * The topology alone, before anything is frozen: HQ, the teams that hang off
 * it, the later roots that lead their own, and the solos left over.
 */
function draftClasses(
  lineage: Lineage,
  knownHqByHostKey: ReadonlyMap<string, string>,
): Map<string, Draft> {
  const drafts = new Map<string, Draft>();
  const hqs = hqIdsByHost(lineage, knownHqByHostKey);
  for (const root of lineage.trueRoots) {
    if (drafts.has(root.id)) continue;
    if (hqs.get(hostKey(root.hostId)) !== root.id) {
      // A second or later root is a team in its own right when it has anybody
      // to lead, and a solo when it does not.
      if (childrenOf(lineage, root.id).length === 0) {
        drafts.set(root.id, { agentClass: "solo", teamId: null });
        continue;
      }
      foldSubtreeIntoTeam(lineage, root.id, drafts);
      continue;
    }
    drafts.set(root.id, { agentClass: "hq", teamId: null });
    for (const child of childrenOf(lineage, root.id)) {
      if (drafts.has(child.id)) continue;
      if (childrenOf(lineage, child.id).length === 0) {
        drafts.set(child.id, { agentClass: "solo", teamId: null });
        continue;
      }
      foldSubtreeIntoTeam(lineage, child.id, drafts);
    }
  }
  // An orphan and everyone below it: solos. Run after the true roots so that a
  // subtree already claimed by a real team keeps that team.
  for (const orphan of lineage.orphans) {
    if (drafts.has(orphan.id)) continue;
    foldSubtreeAsSolos(lineage, orphan.id, drafts);
  }
  // A reparenting cycle has no root to be reached from. Its agents are solos
  // rather than absent: an odd reading of the org beats a missing desk.
  for (const agent of lineage.ordered) {
    if (drafts.has(agent.id)) continue;
    drafts.set(agent.id, { agentClass: "solo", teamId: null });
  }
  return drafts;
}

/**
 * What the previous partition said, where it said anything. Only the class,
 * the team and the arrival status carry over; hotness is always today's.
 */
function freezeAgainstPrevious(
  lineage: Lineage,
  drafts: Map<string, Draft>,
  previous: OfficePopulation | null,
): void {
  if (previous === null) return;
  for (const agent of lineage.ordered) {
    const known = previous.members.get(agent.id);
    if (known === undefined) continue;
    const draft = drafts.get(agent.id);
    if (draft === undefined) continue;
    draft.agentClass = known.agentClass;
    draft.teamId = known.teamId;
  }
}

/**
 * One HQ per host, taken from the settled classes.
 *
 * Nothing is demoted here. An arrival can no longer be classified HQ on a host
 * that already has one (`hqIdsByHost` reserves it), and a known agent keeps
 * whatever `previous` said - so the only way two agents on one host can both
 * read as HQ is an agent CHANGING hosts between partitions, which is a move
 * rather than a reclassification. The canonically first keeps the office and
 * the other is reported as a solo, so "exactly one of HQ, a team, or solos"
 * cannot break.
 */
function settleHqs(
  lineage: Lineage,
  drafts: Map<string, Draft>,
): ReadonlyMap<string, string> {
  const hqs = new Map<string, string>();
  for (const agent of lineage.ordered) {
    const draft = drafts.get(agent.id);
    if (draft === undefined || draft.agentClass !== "hq") continue;
    const key = hostKey(agent.hostId);
    if (!hqs.has(key)) {
      hqs.set(key, agent.id);
      continue;
    }
    draft.agentClass = "solo";
    draft.teamId = null;
  }
  return hqs;
}

/**
 * A member whose lead is in another building cannot sit in that lead's room,
 * so it becomes a solo where it actually lives - keeping the team id, which is
 * what the accent is drawn from.
 */
function strandCrossHostMembers(
  lineage: Lineage,
  drafts: Map<string, Draft>,
  previous: OfficePopulation | null,
): void {
  for (const agent of lineage.ordered) {
    // A known agent was already stranded (or not) when it was first placed,
    // and `previous` carries the answer. Re-running the rule on it would be
    // reclassification by another name.
    if (previous !== null && previous.members.has(agent.id)) continue;
    const draft = drafts.get(agent.id);
    if (draft === undefined || draft.agentClass !== "team") continue;
    if (draft.teamId === null) continue;
    const lead = lineage.byId.get(draft.teamId);
    if (lead === undefined || lead.hostId === agent.hostId) continue;
    draft.agentClass = "solo";
  }
}

interface HostGroup {
  readonly key: string;
  readonly hostId: string | null;
}

/** An agent's place in creation order; an absent id sorts last. */
function orderOf(lineage: Lineage, agentId: string): number {
  const at = lineage.ordered.findIndex((candidate) => candidate.id === agentId);
  return at < 0 ? lineage.ordered.length : at;
}

/** Host-id order with the hostless group last: exactly how storeys stack. */
function orderedHostKeys(lineage: Lineage): ReadonlyArray<HostGroup> {
  const named = new Set<string>();
  let hostless = false;
  for (const agent of lineage.ordered) {
    if (agent.hostId === null) hostless = true;
    else named.add(agent.hostId);
  }
  const groups: HostGroup[] = [];
  for (const hostId of Array.from(named).sort()) {
    groups.push({ key: hostKey(hostId), hostId });
  }
  if (hostless) groups.push({ key: hostKey(null), hostId: null });
  return groups;
}

/**
 * The agent each host's office already belongs to. A host whose HQ is still
 * here keeps it, so the fresh pass never offers the office to an arrival - not
 * even one created earlier than the incumbent.
 */
function incumbentHqsByHostKey(
  lineage: Lineage,
  input: OfficePopulationInput,
): ReadonlyMap<string, string> {
  const byHostKey = new Map<string, string>();
  for (const agent of lineage.ordered) {
    const known = input.previous?.members.get(agent.id);
    if (known === undefined || known.agentClass !== "hq") continue;
    const key = hostKey(agent.hostId);
    if (!byHostKey.has(key)) byHostKey.set(key, agent.id);
  }
  return byHostKey;
}

/**
 * The settled drafts as members, in creation order. `hot` is today's status;
 * `hotAtArrival` is the status the agent was FIRST seen with and never moves
 * again, which is what lets a plan keep a character where it started.
 */
function sealMembers(
  lineage: Lineage,
  drafts: ReadonlyMap<string, Draft>,
  input: OfficePopulationInput,
): ReadonlyMap<string, OfficePopulationMember> {
  const members = new Map<string, OfficePopulationMember>();
  for (const agent of lineage.ordered) {
    const draft = drafts.get(agent.id);
    if (draft === undefined) continue;
    const hot = isOfficeHotStatus(input.statusById.get(agent.id));
    const known = input.previous?.members.get(agent.id);
    members.set(agent.id, {
      agentId: agent.id,
      hostId: agent.hostId,
      agentClass: draft.agentClass,
      teamId: draft.teamId,
      hot,
      hotAtArrival: known === undefined ? hot : known.hotAtArrival,
    });
  }
  return members;
}

/**
 * HQ, teams and solos for every host, from the same agent set every plan is
 * given. Pure: the same input, including `previous`, is the same partition.
 */
export function partitionOfficePopulation(
  input: OfficePopulationInput,
): OfficePopulation {
  const lineage = buildLineage(input.agents);
  const fresh = draftClasses(lineage, incumbentHqsByHostKey(lineage, input));
  const drafts = new Map<string, Draft>();
  for (const [agentId, draft] of fresh) {
    drafts.set(agentId, { agentClass: draft.agentClass, teamId: draft.teamId });
  }
  // FREEZING IS THE LAST WORD on a known agent. Nothing after this line may
  // re-read the topology to second-guess it: reclassification happens when
  // `previous` is null and at no other time, because a class change moves a
  // character to another part of the building.
  freezeAgainstPrevious(lineage, drafts, input.previous);
  const hqs = settleHqs(lineage, drafts);
  strandCrossHostMembers(lineage, drafts, input.previous);

  const members = sealMembers(lineage, drafts, input);

  const teamsById = buildTeams(lineage, members, input.previous);
  const hosts: OfficeHostPopulation[] = [];
  for (const group of orderedHostKeys(lineage)) {
    const teams: OfficeTeam[] = [];
    const solos: OfficePopulationMember[] = [];
    for (const agent of lineage.ordered) {
      if (hostKey(agent.hostId) !== group.key) continue;
      const member = members.get(agent.id);
      if (member === undefined) continue;
      if (member.agentClass === "solo") solos.push(member);
    }
    // Teams are listed by whoever heads their roster, which is the lead while
    // there is one and the earliest surviving member once there is not - so a
    // team that lost its lead keeps its place rather than vanishing from the
    // host it is still sitting on.
    for (const team of teamsById.values()) {
      if (hostKey(team.hostId) !== group.key) continue;
      teams.push(team);
    }
    teams.sort(
      (left, right) =>
        orderOf(lineage, left.memberAgentIds[0]) -
        orderOf(lineage, right.memberAgentIds[0]),
    );
    hosts.push({
      hostId: group.hostId,
      hqAgentId: hqs.get(group.key) ?? null,
      teams,
      solos,
    });
  }

  return {
    hosts,
    members,
    classOf: (agentId) => members.get(agentId)?.agentClass ?? null,
    teamOf: (agentId) => {
      const teamId = members.get(agentId)?.teamId;
      if (teamId === undefined || teamId === null) return null;
      return teamsById.get(teamId) ?? null;
    },
  };
}

/**
 * One team per team id REFERENCED, its members in creation order with the lead
 * at the front where the lead is still here.
 *
 * Teams are built from what their members say, not from a roll-call of leads,
 * because a lead can be archived out of the set while its people are still at
 * their desks. That team is not dissolved and its members are not scattered:
 * it keeps its id, its accent and its room, and simply has nobody at the front
 * of it. Scattering them would move every one of those characters across the
 * building on the day their lead was deleted.
 */
function buildTeams(
  lineage: Lineage,
  members: ReadonlyMap<string, OfficePopulationMember>,
  previous: OfficePopulation | null,
): ReadonlyMap<string, OfficeTeam> {
  const rosters = new Map<string, string[]>();
  for (const agent of lineage.ordered) {
    const member = members.get(agent.id);
    if (member === undefined || member.agentClass !== "team") continue;
    if (member.teamId === null) continue;
    const roster = rosters.get(member.teamId);
    if (roster === undefined) rosters.set(member.teamId, [agent.id]);
    else roster.push(agent.id);
  }
  const teams = new Map<string, OfficeTeam>();
  for (const [teamId, roster] of rosters) {
    // The lead heads its own roster whatever creation order says: a room is
    // read from its lead down.
    const ordered = roster.includes(teamId)
      ? [teamId, ...roster.filter((id) => id !== teamId)]
      : roster;
    teams.set(teamId, {
      teamId,
      leadAgentId: teamId,
      // `ordered` is never empty: a roster exists only because a member put
      // an id in it, so the fallback member below is a real lookup.
      hostId: teamHostOf(lineage, teamId, members.get(ordered[0]), previous),
      memberAgentIds: ordered,
      live: ordered.some((id) => members.get(id)?.hot === true),
    });
  }
  return teams;
}

/**
 * Which building a team is in. The lead's host while the lead is here; the
 * host the PREVIOUS partition recorded for it once it is gone, so a team does
 * not appear to move buildings on the day its lead is archived; and the first
 * surviving member's host as the last resort.
 */
function teamHostOf(
  lineage: Lineage,
  teamId: string,
  firstMember: OfficePopulationMember | undefined,
  previous: OfficePopulation | null,
): string | null {
  const lead = lineage.byId.get(teamId);
  if (lead !== undefined) return lead.hostId;
  const remembered = previous?.members.get(teamId);
  if (remembered !== undefined) return remembered.hostId;
  return firstMember === undefined ? null : firstMember.hostId;
}
