import { focusAgentDisplayName } from "@/lib/home-focus/focus-row-labels";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusModel,
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
   * Loaded prompt ROWS pointing at this task - never the task's `needsYou`
   * boolean, which is also true when the host's indicator flags say a prompt is
   * pending but the feed has not paged that row in. A badge reading "2 need
   * you" has to be countable on the page it appears on, so it counts the rows
   * the Needs you section is actually showing.
   */
  readonly promptCount: number;
  readonly agents: ReadonlyArray<FocusTaskGroupAgent>;
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
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
 * MEMBERSHIP is the union of two sets that are not nested. `model.tasks` covers
 * epics with a running agent; `model.background` covers epics with warm chat
 * work, running agent or not. Tasks come first, in the model's own order (so
 * tasks wanting the user still lead), then the background-only epics in
 * `model.background` order. The union is what keeps the Tasks view honest:
 * there is no Background section under it to catch a job whose epic is not a
 * task row, so an intersection would drop that job silently - and on an idle
 * account whose only activity is a dev server, would leave the page blank.
 *
 * Prompts with no `epicId` group nowhere: they are real work that belongs to no
 * task this client can name, and the Needs you section above is where they are
 * actionable. Counting them under some task would be a guess, and hiding them
 * would lose them.
 */
export function selectTaskGroups(
  model: FocusModel,
): ReadonlyArray<FocusTaskGroup> {
  const promptCounts = new Map<string, number>();
  for (const prompt of model.prompts) {
    if (prompt.epicId === null) continue;
    promptCounts.set(prompt.epicId, (promptCounts.get(prompt.epicId) ?? 0) + 1);
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
  const taskEpicIds = new Set(model.tasks.map((task) => task.epicId));
  const groups = model.tasks.map((task): FocusTaskGroup => {
    const jobs = jobsByEpicId.get(task.epicId) ?? [];
    return {
      epicId: task.epicId,
      taskTitle: task.taskTitle,
      task,
      promptCount: promptCounts.get(task.epicId) ?? 0,
      agents: groupAgents(task.agents),
      jobs,
      backgroundVisible: jobs.length > 0,
    };
  });
  for (const [epicId, jobs] of jobsByEpicId) {
    if (taskEpicIds.has(epicId)) continue;
    groups.push({
      epicId,
      // Every row of one epic carries the same title, so the first is the
      // epic's - there is no task row here to read it from.
      taskTitle: jobs[0].taskTitle,
      task: null,
      promptCount: promptCounts.get(epicId) ?? 0,
      agents: [],
      jobs,
      backgroundVisible: true,
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
