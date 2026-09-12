/**
 * Home's rows: one disclosure row per task, holding the chats running in it,
 * and under each chat the work that chat owns - its prompts, its background
 * jobs, and the browser tabs it is driving.
 *
 * THREE levels, and the third is the point. A monitor listed beside the chat
 * hosting it had to name its parent to make sense of itself - `10min heartbeat
 * · in Greeting and Introduction` - and a reader met the conversation's name
 * twice, once as a row and once as a suffix. Nested under the chat, the
 * structure says it and the row is just the job.
 *
 * A chat still does not take a level for its PARENTAGE: an agent another agent
 * started sits beside it and says `via <parent>`, because the indent under a
 * chat is spoken for by that chat's own work. Anything whose owning chat is not
 * a row here - an undriven tab, a job in a chat this window cannot place, a
 * browser hand-off, which names a page and never a conversation - hangs off the
 * task at level one and keeps the context that says where it lives.
 *
 * Disclosure is NOT this component's state. It lives above the two sections
 * (`useTaskDisclosure`), because a task moving between `Needs you` and
 * `Running` unmounts its `<li>` from one subtree and mounts a new one in the
 * other - a key is stable within a parent, not across two - and row-local
 * state collapsed a task at the exact moment the user answered its prompt.
 */
import { type ReactNode } from "react";
import { ChevronRight, Globe, Layers } from "lucide-react";
import {
  AgentGlyph,
  BackgroundGlyph,
  BrowserStatusDetail,
  BrowserTabName,
  ColdTaskAgents,
  HomeFocusAgentStop,
  HomeFocusJobStop,
  HomeFocusPromptRow,
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
  focusBrowserState,
  focusJobState,
  focusTaskState,
} from "@/lib/home-focus/focus-row-status";
import {
  homeChipRowClass,
  homeRowClass,
  ROW_BODY_CLASS,
} from "@/components/home-focus/home-focus-row-style";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHomeDensity } from "@/hooks/home-focus/use-home-density";
import {
  focusAgentDisplayName,
  focusTaskTitleOf,
} from "@/lib/home-focus/focus-row-labels";
import {
  selectTaskGroupBody,
  taskGroupCounts,
  type FocusTaskGroup,
  type FocusTaskGroupBody,
  type FocusTaskGroupChat,
} from "@/lib/home-focus/focus-task-groups";
import type {
  FocusBackgroundRow,
  FocusBrowserRow,
} from "@/lib/home-focus/focus-model";
import { cn } from "@/lib/utils";

/** Whether each task row is open, and how to flip one. Owned above the two
 * sections so a task moving between them keeps the row the user opened - a key
 * is only stable within one parent, and the sections are two. */
export interface HomeFocusTaskDisclosure {
  readonly isExpanded: (key: string) => boolean;
  readonly toggle: (key: string) => void;
}

/** One group, its identity across the page, and the label its own `Stop all`
 * needs - per TASK, because an A-only task sitting beside an A/B one in the
 * same bucket is not split and must not claim to be. */
export interface HomeFocusTaskGroupEntry {
  /** Stable across a section move and distinct per host, so two machines'
   * shares of one task open independently. */
  readonly key: string;
  readonly group: FocusTaskGroup;
  readonly stopAllHostLabel: string | null;
}

export function HomeFocusTaskGroups(props: {
  readonly entries: ReadonlyArray<HomeFocusTaskGroupEntry>;
  readonly actions: HomeFocusRowActions;
  readonly disclosure: HomeFocusTaskDisclosure;
}): ReactNode {
  return (
    <>
      {props.entries.map((entry) => (
        <HomeFocusTaskGroupRow
          key={entry.key}
          group={entry.group}
          actions={props.actions}
          expanded={props.disclosure.isExpanded(entry.key)}
          onToggle={() => props.disclosure.toggle(entry.key)}
          stopAllHostLabel={entry.stopAllHostLabel}
        />
      ))}
    </>
  );
}

function HomeFocusTaskGroupRow(props: {
  readonly group: FocusTaskGroup;
  readonly actions: HomeFocusRowActions;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly stopAllHostLabel: string | null;
}): ReactNode {
  const { group, actions, expanded } = props;
  const density = useHomeDensity();
  const title = focusTaskTitleOf(group.taskTitle);
  const body = selectTaskGroupBody(group);
  const hasBody =
    body.chats.length > 0 ||
    body.prompts.length > 0 ||
    body.jobs.length > 0 ||
    body.browsers.length > 0;
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
            paint last and swallow every click on the twisty. `RowActions` gets
            away with bare `relative` only because it comes AFTER the body
            button; this is the first control in this family placed before it. */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={showBody ? bodyId : undefined}
          // State-neutral, because the same control both shows and hides;
          // `aria-expanded` is what carries which way it will go.
          aria-label={`What is running in ${title}`}
          disabled={!hasBody}
          onClick={props.onToggle}
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
          <TaskGroupSummary group={group} />
        </div>
        <RowStatus
          state={focusTaskState(group.task, group.prompts.length)}
          detail={null}
        />
        {group.task === null ? (
          <RowActionsCell>{null}</RowActionsCell>
        ) : (
          <HomeFocusTaskStopCluster
            row={group.task}
            actions={actions}
            hostLabel={props.stopAllHostLabel}
          />
        )}
      </div>
      {showBody ? (
        <TaskGroupBody
          id={bodyId}
          epicId={group.epicId}
          taskTitle={title}
          body={body}
          actions={actions}
        />
      ) : null}
    </li>
  );
}

/**
 * The attention glyph, or the neutral task glyph. Noninteractive in both cases
 * - it reports that something in this task is waiting, and the prompt rows
 * under it are where that something is answered.
 */
function TaskGroupGlyph(props: { readonly group: FocusTaskGroup }): ReactNode {
  const { group } = props;
  if (props.group.prompts.length > 0 || group.task?.needsYou === true) {
    return <TaskAttentionGlyph />;
  }
  return (
    <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  );
}

const BADGE_CLASS =
  "shrink-0 rounded-sm bg-foreground/8 px-1.5 py-0.5 text-ui-xs text-muted-foreground";

/**
 * What the collapsed row still says about what it hides, counted over the whole
 * subtree rather than over the level immediately under it.
 *
 * A cold task keeps H3's honest sentence instead of a count of names it does
 * not have. Everything else gets badges: needs-you counts LOADED prompt rows
 * and is omitted at zero, so it never claims a number the rows below it cannot
 * show; `N active` counts mid-turn agents and is omitted at zero, which is the
 * task that is here for its durable work alone; `N bg` renders only where this
 * window can actually see the task's background, rather than reading "0 bg" at
 * a task whose chats it has simply never opened.
 */
function TaskGroupSummary(props: {
  readonly group: FocusTaskGroup;
}): ReactNode {
  const { group } = props;
  const { task } = group;
  const counts = taskGroupCounts(group);
  const coldTask = task !== null && !task.mountedHere ? task : null;
  return (
    <>
      {counts.needsYou === 0 ? null : (
        <span className={BADGE_CLASS} data-testid="home-focus-task-group-needs">
          {counts.needsYou} need you
        </span>
      )}
      {/* A cold task keeps H3's honest sentence in place of the agent count:
          it has agents, and no names for them. */}
      {coldTask === null ? null : <ColdTaskAgents agents={coldTask.agents} />}
      {coldTask !== null || counts.active === 0 ? null : (
        <span
          className={BADGE_CLASS}
          data-testid="home-focus-task-group-active"
        >
          {counts.active} active
        </span>
      )}
      {group.backgroundVisible ? (
        <span className={BADGE_CLASS} data-testid="home-focus-task-group-jobs">
          {counts.jobs} bg
        </span>
      ) : null}
      {/* Omitted at zero rather than shown as `0 browsers`, and for a sharper
          reason than the other badges: this plane is mounted-only, so a zero
          here would not mean "no pages open" - it would mean "no coordinator in
          this window", which is not a fact about the task at all. */}
      {counts.browsers === 0 ? null : (
        <span
          className={BADGE_CLASS}
          data-testid="home-focus-task-group-browsers"
        >
          {counts.browsers === 1 ? "1 browser" : `${counts.browsers} browsers`}
        </span>
      )}
    </>
  );
}

/** A real nested list, so a screen reader reads the work rows as belonging to
 * the task rather than as a flat continuation of the section. */
function TaskGroupBody(props: {
  readonly id: string;
  readonly epicId: string;
  readonly taskTitle: string;
  readonly body: FocusTaskGroupBody;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { actions, body } = props;
  return (
    <ul id={props.id} className={NESTED_LIST_CLASS} data-testid={BODY_TEST_ID}>
      {body.chats.map((chat) => (
        <TaskGroupChatRow
          key={chat.agent.agentId}
          epicId={props.epicId}
          taskTitle={props.taskTitle}
          chat={chat}
          actions={actions}
        />
      ))}
      {/* What has no chat to sit under: a browser hand-off names a session and
          a tab, a job can outlive this window's knowledge of its conversation,
          and the host split can leave a row's driver on the other machine.
          Under the task rather than nowhere, in the same order the levels
          below follow - what is asking, then what is running, then where. */}
      {body.prompts.map((prompt) => (
        <HomeFocusPromptRow
          key={prompt.key}
          row={prompt}
          actions={actions}
          showLocation={false}
        />
      ))}
      {body.jobs.map((job) => (
        <TaskGroupJobRow key={job.key} job={job} actions={actions} showChat />
      ))}
      {body.browsers.map((browser) => (
        <TaskGroupBrowserRow
          key={browser.key}
          browser={browser}
          actions={actions}
        />
      ))}
    </ul>
  );
}

/** Indented on the LEFT only, so a nested row's right edge is its parent's and
 * the status and actions tracks stay one column down the whole page. */
const NESTED_LIST_CLASS = "ms-5 flex flex-col border-l border-border/60 pl-3";
const BODY_TEST_ID = "home-focus-task-group-body";

/**
 * One chat under a task, with everything it owns beneath it.
 *
 * No second disclosure: the task's twisty is the one control, and a chat that
 * hid its own work behind another click would make finding a monitor a
 * two-gesture job on a page whose whole purpose is one glance.
 */
function TaskGroupChatRow(props: {
  readonly epicId: string;
  readonly taskTitle: string;
  readonly chat: FocusTaskGroupChat;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { epicId, chat, actions } = props;
  const density = useHomeDensity();
  const { agent } = chat;
  const hasWork =
    chat.prompts.length > 0 || chat.jobs.length > 0 || chat.browsers.length > 0;
  return (
    <li
      className="flex flex-col"
      data-testid="home-focus-task-group-chat"
      data-agent-id={agent.agentId}
    >
      <div
        className={homeRowClass(density)}
        data-density={density}
        data-testid="home-focus-task-group-agent"
      >
        <button
          type="button"
          onClick={() => actions.openAgent(epicId, agent.agentId)}
          className={ROW_BODY_CLASS}
          data-testid="home-focus-task-group-agent-body"
        >
          <AgentGlyph surface={agent.surface} className="size-4" />
          {/* No `in <task>`: the row above names the task, and repeating it on
              every child is the concatenation this design removes. `via` is a
              different fact - which agent started this one - and stays. */}
          <RowItemName testId="home-focus-row-name">
            {focusAgentDisplayName(agent)}
          </RowItemName>
          {chat.via === null ? null : (
            <span
              className="min-w-0 shrink truncate text-ui-xs text-muted-foreground"
              data-testid="home-focus-task-group-agent-via"
            >
              via {chat.via}
            </span>
          )}
        </button>
        <RowStatus state={focusAgentState(agent)} detail={null} />
        <RowActionsCell>
          {chatIsJobHostOnly(props.chat) ? null : (
            <HomeFocusAgentStop
              epicId={epicId}
              agent={agent}
              taskTitle={props.taskTitle}
              actions={actions}
            />
          )}
        </RowActionsCell>
      </div>
      {hasWork ? (
        <ul
          className={NESTED_LIST_CLASS}
          data-testid="home-focus-task-group-chat-body"
        >
          {/* Asking first, running second, open third: the same order the task
              level uses, so a reader descending the page never has to relearn
              what a position means. */}
          {chat.prompts.map((prompt) => (
            <HomeFocusPromptRow
              key={prompt.key}
              row={prompt}
              actions={actions}
              showLocation={false}
            />
          ))}
          {chat.jobs.map((job) => (
            <TaskGroupJobRow
              key={job.key}
              job={job}
              actions={actions}
              showChat={false}
            />
          ))}
          {chat.browsers.map((browser) => (
            <TaskGroupBrowserRow
              key={browser.key}
              browser={browser}
              actions={actions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Whether this chat is on the page to PARENT its jobs rather than to report a
 * run of its own - an idle conversation whose monitor is what is actually
 * running.
 *
 * It is the one chat row with no `Stop`. The work is the jobs beneath it, each
 * of which carries its own, and a stop on the conversation would be a bigger,
 * vaguer version of the button one line down. A background-tier chat with NO
 * jobs here is a different thing - a run this window has no durable row for -
 * and keeps its stop, or the page would offer no way to end it at all.
 */
function chatIsJobHostOnly(chat: FocusTaskGroupChat): boolean {
  return chat.agent.tier === "background" && chat.jobs.length > 0;
}

function TaskGroupJobRow(props: {
  readonly job: FocusBackgroundRow;
  readonly actions: HomeFocusRowActions;
  /** `true` only where the job is NOT under its chat - the row then has to say
   * which conversation it runs in, because nothing above it does. */
  readonly showChat: boolean;
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
        <RowContext
          parts={[
            {
              role: "chat",
              title: props.showChat ? job.chatTitle : null,
              preposition: "in",
            },
          ]}
          testId="home-focus-row-context"
        />
      </button>
      <RowStatus
        state={focusJobState(job)}
        detail={
          job.startedAtMs === null ? null : (
            <RowStatusDuration startedAtMs={job.startedAtMs} />
          )
        }
      />
      <RowActionsCell>
        <HomeFocusJobStop row={job} actions={actions} />
      </RowActionsCell>
    </li>
  );
}

/**
 * One browser tab, under the chat driving it or under the task when nothing
 * here is.
 *
 * No `in <task>` and no `via <agent>`: the row above is the answer to both, and
 * a tab that reached level one did so precisely because no row here drives it.
 * The status cell keeps `driven by <agent>` regardless - that is attribution
 * rather than navigation, and it survives a driver on another machine, which
 * placement cannot.
 *
 * No stop, and the actions track is reserved anyway: closing a tab is a canvas
 * action on the tile, and every row here has to spend the same width on actions
 * or the status column moves.
 */
function TaskGroupBrowserRow(props: {
  readonly browser: FocusBrowserRow;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { browser, actions } = props;
  const density = useHomeDensity();
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-task-group-browser"
      data-status={browser.status}
    >
      <TooltipWrapper
        label={browser.url}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          onClick={() => actions.openBrowser(browser)}
          className={ROW_BODY_CLASS}
          data-testid="home-focus-task-group-browser-body"
        >
          <Globe
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <BrowserTabName row={browser} />
        </button>
      </TooltipWrapper>
      <RowStatus
        state={focusBrowserState(browser)}
        detail={<BrowserStatusDetail row={browser} />}
      />
      <RowActionsCell>{null}</RowActionsCell>
    </li>
  );
}
