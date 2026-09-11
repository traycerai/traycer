import { browsersByEpicId } from "@/lib/home-focus/focus-browsers";
import { focusAgentDisplayName } from "@/lib/home-focus/focus-row-labels";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusBrowserRow,
  FocusModel,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";

/**
 * One agent inside a task group, plus the one thing the flat list cannot say on
 * its own: who started it.
 *
 * The Tasks view renders exactly two levels - task, then work row - so an agent
 * deeper than that is NOT indented further. It says `via <parent>` instead,
 * which keeps the row at the same depth as its siblings while still naming the
 * agent it hangs off. `via` is `null` for a work row directly under the task:
 * either it has no parent, or its parent is not itself running here, and in
 * both cases the task IS the thing it hangs off.
 */
export interface FocusTaskGroupAgent {
  readonly agent: FocusAgentRow;
  /** The parent agent's display name, or `null` when this row is a direct child
   * of the task. */
  readonly via: string | null;
}

/**
 * One browser tab as it is about to be RENDERED, and where it hangs.
 *
 * A tab an agent is DRIVING reads under that agent - `via <agent>` - rather
 * than at task level, because "what is this agent doing in the browser" is the
 * question someone expanding a task is asking, and a page listed beside the
 * agent working it answers a different one. `via` is `null` for a tab nothing
 * is driving, or one whose driver is not a VISIBLE row of this group: the task
 * IS what it hangs off then.
 *
 * Still two levels, exactly like the agent rows: the `via` label replaces a
 * third indent rather than adding one.
 *
 * Deliberately NOT a field on {@link FocusTaskGroup}. The label is a claim
 * about the rows beside it, and the agent set narrows TWICE after the group is
 * built - the mid-turn rule hides a background-tier agent whose work is
 * already a job row, and the host split keeps only one machine's agents. A
 * label computed before either left a tab saying `via Reviewer` under a list
 * with no Reviewer in it. Pairing it at the render site instead makes that
 * impossible rather than merely fixed: there is no earlier value to go stale.
 */
export interface FocusTaskGroupBrowser {
  readonly browser: FocusBrowserRow;
  readonly via: string | null;
}

/**
 * Pairs each tab with the driving agent, resolved against the agents the
 * caller is ACTUALLY GOING TO DRAW.
 *
 * Not against `FocusBrowserRow.drivenByAgentName`, which the model resolves for
 * any chat open in this window: that name is attribution and stays on the row's
 * status cell either way, while this label is navigation - it tells the reader
 * the row above is the one to look at. A `via` pointing at a row that is not
 * there is worse than none.
 *
 * A chat agent's id IS its chat id, which is what lets a `drivenByChatId` be
 * looked up in a map of agent ids at all.
 */
export function resolveBrowserVia(
  browsers: ReadonlyArray<FocusBrowserRow>,
  visibleAgents: ReadonlyArray<FocusTaskGroupAgent>,
): ReadonlyArray<FocusTaskGroupBrowser> {
  const byAgentId = new Map(
    visibleAgents.map((entry) => [entry.agent.agentId, entry.agent]),
  );
  return browsers.map((browser) => {
    const driver =
      browser.drivenByChatId === null
        ? undefined
        : byAgentId.get(browser.drivenByChatId);
    return {
      browser,
      via: driver === undefined ? null : focusAgentDisplayName(driver),
    };
  });
}

export interface FocusTaskGroup {
  readonly epicId: string;
  readonly taskTitle: string | null;
  /**
   * The model's task row, or `null` for an epic that reached this list through
   * its background jobs ALONE.
   *
   * `model.tasks` lists only epics with at least one running agent, while
   * `model.background` is built from warm chat sessions whether or not anything
   * is mid-turn - so a durable shell in an idle chat has an epic that is not a
   * task row. A `null` task is that case: the group has jobs, no agents, no
   * attention flags of its own, and nothing to stop.
   */
  readonly task: FocusTaskRow | null;
  /**
   * The loaded prompt ROWS pointing at this task - never the task's `needsYou`
   * boolean, which is also true when the host's indicator flags say a prompt is
   * pending but the feed has not paged that row in. A badge reading "2 need
   * you" has to be countable on the page it appears on, so it counts the rows
   * the Needs you section is actually showing.
   *
   * The rows rather than their count, because a group split across hosts files
   * each prompt under the machine it was RAISED on - a count could only be
   * repeated whole under both.
   */
  readonly prompts: ReadonlyArray<FocusPromptRow>;
  readonly agents: ReadonlyArray<FocusTaskGroupAgent>;
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
  /**
   * This task's browser tabs, AFTER the jobs in the body: agents first, then
   * the durable work, then the pages.
   *
   * Plain rows, not {@link FocusTaskGroupBrowser}: see that type for why the
   * `via` label cannot be attached until the agent set has stopped narrowing.
   */
  readonly browsers: ReadonlyArray<FocusBrowserRow>;
  /**
   * Whether this window can see this epic's background work at all, which is a
   * DIFFERENT question from `task.mountedHere`: that one asks whether the epic
   * has a live Y.Doc projection here, and jobs come from warm chat SESSIONS,
   * which is a narrower set. An epic open on its canvas with no chat clicked
   * into is mounted and contributes no jobs, and a "0 bg" badge read off
   * `mountedHere` would be claiming a task has nothing running when the truth
   * is that this window cannot tell.
   *
   * Equal to `jobs.length > 0` today, and not by accident:
   * `useWarmChatBackground` filters at READ time with the builder's own
   * `isRunningBackgroundRoot` predicate and drops any chat left with nothing,
   * so a chat that reaches the model always contributes a row. Named as its own
   * field anyway, because it is the question the badge is asking - if that read
   * filter ever loosens, this is the one place that has to change.
   */
  readonly backgroundVisible: boolean;
}

/**
 * The Tasks view's grouping: one group per epic that has work to show, each
 * joined to the prompts and background jobs that name it.
 *
 * MEMBERSHIP is the union of THREE sets that are not nested. `model.tasks`
 * covers epics with a running agent; `model.background` covers epics with warm
 * chat work, running agent or not; `model.browsers` covers epics with a live
 * browser, which needs neither. Tasks come first, in the model's own order (so
 * tasks wanting the user still lead), then the remaining epics in
 * `model.background` order, then those that reached the list on browsers alone.
 * The union is what keeps the Tasks view honest: there is no Background or
 * Browsers section under it to catch a row whose epic is not a task row, so an
 * intersection would drop that row silently - and on an idle account whose only
 * activity is a dev server, or a task left open at a page, would leave the page
 * blank.
 *
 * Prompts with no `epicId` group nowhere: they are real work that belongs to no
 * task this client can name, and the Needs you section above is where they are
 * actionable. Counting them under some task would be a guess, and hiding them
 * would lose them.
 */
export function selectTaskGroups(
  model: FocusModel,
): ReadonlyArray<FocusTaskGroup> {
  const promptsByEpicId = new Map<string, FocusPromptRow[]>();
  for (const prompt of model.prompts) {
    if (prompt.epicId === null) continue;
    const existing = promptsByEpicId.get(prompt.epicId);
    if (existing === undefined) {
      promptsByEpicId.set(prompt.epicId, [prompt]);
    } else {
      existing.push(prompt);
    }
  }
  const jobsByEpicId = new Map<string, FocusBackgroundRow[]>();
  for (const job of model.background) {
    const existing = jobsByEpicId.get(job.epicId);
    if (existing === undefined) {
      jobsByEpicId.set(job.epicId, [job]);
    } else {
      existing.push(job);
    }
  }
  const browsersByEpic = browsersByEpicId(model.browsers);
  const taskEpicIds = new Set(model.tasks.map((task) => task.epicId));
  const groups = model.tasks.map((task): FocusTaskGroup => {
    const jobs = jobsByEpicId.get(task.epicId) ?? [];
    return {
      epicId: task.epicId,
      taskTitle: task.taskTitle,
      task,
      prompts: promptsByEpicId.get(task.epicId) ?? [],
      agents: groupAgents(task.agents),
      jobs,
      browsers: browsersByEpic.get(task.epicId) ?? [],
      backgroundVisible: jobs.length > 0,
    };
  });
  const listed = new Set(taskEpicIds);
  for (const [epicId, jobs] of jobsByEpicId) {
    if (listed.has(epicId)) continue;
    listed.add(epicId);
    groups.push({
      epicId,
      // Every row of one epic carries the same title, so the first is the
      // epic's - there is no task row here to read it from.
      taskTitle: jobs[0].taskTitle,
      task: null,
      prompts: promptsByEpicId.get(epicId) ?? [],
      agents: [],
      jobs,
      browsers: browsersByEpic.get(epicId) ?? [],
      backgroundVisible: true,
    });
  }
  // The epics whose ONLY presence is a browser: a task open at a page with
  // nothing running and no warm chat. Last, because a page is the least active
  // thing a group can be here - and present at all, because the Tasks view has
  // no Browsers section to catch it.
  for (const [epicId, browsers] of browsersByEpic) {
    if (listed.has(epicId)) continue;
    listed.add(epicId);
    groups.push({
      epicId,
      taskTitle: browsers[0].taskTitle,
      task: null,
      prompts: promptsByEpicId.get(epicId) ?? [],
      agents: [],
      jobs: [],
      browsers,
      backgroundVisible: false,
    });
  }
  return groups;
}

/**
 * Attaches the `via` label, keeping the agents in the order the model already
 * sorted them into (turn tier first, then title, then id) rather than
 * re-ordering parents above children: the list is flat, so a parent that sorts
 * below its child still reads correctly - the child names it.
 */
function groupAgents(
  agents: ReadonlyArray<FocusAgentRow>,
): ReadonlyArray<FocusTaskGroupAgent> {
  const byAgentId = new Map(agents.map((agent) => [agent.agentId, agent]));
  return agents.map((agent) => {
    const parent =
      agent.parentId === null ? undefined : byAgentId.get(agent.parentId);
    return {
      agent,
      via: parent === undefined ? null : focusAgentDisplayName(parent),
    };
  });
}
