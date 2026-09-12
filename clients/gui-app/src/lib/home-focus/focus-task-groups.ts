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
   * the reader can actually reach.
   *
   * The rows rather than their count, because they are what the group RENDERS:
   * a prompt hangs under the chat it was raised in, and a group split across
   * hosts files each prompt under the machine it came from.
   */
  readonly prompts: ReadonlyArray<FocusPromptRow>;
  readonly agents: ReadonlyArray<FocusAgentRow>;
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
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
 * Home's grouping: one group per epic that has work to show, each joined to the
 * prompts and background jobs that name it.
 *
 * MEMBERSHIP is the union of THREE sets that are not nested. `model.tasks`
 * covers epics with a running agent; `model.background` covers epics with warm
 * chat work, running agent or not; `model.browsers` covers epics with a live
 * browser, which needs neither. Tasks come first, in the model's own order (so
 * tasks wanting the user still lead), then the remaining epics in
 * `model.background` order, then those that reached the list on browsers alone.
 * The union is what keeps the page honest: there is no Background or Browsers
 * section to catch a row whose epic is not a task row, so an intersection would
 * drop that row silently - and on an idle account whose only activity is a dev
 * server, or a task left open at a page, would leave the page blank.
 *
 * Prompts with no `epicId` group nowhere: they are real work that belongs to no
 * task this client can name. The Needs you section lists them beside the groups
 * rather than under one, because filing them under a guessed task would be a
 * guess and dropping them would lose a row the tab badge is still counting.
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
  const groups = model.tasks.map((task): FocusTaskGroup => {
    const jobs = jobsByEpicId.get(task.epicId) ?? [];
    return {
      epicId: task.epicId,
      taskTitle: task.taskTitle,
      task,
      prompts: promptsByEpicId.get(task.epicId) ?? [],
      agents: task.agents,
      jobs,
      browsers: browsersByEpic.get(task.epicId) ?? [],
      backgroundVisible: jobs.length > 0,
    };
  });
  const listed = new Set(model.tasks.map((task) => task.epicId));
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
  // thing a group can be here - and present at all, because there is no
  // Browsers section to catch it.
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

/** The prompts that name no task, in the model's own attention order. They are
 * the reason the Needs you section lists rows as well as groups. */
export function unattributedPrompts(
  model: FocusModel,
): ReadonlyArray<FocusPromptRow> {
  return model.prompts.filter((prompt) => prompt.epicId === null);
}

/**
 * Whether this task is why someone opened Home.
 *
 * Two sources and both are needed. A LOADED prompt row is the one the page can
 * nest under a chat and the user can answer; `needsYou` is the host's indicator
 * flag, true from the moment a prompt is pending whether or not the feed has
 * paged its row in - which is the cold task that has something waiting and
 * nothing to show for it yet. Reading only the rows would drop that task into
 * Running and read as "nothing wants you" for as long as the page took to
 * load.
 */
export function taskGroupNeedsYou(group: FocusTaskGroup): boolean {
  return group.prompts.length > 0 || group.task?.needsYou === true;
}

/** The two sections Home draws, in the order it draws them. */
export interface FocusTaskSections {
  readonly needsYou: ReadonlyArray<FocusTaskGroup>;
  readonly running: ReadonlyArray<FocusTaskGroup>;
}

/**
 * Splits the groups into the section each belongs to, keeping the model's
 * order inside both.
 *
 * A task is in exactly one, which is the whole point: the page used to carry a
 * flat prompt list ABOVE a task list that listed the same task again, so a task
 * waiting on an approval appeared twice, in two vocabularies, and the count in
 * one heading did not explain the count in the other.
 *
 * Partitioned BEFORE the host split, never after. `splitTaskGroupByHost` files
 * a prompt under the machine it was raised on and drops it from the other
 * slices, so a task worked from two hosts with one prompt would otherwise land
 * in Needs you under one machine and in Running under the other - the same task
 * in both sections, which is exactly what this partition exists to prevent.
 */
export function selectTaskSections(
  groups: ReadonlyArray<FocusTaskGroup>,
): FocusTaskSections {
  const needsYou: FocusTaskGroup[] = [];
  const running: FocusTaskGroup[] = [];
  for (const group of groups) {
    if (taskGroupNeedsYou(group)) needsYou.push(group);
    else running.push(group);
  }
  return { needsYou, running };
}

/**
 * One chat under a task - the level the user thinks in - and everything that
 * chat owns.
 *
 * `via` is the agent that STARTED this one, when that agent is itself a row of
 * this group. Chats stay at one level whether or not they parent each other: a
 * sub-agent says `via <parent>` rather than taking another indent, because the
 * indent below it is already spoken for by the chat's own work.
 */
export interface FocusTaskGroupChat {
  readonly agent: FocusAgentRow;
  /** The parent agent's display name, or `null` when this chat is a direct
   * child of the task. */
  readonly via: string | null;
  /** The prompts raised in this chat, which is where they are answered. */
  readonly prompts: ReadonlyArray<FocusPromptRow>;
  /** The durable work running in this chat: shells the host owns across turns,
   * and the background items of its turns. */
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
  /** The pages this chat is driving right now. */
  readonly browsers: ReadonlyArray<FocusBrowserRow>;
}

/**
 * A task expanded: its chats, each carrying its own work, plus whatever hangs
 * off the task directly.
 *
 * THREE levels, and the third exists because two was the thing the user
 * objected to. A monitor listed beside the chat running it read
 * `10min heartbeat · in Greeting and Introduction` - the row had to name its
 * parent because it was not under it. Put it under the chat and the sentence is
 * the structure instead.
 */
export interface FocusTaskGroupBody {
  readonly chats: ReadonlyArray<FocusTaskGroupChat>;
  /** Prompts with no chat of their own - a browser hand-off names a session and
   * a tab, never a conversation - and prompts whose chat is not a row here. */
  readonly prompts: ReadonlyArray<FocusPromptRow>;
  /** Jobs whose chat this window cannot place among the rows above: they keep
   * their `· in <chat>` context, since nothing else on the page says it. */
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
  /** Pages nothing is driving, and pages whose driver is not a row here. */
  readonly browsers: ReadonlyArray<FocusBrowserRow>;
}

/**
 * Resolves a group into the tree it renders as, against the rows the caller is
 * ACTUALLY GOING TO DRAW.
 *
 * Deliberately not a field on {@link FocusTaskGroup}, and deliberately the last
 * thing to run. The agent set narrows after the group is built - the cold-task
 * rule drops every agent, and the host split keeps one machine's - and every
 * relationship here is a claim about the rows beside it: a `via` naming a
 * parent that is not there, or a job nested under a chat that was filtered out,
 * is worse than the flat list it replaced. Pairing them at the render site
 * makes that impossible rather than merely fixed - there is no earlier value to
 * go stale.
 *
 * A chat agent's id IS its chat id, which is what lets a job's `chatId`, a
 * prompt's `chatId` and a tab's `drivenByChatId` all be looked up in a map of
 * agent ids.
 */
export function selectTaskGroupBody(group: FocusTaskGroup): FocusTaskGroupBody {
  // A cold task names no agents - titles only exist for epics mounted here, and
  // a placeholder chat would name work nobody can open - so it contributes
  // none, and everything it does have hangs off the task itself. Its jobs still
  // count: "mounted here" (a live Y.Doc projection) and "has a warm chat" are
  // different questions, so an unmounted epic with warm background work has
  // something to open even though it has no chat rows.
  const cold = group.task !== null && !group.task.mountedHere;
  const agents = cold ? [] : group.agents;
  const byAgentId = new Map(agents.map((agent) => [agent.agentId, agent]));
  const promptsByChatId = bucketByParent(group.prompts, (prompt) =>
    parentAgentId(prompt.chatId, byAgentId),
  );
  const jobsByChatId = bucketByParent(group.jobs, (job) =>
    parentAgentId(job.chatId, byAgentId),
  );
  const browsersByChatId = bucketByParent(group.browsers, (browser) =>
    parentAgentId(browser.drivenByChatId, byAgentId),
  );
  return {
    chats: agents.map((agent): FocusTaskGroupChat => {
      const parent =
        agent.parentId === null ? undefined : byAgentId.get(agent.parentId);
      return {
        agent,
        via: parent === undefined ? null : focusAgentDisplayName(parent),
        prompts: promptsByChatId.get(agent.agentId) ?? [],
        jobs: jobsByChatId.get(agent.agentId) ?? [],
        browsers: browsersByChatId.get(agent.agentId) ?? [],
      };
    }),
    prompts: promptsByChatId.get(null) ?? [],
    jobs: jobsByChatId.get(null) ?? [],
    browsers: browsersByChatId.get(null) ?? [],
  };
}

/** The chat a row hangs under, or `null` when it names none or names one that
 * is not a row of this group - both of which put it at the task's own level. */
function parentAgentId(
  chatId: string | null,
  byAgentId: ReadonlyMap<string, FocusAgentRow>,
): string | null {
  if (chatId === null) return null;
  return byAgentId.has(chatId) ? chatId : null;
}

/** Buckets rows by their parent chat id, `null` being "hangs off the task".
 * Order within a bucket is the model's, untouched. */
function bucketByParent<Row>(
  rows: ReadonlyArray<Row>,
  parentOf: (row: Row) => string | null,
): ReadonlyMap<string | null, ReadonlyArray<Row>> {
  const byParent = new Map<string | null, Row[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    const existing = byParent.get(parent);
    if (existing === undefined) byParent.set(parent, [row]);
    else existing.push(row);
  }
  return byParent;
}

/**
 * What the collapsed task row reports about what it hides - counted over the
 * WHOLE subtree rather than over one level, because the row is standing in for
 * everything under it whether that sits at level one or level three.
 *
 * Read off the group rather than off {@link FocusTaskGroupBody}, which is the
 * same numbers by construction: the body only redistributes these rows across
 * levels, it never adds or drops one. Counting the flat lists says so.
 */
export interface FocusTaskGroupCounts {
  readonly needsYou: number;
  /** Mid-turn agents. A chat that is merely hosting a durable job is not
   * "active" - the job is, and `bg` counts it. */
  readonly active: number;
  readonly jobs: number;
  readonly browsers: number;
}

export function taskGroupCounts(group: FocusTaskGroup): FocusTaskGroupCounts {
  return {
    needsYou: group.prompts.length,
    active: group.agents.filter((agent) => agent.tier === "turn").length,
    jobs: group.jobs.length,
    browsers: group.browsers.length,
  };
}
