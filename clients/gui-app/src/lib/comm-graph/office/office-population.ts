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
   *
   * THIS IS THE ACCENT SOURCE, and it outlives the roster. A team whose last
   * `team`-class member is gone stops appearing in `hosts[].teams`, and the
   * stranded solos it left behind still carry its id here. Read the colour
   * from this field; `teamOf(id)?.teamId` is not a substitute for it.
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
  /**
   * A CURRENT-ROSTER lookup: the team this agent belongs to while that team
   * still has one, and `null` otherwise.
   *
   * `null` therefore does NOT mean "no team". A stranded solo whose team has
   * lost its last `team`-class member keeps `members.get(id).teamId` and
   * answers `null` here, because no roster exists to return and an empty one
   * is never invented to carry an accent. Anything drawing a colour reads
   * `members.get(id).teamId`; this answers "is there a room, and who is in
   * it".
   */
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
 *
 * THE MAP THIS RETURNS IS WHAT THE HOSTS ARE BUILT FROM, so it has to be taken
 * from classes nothing will change again. Everything downstream leaves `hq`
 * alone: `adoptArrivals` writes only `team` or `solo`, and only onto an agent
 * it reached as somebody's child - which an arrival reading as HQ is not, being
 * a true root - while the cross-host pass only moves members out of teams. The
 * one pass that DOES unmake an HQ is the returning-lead reconciliation, and it
 * runs before this one for exactly that reason.
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
 * What an arrival becomes, given the SETTLED draft of the agent it was created
 * under.
 *
 * An `hq` parent keeps its own rule and is not handled here: a direct child of
 * HQ is where teams begin, so the drafting pass has already made it a solo or
 * a lead depending on whether it brought anybody, and there is nothing about
 * freezing that can change that reading.
 */
function adoptedUnder(parent: Draft): Draft {
  // WHAT IS INHERITED IS THE TEAM, NOT THE PARENT'S CLASS. A parent carrying a
  // team id is in that team whatever it reads as locally: a member sits in its
  // room, and a member STRANDED in another building is a solo over there that
  // still belongs to it. Both pass the same team down, and the cross-host pass
  // below decides which of the two the arrival turns out to be - by asking
  // where the arrival itself lives, which is the only thing that can answer it.
  // Reading the parent's class instead is what dropped a stranded parent's
  // accent and made its children look like they belonged to nobody.
  if (parent.teamId !== null) {
    return { agentClass: "team", teamId: parent.teamId };
  }
  // Under a solo that is in no team at all: a solo in no team at all. A frozen
  // solo is somebody the office has already seated on its own; it does not
  // acquire a room, and a lead by construction sits in the team it leads, so
  // no team is ever fabricated around an agent who is not in it.
  return { agentClass: "solo", teamId: null };
}

/**
 * ARRIVALS ARE CLASSIFIED AGAINST THE SETTLED OFFICE, not against the topology
 * as read fresh.
 *
 * Freezing is what makes this necessary. A known agent keeps the class it was
 * given, so the topology the drafting pass read and the office that actually
 * exists can disagree - and an arrival drafted against the first of those
 * lands somewhere the second has no room for. Appending a child to a frozen
 * solo is the plain case: fresh topology says its parent now leads a team, so
 * the child is drafted into a team whose lead is sitting in the solos.
 *
 * Only agents `previous` has never seen are touched, so this is not
 * reclassification: it is the first classification those agents get, taken
 * from the office as it stands rather than as it would have been.
 */
function adoptArrivals(
  lineage: Lineage,
  drafts: Map<string, Draft>,
  previous: OfficePopulation | null,
  alreadySettled: ReadonlySet<string>,
): void {
  if (previous === null) return;
  // Walk DOWN the lineage rather than along creation order, so a parent is
  // always settled before the children that read it - including the rare
  // child whose record is older than its own parent's.
  const pending: string[] = [];
  const walked = new Set<string>();
  for (const agent of lineage.ordered) {
    // The agents this pass cannot move, and therefore starts from: the known,
    // the arrivals with nobody above them HERE - a true root or an orphan,
    // whose fresh reading is the only one there is - and the returning leads
    // another rule has already placed. That last group matters: a lead that
    // has just rejoined its own waiting team must not then be adopted into
    // whatever team its own parent happens to have ended up in.
    const parentId = agent.parentId;
    const settled =
      previous.members.has(agent.id) ||
      alreadySettled.has(agent.id) ||
      parentId === null ||
      !lineage.byId.has(parentId);
    if (!settled) continue;
    pending.push(agent.id);
    walked.add(agent.id);
  }
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined) continue;
    const parent = drafts.get(currentId);
    for (const child of childrenOf(lineage, currentId)) {
      if (walked.has(child.id)) continue;
      walked.add(child.id);
      pending.push(child.id);
      const draft = drafts.get(child.id);
      if (draft === undefined || parent === undefined) continue;
      if (parent.agentClass === "hq") continue;
      const adopted = adoptedUnder(parent);
      draft.agentClass = adopted.agentClass;
      draft.teamId = adopted.teamId;
    }
  }
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
    const home = teamHomeHostOf(lineage, drafts, draft.teamId, previous);
    // A team whose building cannot be established at all - its lead gone and
    // nobody left actually sitting in it - is not a room anybody can be seated
    // in. The arrival sits where it really is and keeps the colour, which is
    // also exactly what happened to the stranded parent it inherited from.
    if (home.resolved && home.hostId === agent.hostId) continue;
    draft.agentClass = "solo";
  }
}

/** Whether this draft says its agent is a `team`-class member of that team. */
function isMemberOfTeam(draft: Draft | undefined, teamId: string): boolean {
  if (draft === undefined) return false;
  return draft.agentClass === "team" && draft.teamId === teamId;
}

/**
 * WHICH BUILDING A TEAM IS IN, asked of the drafts, before anything is sealed.
 *
 * The whole answer comes from MEMBERSHIP, never from the existence of an agent
 * with the right id. A lead who has come back as an orphan, or who the office
 * has since seated somewhere else, is an agent named `L` who is not in team L,
 * and taking its host as the team's is how a roster gets built around somebody
 * standing outside it - the fabricated-team bug, wearing a different hat.
 *
 * So, in order: the lead while the lead is actually IN the team; then the
 * surviving members, because a team whose lead is gone is not homeless - it is
 * still sitting wherever they are sitting; then what the previous partition
 * recorded for the team itself, which is the only thing left once the last
 * local member goes in the same breath as an arrival turns up.
 *
 * Only agents `previous` already knew count as surviving members. An arrival is
 * exactly the thing being placed by the caller, so letting arrivals vote here
 * would let one decide it is in the right building by showing up.
 *
 * `buildTeams` asks the same question of the sealed members once stranding has
 * run (`teamHostOf`), and the two agree by construction: stranding only moves
 * agents OUT of a team, never the team itself.
 */
function teamHomeHostOf(
  lineage: Lineage,
  drafts: ReadonlyMap<string, Draft>,
  teamId: string,
  previous: OfficePopulation | null,
): { readonly resolved: boolean; readonly hostId: string | null } {
  const lead = lineage.byId.get(teamId);
  if (lead !== undefined && isMemberOfTeam(drafts.get(teamId), teamId)) {
    return { resolved: true, hostId: lead.hostId };
  }
  return waitingTeamHomeOf(lineage, drafts, teamId, previous);
}

/**
 * WHERE A TEAM IS, ON EVIDENCE THAT DOES NOT COME FROM ITS LEAD.
 *
 * The two tiers under `teamHomeHostOf`'s first one, named apart because a
 * RETURNING lead has to ask this exact question and must not be allowed the
 * first one: "an agent called L is standing here" is what it is trying to find
 * out, not something it may assume, and a lead that read its own host back
 * would carry its whole team into whatever building it came back into.
 *
 * The surviving members first, because a team whose lead is gone is not
 * homeless - it is still sitting wherever they are sitting. Then the record the
 * last partition kept for the TEAM, which is all that is left once the final
 * local member leaves in the same step the lead comes back or an arrival turns
 * up. One question, one answer, for the returner and the arrival alike: they
 * are both being placed against the same team, and a team cannot be waiting in
 * one building for one of them and in another for the other.
 */
function waitingTeamHomeOf(
  lineage: Lineage,
  drafts: ReadonlyMap<string, Draft>,
  teamId: string,
  previous: OfficePopulation | null,
): { readonly resolved: boolean; readonly hostId: string | null } {
  const surviving = survivingMemberHostOf(lineage, drafts, teamId, previous);
  if (surviving.resolved) return surviving;
  return rememberedTeamHomeOf(previous, teamId);
}

/**
 * Where the people still in this team are sitting, if any of them are.
 *
 * Only agents `previous` already knew count. An arrival is exactly the thing
 * being placed by whoever is asking, so letting arrivals vote here would let
 * one decide it is in the right building by showing up - and would let a
 * returning lead carry its whole team across to wherever it came back.
 */
function survivingMemberHostOf(
  lineage: Lineage,
  drafts: ReadonlyMap<string, Draft>,
  teamId: string,
  previous: OfficePopulation | null,
): { readonly resolved: boolean; readonly hostId: string | null } {
  if (previous === null) return { resolved: false, hostId: null };
  for (const candidate of lineage.ordered) {
    if (!previous.members.has(candidate.id)) continue;
    if (!isMemberOfTeam(drafts.get(candidate.id), teamId)) continue;
    return { resolved: true, hostId: candidate.hostId };
  }
  return { resolved: false, hostId: null };
}

/**
 * A LEAD THAT COMES BACK REJOINS THE TEAM THAT WAITED FOR IT.
 *
 * An agent removed and then returned is an arrival - `previous` has never seen
 * it - so it is classified from scratch, and with its own parent long gone it
 * reads as an orphan solo. Meanwhile its people are still at their desks in a
 * team that is still named after it, because their classes are frozen. The two
 * halves are each following their own correct rule and together they produce a
 * team whose lead is standing outside it: the same broken shape three earlier
 * fixups closed, arrived at from a direction none of them covered.
 *
 * The WAITING TEAM is what makes this safe to do, and what says where to put
 * the returner: it establishes that the team is real and which building it is
 * in - so a lead that comes back into that building rejoins at the front of the
 * roster, and one that comes back into a different building is a solo over
 * there carrying its own team's colour, exactly as any other member would be.
 * With no team waiting there is nothing to rejoin, and the returning lead is
 * the solo its fresh classification already made it.
 *
 * WHAT THE RETURNER ITSELF READS AS PROVES NOTHING about where it belongs, and
 * that includes reading as HQ. An empty corner office is the ordinary state of
 * a host whose first-created root has just come back, so "fresh draft says HQ"
 * is a fact about the rest of the set, not evidence that this agent used to run
 * the place. A former lead whose people are still at their desks is a returning
 * LEAD however the fresh pass reads it, and skipping it here left exactly the
 * shape this pass exists to prevent - a present local lead outside its own
 * roster, with a corner office on top. A genuine returning HQ is unaffected
 * without needing a guard: HQ leads no team, so no team is ever waiting for it.
 *
 * This is why the pass runs BEFORE the HQs settle. Unmaking an HQ after the map
 * the hosts are built from has been captured would place the returner twice -
 * once in the corner office that map still names, once in the roster it just
 * rejoined.
 */
function reconcileReturningLeads(
  lineage: Lineage,
  drafts: Map<string, Draft>,
  previous: OfficePopulation | null,
): ReadonlySet<string> {
  const settled = new Set<string>();
  if (previous === null) return settled;
  for (const agent of lineage.ordered) {
    // Only a RETURNING agent: one `previous` knew is frozen, and one that has
    // always been here is already whatever it has always been.
    if (previous.members.has(agent.id)) continue;
    if (!drafts.has(agent.id)) continue;
    const home = waitingTeamHomeOf(lineage, drafts, agent.id, previous);
    if (!home.resolved) continue;
    drafts.set(agent.id, {
      agentClass: home.hostId === agent.hostId ? "team" : "solo",
      teamId: agent.id,
    });
    settled.add(agent.id);
  }
  return settled;
}

/**
 * The building the LAST partition put this team in.
 *
 * Reached when nobody here is in the team any more - the lead gone and the last
 * local member leaving in the same step an arrival turns up. The team's own
 * record outlives its roster, so the arrival joins the team where it has been
 * all along instead of being stranded from a room it is standing in.
 *
 * The TEAM's record is the only thing asked for, deliberately. Falling back to
 * "wherever the last partition had an agent by that name" is the same mistake
 * as reading the lead out of the current set: an agent named `L` that was a
 * solo back then is no more evidence of where team L lived than one that is a
 * solo now. A lead that WAS in its own team put the team in `hosts[].teams`,
 * so this loop already has the answer in that case.
 */
function rememberedTeamHomeOf(
  previous: OfficePopulation | null,
  teamId: string,
): { readonly resolved: boolean; readonly hostId: string | null } {
  if (previous === null) return { resolved: false, hostId: null };
  for (const host of previous.hosts) {
    for (const team of host.teams) {
      if (team.teamId !== teamId) continue;
      return { resolved: true, hostId: team.hostId };
    }
  }
  return { resolved: false, hostId: null };
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
  // FREEZING IS THE LAST WORD on a KNOWN agent. Nothing after this line may
  // re-read the topology to second-guess it: reclassification happens when
  // `previous` is null and at no other time, because a class change moves a
  // character to another part of the building. An ARRIVAL is a different
  // matter - it has no class to preserve yet - and the passes below finish
  // deciding one for it against the office these known agents make up.
  freezeAgainstPrevious(lineage, drafts, input.previous);
  // Before the offices are handed out, so that a lead coming back to a host
  // whose corner office happens to be empty is read as the returning lead it
  // is; and before the arrivals are adopted, so a returning lead's own arriving
  // children read the team it has just rejoined rather than the orphan
  // classification it briefly had.
  const rejoined = reconcileReturningLeads(lineage, drafts, input.previous);
  // The offices, taken from the classes as they now stand. Nothing past this
  // line makes or unmakes an HQ, so this map and the members agree.
  const hqs = settleHqs(lineage, drafts);
  // After the HQs settle, so an arrival reads a parent whose class nothing
  // further can change; before the cross-host pass, so an arrival that
  // inherits a team in another building is stranded like any other member.
  adoptArrivals(lineage, drafts, input.previous, rejoined);
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
      hostId: teamHostOf(teamId, members.get(ordered[0]), previous),
      memberAgentIds: ordered,
      live: ordered.some((id) => members.get(id)?.hot === true),
    });
  }
  return teams;
}

/**
 * Which building a team is in, asked of the sealed members.
 *
 * THE HEAD OF THE ROSTER ANSWERS, and it answers because it is IN the team:
 * it is the lead exactly when the lead is a member, and the earliest surviving
 * member when it is not. Asking the lead by id instead - "is there an agent
 * called L?" - is the mistake `teamHomeHostOf` was corrected for, and it lands
 * here too: a lead that comes back in ANOTHER building would drag its team
 * across to a host where none of its people sit.
 *
 * A roster only ever holds members on the team's own host, so whichever of
 * them is asked gives the same answer.
 */
function teamHostOf(
  teamId: string,
  rosterHead: OfficePopulationMember | undefined,
  previous: OfficePopulation | null,
): string | null {
  if (rosterHead !== undefined) return rosterHead.hostId;
  // Unreachable while rosters are non-empty, and kept honest rather than
  // asserted: what the last partition knew of the lead beats inventing one.
  const remembered = previous?.members.get(teamId);
  if (remembered !== undefined) return remembered.hostId;
  return null;
}
