/**
 * The Tasks view's second section: one disclosure row per task, grouping the
 * agents running in it and the background jobs it has warm in this window.
 *
 * Two levels and no more. A task expands into WORK ROWS - agents, then jobs -
 * and an agent started by another agent stays at that level, saying `via
 * <parent>` instead of taking a third indent. The section above this one
 * ("Needs you") is never duplicated here: a task that wants the user carries a
 * noninteractive glyph and a count, and the actionable rows stay in the one
 * place they can be acted on.
 *
 * Disclosure state is each row's own `useState`, which is what makes it both
 * session-lived and self-pruning: the `<li>` is keyed by epic id, so a task
 * leaving the model unmounts its row and takes its disclosure with it, and a
 * task that comes back comes back at the section's default.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight, Layers } from "lucide-react";
import {
  AgentGlyph,
  BackgroundGlyph,
  ColdTaskAgents,
  HomeFocusTaskStopCluster,
  TaskAttentionGlyph,
  type HomeFocusRowActions,
} from "@/components/home-focus/home-focus-rows";
import {
  RowActionsCell,
  RowContext,
  RowItemName,
  RowStatus,
  RowStatusDuration,
} from "@/components/home-focus/home-focus-row-parts";
import {
  focusAgentState,
  focusJobState,
  focusTaskState,
} from "@/lib/home-focus/focus-row-status";
import { visibleAgents } from "@/lib/home-focus/focus-running";
import {
  homeChipRowClass,
  homeRowClass,
  ROW_BODY_CLASS,
} from "@/components/home-focus/home-focus-row-style";
import { useHomeDensity } from "@/hooks/home-focus/use-home-density";
import {
  focusAgentDisplayName,
  focusTaskTitleOf,
} from "@/lib/home-focus/focus-row-labels";
import type {
  FocusTaskGroup,
  FocusTaskGroupAgent,
} from "@/lib/home-focus/focus-task-groups";
import type { FocusBackgroundRow } from "@/lib/home-focus/focus-model";
import { cn } from "@/lib/utils";

/**
 * How many tasks may open at once on first entry.
 *
 * Above it every row is collapsed, because an expand-all on a busy account is
 * a page the user has to scroll before they can see how many tasks there even
 * are - and the count in the section heading already tells them.
 */
const EXPAND_ALL_MAX_TASKS = 3;

export function HomeFocusTaskGroups(props: {
  readonly groups: ReadonlyArray<FocusTaskGroup>;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  // Captured at mount, which is the literal "first entry to Tasks": this
  // section only exists while that view is showing, so switching away and back
  // re-asks the question against the list as it is then. A task arriving while
  // the view is open joins at the same default rather than re-deciding it for
  // every row already on screen.
  const [defaultExpanded] = useState<boolean>(
    () => props.groups.length <= EXPAND_ALL_MAX_TASKS,
  );
  return (
    <>
      {props.groups.map((group) => (
        <HomeFocusTaskGroupRow
          key={group.epicId}
          group={group}
          actions={props.actions}
          defaultExpanded={defaultExpanded}
        />
      ))}
    </>
  );
}

/**
 * What a group can show under its own row.
 *
 * A cold task names no agents - its titles only exist for epics mounted here,
 * and a placeholder child would name work nobody can open - so it contributes
 * none, and a task
 * with nothing left to reveal gets no disclosure at all. Its jobs still count:
 * "mounted here" (a live Y.Doc projection) and "has a warm chat" are different
 * questions, so an unmounted epic with warm background work has something to
 * open even though it has no agent rows.
 */
function groupWorkRows(group: FocusTaskGroup): {
  readonly agents: ReadonlyArray<FocusTaskGroupAgent>;
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
} {
  const cold = group.task !== null && !group.task.mountedHere;
  if (cold) return { agents: [], jobs: group.jobs };
  // Mid-turn agents, plus any background-tier agent whose work this window has
  // no job row for. A background-tier agent beside its own job rows is the
  // duplicate decision 7 removes: the chat is not itself doing anything, the
  // monitor it hosts is, and the monitor has a row of its own below.
  const shown = new Set(
    visibleAgents(
      group.agents.map((entry) => entry.agent),
      group.backgroundVisible,
    ).map((agent) => agent.agentId),
  );
  return {
    agents: group.agents.filter((entry) => shown.has(entry.agent.agentId)),
    jobs: group.jobs,
  };
}

function HomeFocusTaskGroupRow(props: {
  readonly group: FocusTaskGroup;
  readonly actions: HomeFocusRowActions;
  readonly defaultExpanded: boolean;
}): ReactNode {
  const { group, actions } = props;
  const density = useHomeDensity();
  const [expanded, setExpanded] = useState<boolean>(props.defaultExpanded);
  const title = focusTaskTitleOf(group.taskTitle);
  const work = groupWorkRows(group);
  const hasBody = work.agents.length > 0 || work.jobs.length > 0;
  const showBody = hasBody && expanded;
  const bodyId = `home-focus-task-group-${group.epicId}`;
  return (
    <li
      className="flex flex-col"
      data-testid="home-focus-task-group"
      data-epic-id={group.epicId}
    >
      <div
        className={homeRowClass(density)}
        data-density={density}
        data-testid="home-focus-task-group-row"
        data-cold={group.task !== null && !group.task.mountedHere}
      >
        {/* Two controls, and they are two VERBS rather than the duplicate the
            `Open` button was: the twisty reveals what the task contains, the
            row body opens the task.

            `z-10` is load bearing and `relative` alone is NOT enough here.
            `ROW_BODY_CLASS` carries `before:absolute before:inset-0`, and the
            body button is unpositioned, so that overlay's containing block is
            this row - it stretches across the twisty too. Overlay and twisty
            would then both be `z-index: auto` positioned boxes painted in TREE
            ORDER, and the overlay belongs to the LATER sibling, so it would
            paint last and swallow every click on the twisty. `RowActions` and
            `AgentChip` get away with bare `relative` only because they come
            AFTER the body button; this is the first control in this family
            placed before it. */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={showBody ? bodyId : undefined}
          // State-neutral, because the same control both shows and hides;
          // `aria-expanded` is what carries which way it will go.
          aria-label={`What is running in ${title}`}
          disabled={!hasBody}
          onClick={() => setExpanded((previous) => !previous)}
          className={cn(
            "relative z-10 flex shrink-0 items-center rounded-sm p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            hasBody ? "hover:bg-foreground/8" : "invisible",
          )}
          data-testid="home-focus-task-group-disclosure"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && hasBody && "rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          onClick={() => actions.openTask(group.epicId)}
          className={cn(ROW_BODY_CLASS, "flex-initial")}
          data-testid="home-focus-task-group-open-body"
        >
          <TaskGroupGlyph group={group} />
          <RowItemName testId="home-focus-row-name">{title}</RowItemName>
        </button>
        <div className={homeChipRowClass(density)}>
          <TaskGroupSummary group={group} work={work} />
        </div>
        <RowStatus
          state={focusTaskState(group.task, group.promptCount)}
          duration={null}
        />
        {group.task === null ? (
          <RowActionsCell>{null}</RowActionsCell>
        ) : (
          <HomeFocusTaskStopCluster row={group.task} actions={actions} />
        )}
      </div>
      {showBody ? (
        <TaskGroupBody
          id={bodyId}
          epicId={group.epicId}
          agents={work.agents}
          jobs={work.jobs}
          actions={actions}
        />
      ) : null}
    </li>
  );
}

/**
 * The attention glyph, or the neutral task glyph. Noninteractive in both cases
 * - it reports that something in this task is waiting, and the Needs you
 * section above is where that something is answered.
 */
function TaskGroupGlyph(props: { readonly group: FocusTaskGroup }): ReactNode {
  const { group } = props;
  if (props.group.promptCount > 0 || group.task?.needsYou === true) {
    return <TaskAttentionGlyph />;
  }
  return (
    <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  );
}

const BADGE_CLASS =
  "shrink-0 rounded-sm bg-foreground/8 px-1.5 py-0.5 text-ui-xs text-muted-foreground";

/**
 * What the collapsed row still says about what it hides.
 *
 * A cold task keeps H3's honest sentence instead of a count of names it does
 * not have. Everything else gets badges: needs-you counts LOADED prompt rows
 * and is omitted at zero, so it never claims a number the page above it cannot
 * show; `N active` is omitted for an epic that is here on its background work
 * alone, since it has no running agent to count; `N bg` renders only where this
 * window can actually see the task's background, rather than reading "0 bg" at
 * a task whose chats it has simply never opened.
 */
function TaskGroupSummary(props: {
  readonly group: FocusTaskGroup;
  readonly work: {
    readonly agents: ReadonlyArray<FocusTaskGroupAgent>;
    readonly jobs: ReadonlyArray<FocusBackgroundRow>;
  };
}): ReactNode {
  const { group } = props;
  const { task } = group;
  const coldTask = task !== null && !task.mountedHere ? task : null;
  return (
    <>
      {group.promptCount > 0 ? (
        <span className={BADGE_CLASS} data-testid="home-focus-task-group-needs">
          {group.promptCount} need you
        </span>
      ) : null}
      {/* A cold task keeps H3's honest sentence in place of the agent count:
          it has agents, and no names for them. */}
      {coldTask === null ? null : <ColdTaskAgents agents={coldTask.agents} />}
      {task === null ||
      coldTask !== null ||
      props.work.agents.length === 0 ? null : (
        <span
          className={BADGE_CLASS}
          data-testid="home-focus-task-group-active"
        >
          {props.work.agents.length} active
        </span>
      )}
      {group.backgroundVisible ? (
        <span className={BADGE_CLASS} data-testid="home-focus-task-group-jobs">
          {group.jobs.length} bg
        </span>
      ) : null}
    </>
  );
}

/** A real nested list, so a screen reader reads the work rows as belonging to
 * the task rather than as a flat continuation of the section. */
function TaskGroupBody(props: {
  readonly id: string;
  readonly epicId: string;
  readonly agents: ReadonlyArray<FocusTaskGroupAgent>;
  readonly jobs: ReadonlyArray<FocusBackgroundRow>;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { actions } = props;
  return (
    <ul
      id={props.id}
      className="ms-5 flex flex-col border-l border-border/60 pl-3"
      data-testid="home-focus-task-group-body"
    >
      {props.agents.map((entry) => (
        <TaskGroupAgentRow
          key={entry.agent.agentId}
          epicId={props.epicId}
          entry={entry}
          actions={actions}
        />
      ))}
      {props.jobs.map((job) => (
        <TaskGroupJobRow key={job.key} job={job} actions={actions} />
      ))}
    </ul>
  );
}

function TaskGroupAgentRow(props: {
  readonly epicId: string;
  readonly entry: FocusTaskGroupAgent;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { epicId, entry, actions } = props;
  const density = useHomeDensity();
  const { agent } = entry;
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-task-group-agent"
      data-agent-id={agent.agentId}
    >
      <button
        type="button"
        onClick={() => actions.openAgent(epicId, agent.agentId)}
        className={ROW_BODY_CLASS}
        data-testid="home-focus-task-group-agent-body"
      >
        <AgentGlyph surface={agent.surface} className="size-4" />
        {/* No `in <task>`: the row directly above names the task, and repeating
            it on every child is the concatenation this design removes. `via`
            is a different fact - which agent started this one - and stays. */}
        <RowItemName testId="home-focus-row-name">
          {focusAgentDisplayName(agent)}
        </RowItemName>
        {entry.via === null ? null : (
          <span
            className="min-w-0 shrink truncate text-ui-xs text-muted-foreground"
            data-testid="home-focus-task-group-agent-via"
          >
            via {entry.via}
          </span>
        )}
      </button>
      <RowStatus state={focusAgentState(agent)} duration={null} />
      <RowActionsCell>{null}</RowActionsCell>
    </li>
  );
}

function TaskGroupJobRow(props: {
  readonly job: FocusBackgroundRow;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { job, actions } = props;
  const density = useHomeDensity();
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-task-group-job"
    >
      <button
        type="button"
        onClick={() => actions.openBackground(job)}
        className={ROW_BODY_CLASS}
        data-testid="home-focus-task-group-job-body"
      >
        <BackgroundGlyph row={job} />
        <RowItemName testId="home-focus-row-name">{job.label}</RowItemName>
        {/* The task is the row above; the CHAT is not, and it is what the job's
            Stop targets, so it stays as the one piece of context. */}
        <RowContext
          parts={[{ role: "chat", title: job.chatTitle }]}
          testId="home-focus-row-context"
        />
      </button>
      <RowStatus
        state={focusJobState(job)}
        duration={
          job.startedAtMs === null ? null : (
            <RowStatusDuration startedAtMs={job.startedAtMs} />
          )
        }
      />
      <RowActionsCell>{null}</RowActionsCell>
    </li>
  );
}
