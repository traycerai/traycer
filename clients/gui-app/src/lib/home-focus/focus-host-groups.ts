import { compareAscending } from "@/lib/home-focus/focus-identity";
import { runningTasks } from "@/lib/home-focus/focus-running";
import type {
  FocusTaskGroup,
  FocusTaskGroupAgent,
} from "@/lib/home-focus/focus-task-groups";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusBrowserRow,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";

/**
 * Which machine each Home row belongs to, and how a section orders the machines
 * it finds.
 *
 * Pure, because the question "does this page span more than one host" has to be
 * answered identically by the sections, by the summary line's tooltips and by
 * the coverage notice - and because the interesting half of it is arithmetic on
 * ids rather than anything React does.
 *
 * A `null` host id is not another machine. It is a row whose host this client
 * could not name - a legacy chat predating the field, a session handle the
 * registry has not resolved - and every such row RESOLVES to the active host,
 * because the active host is where its stop would be sent. Doing that before
 * counting is what keeps a single-host install single-host: without it a stray
 * unresolved row would split the page into two groups that are the same
 * machine. With NO active host to resolve against it lands in
 * {@link UNKNOWN_HOST_ID} instead - never dropped, so a section's groups always
 * sum to its heading.
 */

/**
 * The bucket for a row whose machine nothing can name.
 *
 * Reachable only when this client has NO active host to resolve against - the
 * browser shell before a binding settles, or a directory that has not answered
 * - because otherwise the active host absorbs every unnamed row. It exists so
 * that a section's groups always sum to its total: dropping those rows made the
 * heading count and the rows under it disagree, silently, in exactly the
 * situation where the page knows least.
 *
 * A NUL prefix, which no real host id can carry, so the sentinel cannot collide
 * with a machine that is genuinely called this.
 */
export const UNKNOWN_HOST_ID = "\u0000unknown-host";

export function isUnknownHostId(hostId: string): boolean {
  return hostId === UNKNOWN_HOST_ID;
}

/**
 * The machine an AGENT row is filed under.
 *
 * Not `resolveFocusHostId` on its own, because an agent's `null` host has two
 * causes and only one of them means "the active host". A row nothing could
 * attribute goes to the unknown bucket instead: guessing it onto whichever
 * machine the user is sitting at is exactly the defect that has now appeared
 * twice, once through a task-level host and once through a cloud slice's key.
 */
export function focusAgentHostId(
  agent: FocusAgentRow,
  activeHostId: string | null,
): string {
  if (agent.hostUnattributed) return UNKNOWN_HOST_ID;
  return resolveFocusHostId(agent.hostId, activeHostId);
}

/** The active host is where a row with no host of its own is acted on, so it is
 * what an unnamed host resolves to - and {@link UNKNOWN_HOST_ID} when there is
 * no active host either. Never `null`: every row lands somewhere. */
export function resolveFocusHostId(
  hostId: string | null,
  activeHostId: string | null,
): string {
  return hostId ?? activeHostId ?? UNKNOWN_HOST_ID;
}

/**
 * One task as ONE host sees it: the same task row carrying only that host's
 * agents, and only the jobs running in that host's chats.
 *
 * An epic is cloud-homed and can be worked from several machines at once - the
 * model merges those slices into one task row holding every host's agents
 * (`use-focus-model`'s "one epic worked from two hosts"). So a task has no
 * single host to be filed under, and asking for one produced the defect this
 * replaced: agents that disagreed resolved to `null`, `null` resolved to the
 * ACTIVE host, and a task being worked from two remote machines was filed under
 * the machine the user happened to be sitting at.
 *
 * Grouping is therefore by the ROW's own host, never by the task's. A task
 * spanning two hosts appears once under each, and each appearance answers for
 * its own share: its own agents, its own jobs, its own counts, and a `Stop all`
 * that reaches its own roots only.
 *
 * `stoppable` is re-folded from the agents that remain, which is why
 * `FocusAgentRow` carries its own: the parent's flag is `every` over ALL
 * agents, so a reachable host's row would inherit an unreachable sibling's
 * refusal and disable a stop that would have worked.
 */
export interface FocusTaskHostSlice {
  readonly hostId: string;
  readonly task: FocusTaskRow;
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
  /** Whether this task is drawn under more than one host, which is what makes
   * `Stop all` name the machine it is about. */
  readonly splitAcrossHosts: boolean;
}

export function splitTaskByHost(
  task: FocusTaskRow,
  jobs: ReadonlyArray<FocusBackgroundRow>,
  options: {
    /** `false` on a single-host page, where the whole point is that nothing
     * changes: one slice carrying the task exactly as the model built it. A
     * split there would re-key rows and re-fold `stoppable` for a distinction
     * the page is not drawing. */
    readonly enabled: boolean;
    readonly activeHostId: string | null;
  },
): ReadonlyArray<FocusTaskHostSlice> {
  const { activeHostId } = options;
  if (!options.enabled) {
    return [
      {
        hostId: resolveFocusHostId(null, activeHostId),
        task,
        jobs,
        splitAcrossHosts: false,
      },
    ];
  }
  const agentsByHost = new Map<string, FocusAgentRow[]>();
  for (const agent of task.agents) {
    const hostId = focusAgentHostId(agent, activeHostId);
    const existing = agentsByHost.get(hostId);
    if (existing === undefined) {
      agentsByHost.set(hostId, [agent]);
    } else {
      existing.push(agent);
    }
  }
  const jobsByHost = new Map<string, FocusBackgroundRow[]>();
  for (const job of jobs) {
    const hostId = resolveFocusHostId(job.hostId, activeHostId);
    const existing = jobsByHost.get(hostId);
    if (existing === undefined) {
      jobsByHost.set(hostId, [job]);
    } else {
      existing.push(job);
    }
  }
  const hostIds = new Set([...agentsByHost.keys(), ...jobsByHost.keys()]);
  const splitAcrossHosts = hostIds.size > 1;
  return Array.from(hostIds).map((hostId) => {
    const agents = agentsByHost.get(hostId) ?? [];
    return {
      hostId,
      task: splitAcrossHosts
        ? { ...task, agents, stoppable: agents.every((a) => a.stoppable) }
        : task,
      jobs: jobsByHost.get(hostId) ?? [],
      splitAcrossHosts,
    };
  });
}

/**
 * The Tasks view's version of {@link splitTaskByHost}: one group per machine
 * the group's own rows name, each holding that machine's agents, jobs and
 * prompts.
 *
 * Prompts split by the host they were RAISED on rather than being repeated
 * whole, because a prompt is answered where it came from - and a "2 need you"
 * badge shown under both machines would be counting the same two rows twice.
 */
export interface FocusTaskGroupHostSlice {
  readonly hostId: string;
  readonly group: FocusTaskGroup;
  readonly splitAcrossHosts: boolean;
}

export function splitTaskGroupByHost(
  group: FocusTaskGroup,
  options: {
    readonly enabled: boolean;
    readonly activeHostId: string | null;
  },
): ReadonlyArray<FocusTaskGroupHostSlice> {
  const { activeHostId } = options;
  if (!options.enabled) {
    return [
      {
        hostId: resolveFocusHostId(null, activeHostId),
        group,
        splitAcrossHosts: false,
      },
    ];
  }
  const hostIds = new Set<string>();
  const agentsByHost = new Map<string, FocusTaskGroupAgent[]>();
  for (const entry of group.agents) {
    const hostId = focusAgentHostId(entry.agent, activeHostId);
    hostIds.add(hostId);
    const existing = agentsByHost.get(hostId);
    if (existing === undefined) agentsByHost.set(hostId, [entry]);
    else existing.push(entry);
  }
  const jobsByHost = new Map<string, FocusBackgroundRow[]>();
  for (const job of group.jobs) {
    const hostId = resolveFocusHostId(job.hostId, activeHostId);
    hostIds.add(hostId);
    const existing = jobsByHost.get(hostId);
    if (existing === undefined) jobsByHost.set(hostId, [job]);
    else existing.push(job);
  }
  // A browser session is host-local for life, so its tab is filed under the
  // machine the page is actually open on - and a task browsing from two
  // machines splits on that, like every other row.
  //
  // These are plain rows carrying no `via`: the label names a VISIBLE sibling,
  // and this split is one of the two places the sibling set narrows, so it is
  // resolved after both (`resolveBrowserVia`). A slice must never inherit a
  // label for an agent that stayed on the other machine.
  const browsersByHost = new Map<string, FocusBrowserRow[]>();
  for (const browser of group.browsers) {
    const hostId = browser.hostId;
    hostIds.add(hostId);
    const existing = browsersByHost.get(hostId);
    if (existing === undefined) browsersByHost.set(hostId, [browser]);
    else existing.push(browser);
  }
  const promptsByHost = new Map<string, FocusPromptRow[]>();
  for (const prompt of group.prompts) {
    const hostId = resolveFocusHostId(prompt.originHostId, activeHostId);
    // Prompts do NOT open a host group of their own: a task the reader can
    // only see a prompt for has no work to show under that machine, and the
    // prompt is already actionable in the Needs you section above.
    if (!hostIds.has(hostId)) continue;
    const existing = promptsByHost.get(hostId);
    if (existing === undefined) promptsByHost.set(hostId, [prompt]);
    else existing.push(prompt);
  }
  // A group with nothing in it at all still has to appear somewhere, or the
  // section's total stops matching its rows.
  if (hostIds.size === 0) {
    hostIds.add(resolveFocusHostId(null, activeHostId));
  }
  const splitAcrossHosts = hostIds.size > 1;
  return Array.from(hostIds).map((hostId) => {
    const agents = agentsByHost.get(hostId) ?? [];
    const jobs = jobsByHost.get(hostId) ?? [];
    const prompts = promptsByHost.get(hostId) ?? [];
    // Prompts are filtered even when the work sits on ONE host, because a
    // prompt raised on B is not this group's business just because B has no
    // agents here: the one group would otherwise carry a "1 need you" badge
    // for a machine it is not about. The task and its agents are only rebuilt
    // when the group genuinely splits - `Stop all` on an unsplit group still
    // cascades over every agent the model gave it.
    if (!splitAcrossHosts) {
      return {
        hostId,
        group:
          prompts.length === group.prompts.length
            ? group
            : { ...group, prompts },
        splitAcrossHosts,
      };
    }
    return {
      hostId,
      group: {
        ...group,
        agents,
        jobs,
        prompts,
        browsers: browsersByHost.get(hostId) ?? [],
        backgroundVisible: jobs.length > 0,
        task:
          group.task === null
            ? null
            : {
                ...group.task,
                agents: agents.map((entry) => entry.agent),
                stoppable: agents.every((entry) => entry.agent.stoppable),
              },
      },
      splitAcrossHosts,
    };
  });
}

/** A prompt is acted on where it was RAISED, which is what `originHostId`
 * names - not where this window happens to be pointing. */
export function focusPromptHostId(prompt: FocusPromptRow): string | null {
  return prompt.originHostId;
}

/**
 * Every host the page's rows name, resolved and de-duplicated.
 *
 * Counted across the WHOLE model rather than per section, because grouping is
 * one decision about one page: a Background section that spans two machines
 * while every prompt sits on one would otherwise show headings in one section
 * and not the next, and the reader would have to work out why.
 */
export function focusHostIds(
  model: FocusModel,
  activeHostId: string | null,
): ReadonlySet<string> {
  const hostIds = new Set(focusActivityHostIds(model, activeHostId));
  // A browser session is host-local for life and its inventory names the
  // machine, so these are never unresolved - and they count, because a page
  // open on a second machine is exactly the fleet fact the headings exist to
  // report.
  for (const row of model.browsers) {
    if (!isUnknownHostId(row.hostId)) hostIds.add(row.hostId);
  }
  return hostIds;
}

/**
 * The subset of {@link focusHostIds} whose rows come from the ACTIVITY plane -
 * prompts, agents and jobs.
 *
 * Separate because the coverage notice is about that plane and nothing else. A
 * host whose activity stream is degraded but whose only visible rows are
 * browser tabs has a heading on the page and still cannot carry the sentence:
 * "some activity may be missing" under a list of browser tabs would be
 * attributing the gap to the one section that does not have it, and would let
 * the page-wide banner stand down on the strength of a group that is not
 * saying anything. Browsers ride their own stream, so they are not evidence
 * either way.
 */
export function focusActivityHostIds(
  model: FocusModel,
  activeHostId: string | null,
): ReadonlySet<string> {
  const hostIds = new Set<string>();
  // The unknown bucket is not a NAMED machine, so it never turns grouping on
  // by itself: one unattributed row must not split a page whose named rows all
  // sit on one host. Once grouping IS on, those rows still get a group.
  const addResolved = (resolved: string): void => {
    if (!isUnknownHostId(resolved)) hostIds.add(resolved);
  };
  const add = (hostId: string | null): void => {
    addResolved(resolveFocusHostId(hostId, activeHostId));
  };
  for (const prompt of model.prompts) add(focusPromptHostId(prompt));
  // Each AGENT's own host, from the tasks the page actually draws - a task
  // hidden by the mid-turn rule must not be the reason headings appear that no
  // visible row explains, and a task worked from two machines names both.
  for (const task of runningTasks(
    model.tasks,
    new Set(model.background.map((row) => row.epicId)),
  )) {
    // Through the agent resolver, so an unattributed agent lands in the
    // unknown bucket - which `add` then declines to count as a named machine.
    for (const agent of task.agents) {
      addResolved(focusAgentHostId(agent, activeHostId));
    }
  }
  for (const row of model.background) add(row.hostId);
  return hostIds;
}

/**
 * Whether to draw host subheadings at all.
 *
 * One host means no headings and a page byte-identical to the ungrouped one -
 * which is the common install, and the reason this is a predicate rather than a
 * setting. Zero hosts is the same answer for a different reason: nothing is
 * named, so there is nothing to name.
 */
export function shouldGroupByHost(hostIds: ReadonlySet<string>): boolean {
  return hostIds.size > 1;
}

export interface FocusHostGroup<Row> {
  readonly hostId: string;
  readonly rows: ReadonlyArray<Row>;
}

/**
 * Groups a section's rows by machine, ACTIVE HOST FIRST, then the rest in the
 * registry's own order, then anything the registry does not list.
 *
 * The active host leads because it is the one the user is working on and the
 * one an unnamed row resolved to; the registry order follows because it is the
 * order the same hosts appear in everywhere else in the app, and inventing a
 * second ordering for this page would make two lists of the same machines
 * disagree. A host the registry has never heard of sorts last by id - stable,
 * and visibly not part of the known fleet.
 *
 * Row order WITHIN a group is the model's, untouched: the model already sorted
 * attention first, and grouping must not re-rank it.
 */
export function groupRowsByHost<Row>(
  rows: ReadonlyArray<Row>,
  hostIdOf: (row: Row) => string | null,
  options: {
    readonly activeHostId: string | null;
    readonly registryOrder: ReadonlyArray<string>;
  },
): ReadonlyArray<FocusHostGroup<Row>> {
  const byHostId = new Map<string, Row[]>();
  for (const row of rows) {
    const hostId = resolveFocusHostId(hostIdOf(row), options.activeHostId);
    const existing = byHostId.get(hostId);
    if (existing === undefined) {
      byHostId.set(hostId, [row]);
    } else {
      existing.push(row);
    }
  }
  const rank = focusHostRank(options);
  return Array.from(byHostId.entries())
    .map(([hostId, groupRows]) => ({ hostId, rows: groupRows }))
    .sort((a, b) => {
      const delta = rank(a.hostId) - rank(b.hostId);
      return delta === 0 ? compareAscending(a.hostId, b.hostId) : delta;
    });
}

/** Position of a host in the page's ordering. Lower sorts first. */
function focusHostRank(options: {
  readonly activeHostId: string | null;
  readonly registryOrder: ReadonlyArray<string>;
}): (hostId: string) => number {
  const registryRank = new Map(
    options.registryOrder.map((hostId, index) => [hostId, index + 1]),
  );
  const unlistedRank = options.registryOrder.length + 1;
  return (hostId) => {
    // Last, always: rows nothing could attribute are the least useful thing on
    // the page and must not come between two machines the reader knows.
    if (isUnknownHostId(hostId)) return unlistedRank + 1;
    if (hostId === options.activeHostId) return 0;
    return registryRank.get(hostId) ?? unlistedRank;
  };
}
