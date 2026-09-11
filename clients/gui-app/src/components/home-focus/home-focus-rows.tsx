/**
 * The four row shapes Home renders: a pending prompt, a task with its running
 * agents, a background job, and a browser tab.
 *
 * They share the History list's row language (`epics-list-panel`'s row card) so
 * a task reads the same here as it does in History: one rounded card, `p-3`
 * density, `text-ui-sm`, the title in `font-medium text-foreground`.
 *
 * Every row's primary control is a real `<button>` spanning the row's body
 * rather than a click handler on the `<li>`, so the row is reachable by Tab and
 * Enter opens it with no key handling of our own. Trailing controls are
 * SIBLINGS of that button, never nested inside it.
 *
 * There is no trailing `Open` button, and its absence is deliberate. The row
 * body IS the open control and already spans the whole card, so a second
 * control doing the same thing was one extra tab stop per row and a second
 * announcement of a verb the row had already offered.
 */
import { useState, type ReactNode } from "react";
import { Globe, Layers, Square, Terminal } from "lucide-react";
import {
  APPROVAL_TONE,
  INTERVIEW_TONE,
  type IndicatorTone,
} from "@/components/notifications/notification-indicator-tones";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveLocalHostEntry } from "@/hooks/host/use-reactive-local-host-entry";
import { useHomeDensity } from "@/hooks/home-focus/use-home-density";
import { useHomeHostGrouped } from "@/components/home-focus/home-host-grouped-context";
import {
  homeChipRowClass,
  homeRowClass,
  ROW_BODY_CLASS,
} from "@/components/home-focus/home-focus-row-style";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { BACKGROUND_KIND_ICONS } from "@/lib/chat/background-kind-icon";
import {
  focusAgentDisplayName,
  focusTaskTitleOf,
} from "@/lib/home-focus/focus-row-labels";
import {
  RowActionsCell,
  RowContext,
  RowItemName,
  RowStatus,
  RowStatusDuration,
  RowStatusNote,
} from "@/components/home-focus/home-focus-row-parts";
import {
  focusAgentState,
  focusBrowserState,
  focusJobState,
  focusTaskState,
  FOCUS_ROW_STATES,
} from "@/lib/home-focus/focus-row-status";
import { visibleAgents } from "@/lib/home-focus/focus-running";
import { cn } from "@/lib/utils";
import type {
  FocusAgentRow,
  FocusBackgroundRow,
  FocusBrowserRow,
  FocusPromptKind,
  FocusPromptRow,
  FocusTaskRow,
} from "@/lib/home-focus/focus-model";

/**
 * What a row can do, declared structurally rather than imported from
 * `use-focus-actions`. A row depends on the SHAPE of the actions, not on the
 * hook that builds them, so this module pulls in no hook, no router and no
 * query client and a test can render a row with a plain object. Drift is still
 * caught: `home-focus-view` assigns the real `FocusActions` to this type, so a
 * member that stops matching is a type error at that assignment.
 */
export interface HomeFocusRowActions {
  readonly openPrompt: (row: FocusPromptRow) => void;
  readonly openAgent: (epicId: string, agentId: string) => void;
  readonly openTask: (epicId: string) => void;
  /** The job's own chat, not just its task - a background row names a shell in
   * one conversation, and landing on the task would make the user find it. */
  readonly openBackground: (row: FocusBackgroundRow) => void;
  /** The parked tile for this tab, on the tab's OWN host - which is the whole
   * point of the row. */
  readonly openBrowser: (row: FocusBrowserRow) => void;
  /** One object, carrying the agent's own host: the stop has to be routed to
   * the machine the agent runs on, not to whichever host this window is on. */
  readonly stopAgent: (input: {
    readonly epicId: string;
    readonly agentId: string;
    readonly hostId: string | null;
    readonly cascade: boolean;
  }) => void;
  readonly stopManagedCommand: (row: FocusBackgroundRow) => void;
  /** Agent ids and `FocusBackgroundRow.key`s with an in-flight stop. */
  readonly stopping: ReadonlySet<string>;
}

/** What a row whose stop cannot be ROUTED says instead of offering one: the
 * machine it runs on is not one this window can dial. */
const UNREACHABLE_STOP_REASON = "Runs on another device";

/** A background item's stop is a `chat.subscribe` action on a warm session
 * rather than a unary RPC (`focus-background.ts`), so it exists in the job's own
 * chat and nowhere else - which is where this sends the user, not to another
 * machine. */
const BACKGROUND_ITEM_STOP_REASON = "Stop this from the chat";

/** Why a background row's stop is disabled, which is never the same question
 * for the two planes the section lists: a managed command is unstoppable only
 * when its host is unknown, a background item always. */
function backgroundStopReason(row: FocusBackgroundRow): string | null {
  if (row.stoppable) return null;
  return row.kind === "background-item"
    ? BACKGROUND_ITEM_STOP_REASON
    : UNREACHABLE_STOP_REASON;
}

/** The tone registry entry a prompt kind reads as. Browser hand-offs have no
 * tone of their own - they are a needs-action row whose subject is the browser,
 * so they borrow the approval color and keep the globe as their glyph, exactly
 * as the notification feed renders them.
 *
 * Mapped here rather than through `notificationFeedTone`, which resolves from a
 * whole `MergedNotificationRow` and returns `null` for the browser kind. If the
 * registry ever grows a browser tone, this mapping is what has to move. */
function promptTone(kind: FocusPromptKind): IndicatorTone {
  if (kind === "interview") return INTERVIEW_TONE;
  return APPROVAL_TONE;
}

function PromptGlyph(props: { readonly kind: FocusPromptKind }): ReactNode {
  const tone = promptTone(props.kind);
  const Icon = props.kind === "browser" ? Globe : tone.Icon;
  return (
    <Icon
      aria-hidden
      className={cn("size-4 shrink-0", tone.className)}
      data-testid="home-focus-prompt-glyph"
    />
  );
}

/** The attention glyph a task carries when something in it is waiting on the
 * user - the same registry the History rows and the tab strip read, so a task
 * that wants attention looks the same wherever it is listed. */
export function TaskAttentionGlyph(): ReactNode {
  const Icon = APPROVAL_TONE.Icon;
  return (
    <Icon
      aria-label="Needs your attention"
      role="img"
      className={cn("size-4 shrink-0", APPROVAL_TONE.className)}
      data-testid="home-focus-task-attention"
    />
  );
}

/**
 * The glyph an agent row carries, read off the SAME registry the epic tree and
 * the sidebars read (`EPIC_NODE_ICONS`): a chat is a `MessageSquare`, a
 * terminal agent is a `Bot`. A terminal agent is deliberately not a `Terminal`
 * - that glyph means "a shell" everywhere else on this page, and a TUI agent is
 * not one.
 *
 * `null` when the surface is unknown, which is every agent in a task no tile in
 * this window has open. A guessed glyph would be the one part of the row that
 * looks equally confident whether or not anything is known.
 */
export function AgentGlyph(props: {
  readonly surface: FocusAgentRow["surface"];
  readonly className: string;
}): ReactNode {
  if (props.surface === null) return null;
  const Icon = EPIC_NODE_ICONS[props.surface];
  return (
    <Icon
      aria-hidden
      className={cn("shrink-0 text-muted-foreground", props.className)}
      data-testid="home-focus-agent-glyph"
      data-surface={props.surface}
    />
  );
}

/**
 * A background row's glyph: the chat Background panel's own per-kind map for a
 * background item, and `Terminal` for a managed command.
 *
 * The map is shared rather than restated (`lib/chat/background-kind-icon.ts`),
 * because the two surfaces list the same objects - a sub-agent that is a `Bot`
 * in the chat has to be a `Bot` here. The managed-command case is not in that
 * map on purpose: it is a durable shell the host owns across turns, not a node
 * of a turn, and `Terminal` is what that plane has always read as.
 */
export function BackgroundGlyph(props: {
  readonly row: FocusBackgroundRow;
}): ReactNode {
  const Icon =
    props.row.itemKind === null
      ? Terminal
      : BACKGROUND_KIND_ICONS[props.row.itemKind];
  return (
    <Icon
      aria-hidden
      className="size-4 shrink-0 text-muted-foreground"
      data-testid="home-focus-background-glyph"
      data-item-kind={props.row.itemKind}
    />
  );
}

/**
 * Names the machine a prompt came from, and only when that is not THIS
 * machine - on a single-host install the chip never renders.
 *
 * Compared against the local host rather than the app-wide effective one, the
 * same call `notification-row` makes for pack attribution: an origin-bound
 * prompt has to be acted on where it was raised, so "not the machine you are
 * sitting at" is the fact worth a chip. It also keeps this row out of the
 * app-wide host-read layer, which Home is not part of. A build with no local
 * host (the browser client) can't tell the two apart and shows nothing rather
 * than chipping every row.
 */
function OriginHostChip(props: {
  readonly originHostId: string | null;
}): ReactNode {
  const grouped = useHomeHostGrouped();
  const localHost = useReactiveLocalHostEntry();
  const entry = useHostDirectoryEntry(props.originHostId);
  // Under a host subheading the pill is the heading's own sentence repeated on
  // every row beneath it.
  if (grouped) return null;
  if (props.originHostId === null) return null;
  if (localHost === null) return null;
  if (props.originHostId === localHost.hostId) return null;
  return (
    <span
      className="shrink-0 rounded-sm bg-foreground/8 px-1.5 py-0.5 text-ui-xs text-muted-foreground"
      data-testid="home-focus-origin-host"
    >
      {entry === null ? "another host" : entry.label}
    </span>
  );
}

export function HomeFocusPromptRow(props: {
  readonly row: FocusPromptRow;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { row, actions } = props;
  const density = useHomeDensity();
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-prompt-row"
    >
      <button
        type="button"
        onClick={() => actions.openPrompt(row)}
        className={ROW_BODY_CLASS}
        data-testid="home-focus-prompt-open-body"
      >
        <PromptGlyph kind={row.kind} />
        {/* The prompt's own text LEADS: it is what the row is, and what the
            user decides from. The task it belongs to follows as context, which
            is the inverse of how this row read before - task first, prompt
            second, the two running together. */}
        <RowItemName testId="home-focus-row-name">
          {row.title}
          {row.body === "" ? null : (
            <span className="text-muted-foreground"> — {row.body}</span>
          )}
        </RowItemName>
        {/* The browser tab comes BEFORE the task, because it is the nearer
            context - "Needs you in the browser · Checkout · in Storefront"
            names the page first and the task it belongs to second, the same
            nearest-first order a job row's chat and task follow. It is present
            only where the plane has the tab, which is the same mounted-only
            limit the Browsers section carries. */}
        <RowContext
          parts={[
            // No `in`: the tab is not somewhere the prompt lives, it is the
            // page the prompt is about.
            {
              role: "browser-tab",
              title: row.browserTabTitle,
              preposition: null,
            },
            { role: "task", title: row.taskTitle, preposition: "in" },
          ]}
          testId="home-focus-row-context"
        />
        <OriginHostChip originHostId={row.originHostId} />
      </button>
      <RowStatus
        state="needs-you"
        detail={<RowStatusDuration startedAtMs={row.createdAt} />}
      />
      {/* Nothing to stop, and the track is reserved anyway: this row has to
          spend the same width on actions as the rows around it, or their
          status column moves relative to this one. */}
      <RowActionsCell>{null}</RowActionsCell>
    </li>
  );
}

/**
 * The one stop control every row uses.
 *
 * Follows the house pending contract (`gui-app/CLAUDE.md`, Backend calls) and
 * the reference `AgentStopButton`: disabled while the stop is in flight, the
 * label unchanged, an inline spinner beside it. A stop that cannot be routed
 * renders disabled with a reason rather than vanishing, so the row still
 * accounts for work it cannot end from here. The `<span>` wrapper is what
 * carries the tooltip - a disabled button fires no pointer events.
 *
 * The reason also joins the accessible NAME rather than living only in the
 * tooltip. A Radix tooltip mounts on hover, so on the one control that can
 * never be hovered into usefulness - a disabled one - it is exactly the reader
 * who cannot hover that would be left with an unexplained dead button.
 */
function FocusStopButton(props: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly reason: string | null;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onClick: () => void;
  readonly testId: string;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.reason}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            props.reason === null
              ? props.ariaLabel
              : `${props.ariaLabel}. ${props.reason}`
          }
          disabled={props.disabled}
          onClick={props.onClick}
          data-testid={props.testId}
        >
          {/* The spinner REPLACES a resting glyph rather than appearing beside
              the label, so the button keeps its width the moment a stop starts
              and the row's trailing cluster does not jump. Same shape as
              `StopButtonShell`. */}
          {props.pending ? (
            <AgentSpinningDots
              className="size-3"
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <Square aria-hidden className="size-3" />
          )}
          {props.label}
        </Button>
      </span>
    </TooltipWrapper>
  );
}

/**
 * The agents "Stop all" actually calls: every listed agent that no OTHER
 * listed agent parents.
 *
 * `FocusTaskRow.agents` is flat - parents and children alike - and each stop
 * cascades, so calling once per listed agent would issue N RPCs where the
 * first already tore the whole subtree down, and the rest would address agents
 * the host had just stopped (up to N-1 spurious "Couldn't stop agent." toasts
 * after a stop that fully succeeded). `parentId === null` means "root OR
 * unknown", so an agent whose parentage we cannot see is still stopped - the
 * safe direction.
 */
function stopAllRoots(
  agents: ReadonlyArray<FocusAgentRow>,
): ReadonlyArray<FocusAgentRow> {
  const listed = new Set(agents.map((agent) => agent.agentId));
  return agents.filter(
    (agent) => agent.parentId === null || !listed.has(agent.parentId),
  );
}

export function ActivityDot(props: {
  readonly tier: FocusAgentRow["tier"];
}): ReactNode {
  return (
    <span
      aria-hidden
      data-testid="home-focus-activity-dot"
      data-tier={props.tier}
      className={cn(
        "size-2 shrink-0 rounded-full",
        props.tier === "turn" ? "bg-primary" : "bg-muted-foreground",
      )}
    />
  );
}

/** A task's tier at a glance: any agent taking a turn makes the task a turn. */
function taskTier(agents: ReadonlyArray<FocusAgentRow>): FocusAgentRow["tier"] {
  return agents.some((agent) => agent.tier === "turn") ? "turn" : "background";
}

function AgentChip(props: {
  readonly epicId: string;
  readonly agent: FocusAgentRow;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { epicId, agent, actions } = props;
  const name = focusAgentDisplayName(agent);
  return (
    <button
      type="button"
      onClick={() => actions.openAgent(epicId, agent.agentId)}
      className="relative flex min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid="home-focus-agent-chip"
      data-agent-id={agent.agentId}
    >
      <ActivityDot tier={agent.tier} />
      <AgentGlyph surface={agent.surface} className="size-3" />
      <span className="truncate text-foreground">{name}</span>
      {/* Through the shared registry rather than `agent.tier` directly: the
          chip and the status column say the same word about the same agent,
          and routing both through one table is what keeps that true. */}
      <span className="shrink-0 text-ui-xs text-muted-foreground">
        {FOCUS_ROW_STATES[focusAgentState(agent)].word}
      </span>
    </button>
  );
}

/** What a cold task can say about itself: a count and a tier, with no names,
 * because agent titles only exist for epics mounted in this window. */
export function ColdTaskAgents(props: {
  readonly agents: ReadonlyArray<FocusAgentRow>;
}): ReactNode {
  const count = props.agents.length;
  const tier = taskTier(props.agents);
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      data-testid="home-focus-cold-agents"
    >
      <ActivityDot tier={tier} />
      <span className="shrink-0 text-foreground">
        {count === 1 ? "1 agent" : `${count} agents`}
      </span>
      <span className="truncate text-ui-xs text-muted-foreground">
        {tier} · not open in this window
      </span>
    </span>
  );
}

export function HomeFocusTaskRow(props: {
  readonly row: FocusTaskRow;
  readonly actions: HomeFocusRowActions;
  /**
   * Whether this window shows background rows for this task, which decides
   * whether a background-tier agent is a DUPLICATE of a job row or the only
   * trace of it. See `focus-running.ts`.
   */
  readonly hasVisibleJobs: boolean;
  /** See `HomeFocusTaskStopCluster.hostLabel`. */
  readonly stopAllHostLabel: string | null;
}): ReactNode {
  const { row, actions } = props;
  const density = useHomeDensity();
  const title = focusTaskTitleOf(row.taskTitle);
  const agents = visibleAgents(row.agents, props.hasVisibleJobs);
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-task-row"
    >
      <button
        type="button"
        onClick={() => actions.openTask(row.epicId)}
        className={cn(ROW_BODY_CLASS, "flex-initial")}
        data-testid="home-focus-task-open-body"
      >
        {row.needsYou ? (
          <TaskAttentionGlyph />
        ) : (
          <Layers
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <RowItemName testId="home-focus-row-name">{title}</RowItemName>
      </button>
      {/* Deliberately NOT `relative`: the body button's stretched overlay must
          stay above this container so a click on the row's blank space opens
          the task, while each chip's own `relative` lifts it back above the
          overlay. */}
      <div className={homeChipRowClass(density)}>
        {row.mountedHere ? (
          agents.map((agent) => (
            <AgentChip
              key={agent.agentId}
              epicId={row.epicId}
              agent={agent}
              actions={actions}
            />
          ))
        ) : (
          <ColdTaskAgents agents={row.agents} />
        )}
      </div>
      <RowStatus state={focusTaskState(row, 0)} detail={null} />
      <HomeFocusTaskStopCluster
        row={row}
        actions={actions}
        hostLabel={props.stopAllHostLabel}
      />
    </li>
  );
}

/**
 * A task's stop control and the confirmation it may open, as one unit.
 *
 * Both views mount it, which is why the confirm state lives here rather than in
 * either row: the dialog belongs to the decision, not to the shape of the row
 * that offered it.
 */
export function HomeFocusTaskStopCluster(props: {
  readonly row: FocusTaskRow;
  readonly actions: HomeFocusRowActions;
  /** Named when this row is one machine's share of a task worked from several,
   * so the button says whose agents it ends. `null` when the row IS the task. */
  readonly hostLabel: string | null;
}): ReactNode {
  const { row, actions } = props;
  const [confirmingStopAll, setConfirmingStopAll] = useState<boolean>(false);
  return (
    <>
      <RowActionsCell>
        <TaskStopControl
          row={row}
          actions={actions}
          hostLabel={props.hostLabel}
          onRequestStopAll={() => setConfirmingStopAll(true)}
        />
      </RowActionsCell>
      <StopAllDialog
        row={row}
        open={confirmingStopAll}
        onOpenChange={setConfirmingStopAll}
        onConfirm={() => {
          setConfirmingStopAll(false);
          for (const agent of stopAllRoots(row.agents)) {
            actions.stopAgent({
              epicId: row.epicId,
              agentId: agent.agentId,
              hostId: agent.hostId,
              cascade: true,
            });
          }
        }}
      />
    </>
  );
}

/**
 * One running agent stops directly; several stop through a confirmation.
 *
 * The asymmetry is about the dialog, not the blast radius: every stop cascades
 * (`cascade: true`), the way every other stop in the app does, so a user who
 * learned the gesture in chat gets the same behaviour here. What the second
 * form adds is a list - "Stop all" reaches subtrees the row does not name, and
 * the confirmation is where they are named.
 */
function TaskStopControl(props: {
  readonly row: FocusTaskRow;
  readonly actions: HomeFocusRowActions;
  readonly hostLabel: string | null;
  readonly onRequestStopAll: () => void;
}): ReactNode {
  const { row, actions } = props;
  const title = focusTaskTitleOf(row.taskTitle);
  if (row.agents.length === 0) return null;
  const reason = row.stoppable ? null : UNREACHABLE_STOP_REASON;
  const only = row.agents.length === 1 ? row.agents[0] : undefined;
  if (only !== undefined) {
    const pending = actions.stopping.has(only.agentId);
    return (
      <FocusStopButton
        label="Stop"
        ariaLabel={`Stop ${focusAgentDisplayName(only)} in ${title}`}
        reason={reason}
        disabled={pending || !row.stoppable}
        pending={pending}
        onClick={() =>
          actions.stopAgent({
            epicId: row.epicId,
            agentId: only.agentId,
            hostId: only.hostId,
            cascade: true,
          })
        }
        testId="home-focus-task-stop"
      />
    );
  }
  // Gated on the roots, because those are the calls this button issues.
  const pending = stopAllRoots(row.agents).some((agent) =>
    actions.stopping.has(agent.agentId),
  );
  // The label names the machine only when the row is one host's SHARE of a
  // task: two `Stop all` buttons on two rows of the same task would otherwise
  // be indistinguishable, and each ends a different set of agents.
  const scope = props.hostLabel === null ? null : ` on ${props.hostLabel}`;
  return (
    <FocusStopButton
      label={scope === null ? "Stop all" : `Stop all${scope}`}
      ariaLabel={`Stop all agents in ${title}${scope ?? ""}`}
      reason={reason}
      disabled={pending || !row.stoppable}
      pending={pending}
      onClick={props.onRequestStopAll}
      testId="home-focus-task-stop-all"
    />
  );
}

function StopAllDialog(props: {
  readonly row: FocusTaskRow;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const { row } = props;
  const title = focusTaskTitleOf(row.taskTitle);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="home-focus-stop-all-dialog"
      >
        <DialogHeader>
          <DialogTitle>Stop all agents in {title}?</DialogTitle>
          <DialogDescription>
            This stops the agents below and anything they started.
          </DialogDescription>
        </DialogHeader>
        <ul
          className="flex flex-col gap-1 text-ui-sm text-foreground"
          data-testid="home-focus-stop-all-list"
        >
          {row.agents.map((agent) => (
            <li key={agent.agentId} className="flex items-center gap-2">
              <ActivityDot tier={agent.tier} />
              <span className="truncate">{focusAgentDisplayName(agent)}</span>
              <span className="shrink-0 text-ui-xs text-muted-foreground">
                {agent.tier}
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => props.onOpenChange(false)}
            data-testid="home-focus-stop-all-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={props.onConfirm}
            data-testid="home-focus-stop-all-confirm"
          >
            Stop all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HomeFocusBackgroundRow(props: {
  readonly row: FocusBackgroundRow;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { row, actions } = props;
  const density = useHomeDensity();
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-background-row"
    >
      <button
        type="button"
        onClick={() => actions.openBackground(row)}
        className={ROW_BODY_CLASS}
        data-testid="home-focus-background-open-body"
      >
        <BackgroundGlyph row={row} />
        {/* The job's own name first, then the conversation hosting it, then
            that conversation's task. Three different things, three nodes, two
            tones - the row this replaced put the task and the job side by side
            in the same weight and read as one name. */}
        <RowItemName testId="home-focus-row-name">{row.label}</RowItemName>
        <RowContext
          parts={[
            { role: "chat", title: row.chatTitle, preposition: "in" },
            // `in` belongs to the FIRST location actually rendered, and a part
            // with no title is dropped - so on a job whose chat this window
            // cannot name, the task is that first location and takes the word.
            // Without this the row read `· Storefront`, which names a place and
            // does not say the job is in it.
            {
              role: "task",
              title: row.taskTitle,
              preposition: row.chatTitle === null ? "in" : null,
            },
          ]}
          testId="home-focus-row-context"
        />
      </button>
      <RowStatus
        state={focusJobState(row)}
        detail={
          row.startedAtMs === null ? null : (
            <RowStatusDuration startedAtMs={row.startedAtMs} />
          )
        }
      />
      <RowActionsCell>
        <FocusStopButton
          label="Stop"
          ariaLabel={`Stop ${row.label}`}
          reason={backgroundStopReason(row)}
          disabled={actions.stopping.has(row.key) || !row.stoppable}
          pending={actions.stopping.has(row.key)}
          onClick={() => actions.stopManagedCommand(row)}
          testId="home-focus-background-stop"
        />
      </RowActionsCell>
    </li>
  );
}

/**
 * What a browser tab IS: its page title, then the site it is on.
 *
 * Two nodes in two tones rather than one string, the same grammar every other
 * row follows - a title and a hostname run together read as one odd name. The
 * url host is dropped by the model when it would only repeat the title, which
 * is the stale-title case, so this renders whatever it is given.
 */
export function BrowserTabName(props: {
  readonly row: FocusBrowserRow;
}): ReactNode {
  return (
    <>
      <RowItemName testId="home-focus-row-name">{props.row.title}</RowItemName>
      {props.row.urlHost === null ? null : (
        <span
          className="min-w-0 shrink truncate text-ui-xs text-muted-foreground"
          data-testid="home-focus-browser-url-host"
        >
          {props.row.urlHost}
        </span>
      )}
    </>
  );
}

/** `driven by <agent>`, when a conversation is working this page right now. */
export function BrowserStatusDetail(props: {
  readonly row: FocusBrowserRow;
}): ReactNode {
  if (props.row.drivenByAgentName === null) return null;
  return <RowStatusNote text={`driven by ${props.row.drivenByAgentName}`} />;
}

/**
 * One browser tab, and the click that goes there.
 *
 * The row body routes through the browser-session deep link, which focuses the
 * parked tile wherever it already is and opens the task on it otherwise - the
 * same path the bell's own browser hand-off takes, so a tab reached from Home
 * lands exactly where a tab reached from a notification does.
 *
 * NO stop control, and the actions cell is reserved anyway: closing a tab is a
 * canvas action on the tile, and every row on this page has to spend the same
 * width on actions or the status column above it moves.
 */
export function HomeFocusBrowserRow(props: {
  readonly row: FocusBrowserRow;
  readonly actions: HomeFocusRowActions;
}): ReactNode {
  const { row, actions } = props;
  const density = useHomeDensity();
  return (
    <li
      className={homeRowClass(density)}
      data-density={density}
      data-testid="home-focus-browser-row"
      data-status={row.status}
    >
      {/* The full url, which the row deliberately does not spend a line on:
          the host is what identifies a page at a glance, the path is what you
          check when you are unsure it is the right one. `asChild`, so the
          tooltip adds no node between the `<li>` and its body button and the
          row's grid is untouched. */}
      <TooltipWrapper
        label={row.url}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          type="button"
          onClick={() => actions.openBrowser(row)}
          className={ROW_BODY_CLASS}
          data-testid="home-focus-browser-open-body"
        >
          <Globe
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
          <BrowserTabName row={row} />
          <RowContext
            parts={[{ role: "task", title: row.taskTitle, preposition: "in" }]}
            testId="home-focus-row-context"
          />
        </button>
      </TooltipWrapper>
      <RowStatus
        state={focusBrowserState(row)}
        detail={<BrowserStatusDetail row={row} />}
      />
      <RowActionsCell>{null}</RowActionsCell>
    </li>
  );
}
