import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusModel,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";

/**
 * Which agents Home DRAWS, and which tasks the Running section lists.
 *
 * The defect this module exists to prevent: one piece of activity listed twice
 * under two names. A chat that is idle but hosts a running monitor is a
 * `background`-tier working agent AND the source of a Background row, so the
 * page said `Running · Greeting and Introduction · background` and
 * `Background · 10min heartbeat · running 5h` about the same monitor, in two
 * sections, in two vocabularies.
 *
 * The rule that resolves it: **Running is mid-turn agents only, wherever this
 * window can show the durable work instead.** Work that is merely durable
 * belongs in Background, where its own row names the job rather than the
 * conversation that happens to host it - but only where Background can in fact
 * name it. A task this window has no job row for keeps its agents and its
 * Running row, because de-duplicating against a row that does not exist is just
 * losing the work.
 *
 * Nothing here filters the MODEL. `FocusTaskRow.agents` stays complete, because
 * `Stop all` cascades over every agent a task has, background-tier included -
 * these are presentation predicates, and a stop that honoured them would leave
 * work running that the confirmation said it would end.
 */

/** Whether an agent is taking a turn, which is the one question Running asks. */
export function isMidTurn(agent: FocusAgentRow): boolean {
  return agent.tier === "turn";
}

/**
 * The tasks the Running section lists: those with at least one agent it would
 * actually DRAW.
 *
 * Deliberately the same predicate as {@link visibleAgents} rather than a second
 * one beside it - a task is a Running row exactly when it has a visible agent,
 * so the section and its rows cannot disagree about what is running.
 *
 * That resolves both halves in one rule. A WARM task whose only activity is
 * background-tier has every agent hidden, so it has no Running row: its work is
 * in Background, once, under the job's own name. A task this window has NO job
 * row for keeps every agent, so it keeps its Running row - including the cold
 * background-only task, which would otherwise vanish from Focus entirely, since
 * neither section could show it. It reads `background` with H3's honest
 * `n agents · not open in this window`.
 *
 * The heading counts this list for the same reason: a heading that counted
 * tasks the section does not draw is the same lie in smaller type.
 */
export function runningTasks(
  tasks: ReadonlyArray<FocusTaskRow>,
  jobEpicIds: ReadonlySet<string>,
): ReadonlyArray<FocusTaskRow> {
  return tasks.filter(
    (task) =>
      visibleAgents(task.agents, jobEpicIds.has(task.epicId)).length > 0,
  );
}

/**
 * The agents a task's own row or group draws.
 *
 * Mid-turn agents always. A background-tier agent only when this window has NO
 * job to show for that task - which is the honest exception rather than a
 * softening of the rule: the reason to hide it is that its work appears as a
 * job row instead, so where no job row exists, hiding it would lose the work
 * rather than de-duplicate it. That is the cold-window case, and there the
 * agent reads `background` in the status cell.
 */
export function visibleAgents(
  agents: ReadonlyArray<FocusAgentRow>,
  hasVisibleJobs: boolean,
): ReadonlyArray<FocusAgentRow> {
  if (!hasVisibleJobs) return agents;
  return agents.filter(isMidTurn);
}

/** The epics this window can show background work for, which is what decides
 * whether hiding a background-tier agent loses it. */
export function epicIdsWithJobs(
  background: ReadonlyArray<FocusBackgroundRow>,
): ReadonlySet<string> {
  return new Set(background.map((row) => row.epicId));
}

/** The numbers the summary line reports, from the same model the sections
 * render - so a segment can never name a count no section will draw. */
export interface FocusCounts {
  readonly needsYou: number;
  readonly running: number;
  readonly background: number;
  readonly browsers: number;
}

export function focusCounts(model: FocusModel): FocusCounts {
  return {
    needsYou: model.prompts.length,
    running: runningTasks(model.tasks, epicIdsWithJobs(model.background))
      .length,
    background: model.background.length,
    browsers: model.browsers.length,
  };
}
