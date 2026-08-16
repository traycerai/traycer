import { useDraggable } from "@dnd-kit/core";
import { useCallback, useId, useMemo, type ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AgentStopButton } from "@/components/chat/agent-stop-button";
import {
  ACTIVE_AGENT_DND_TYPE,
  getActiveAgentDragId,
  type EpicCanvasActiveAgentDragData,
} from "@/components/epic-canvas/dnd/dnd";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useMaybeEpicTuiAgentHarnessId } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";

/**
 * A row's `surface` is UI copy ("gui"/"tui"); opening a tile needs the
 * record-backed node kind. The two map 1:1 (the inverse of `surfaceOf` in
 * `use-agent-stop-controls`).
 */
function nodeKindForSurface(surface: "gui" | "tui"): "chat" | "terminal-agent" {
  return surface === "gui" ? "chat" : "terminal-agent";
}

function ActivityDot(props: { readonly active: boolean }) {
  if (props.active) {
    return (
      <AgentSpinningDots
        className="shrink-0 text-muted-foreground"
        testId={undefined}
        variant={undefined}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
    />
  );
}

/**
 * On-hover reveal wrapper for a row's stop button, mirroring the per-file Undo
 * affordance in the accumulated-changes panel: the button stays mounted (so
 * keyboard focus still reaches it) but is invisible until the row is hovered or
 * a descendant gains focus. When `revealOnHover` is false the button renders
 * inline and always visible (the TUI popover surface).
 */
function StopAffordance(props: {
  readonly revealOnHover: boolean;
  readonly children: ReactNode;
}) {
  if (!props.revealOnHover) return <>{props.children}</>;
  return (
    <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {props.children}
    </span>
  );
}

/**
 * One openable active-agent row. Its self-describing payload keeps the same
 * pane, empty-canvas, and header-tab behavior as the navigator while preserving
 * the agent's tab-bound host instead of consulting the app's active device.
 *
 * The drag id is occurrence-scoped because this is another rendering of a node
 * that is usually mounted in the sidebar at the same time. The trailing stop
 * action stays outside the drag/open button so stopping never starts a drag or
 * opens the tile.
 */
function AgentStopRow(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly agent: AgentRow;
  readonly self: boolean;
  readonly compact: boolean;
  readonly onOpen: (agent: AgentRow) => void;
}) {
  const { epicId, viewTabId, agent, self, compact, onOpen } = props;
  const occurrenceId = useId();
  const harnessId = useMaybeEpicTuiAgentHarnessId(agent.id);
  const dragData = useMemo<EpicCanvasActiveAgentDragData>(
    () => ({
      kind: ACTIVE_AGENT_DND_TYPE,
      epicId,
      viewTabId,
      agent: {
        id: agent.id,
        type: nodeKindForSurface(agent.surface),
        name: agent.title,
        hostId: agent.hostId,
        harnessId,
      },
    }),
    [
      agent.hostId,
      agent.id,
      agent.surface,
      agent.title,
      epicId,
      harnessId,
      viewTabId,
    ],
  );
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getActiveAgentDragId(occurrenceId),
    disabled: false,
    data: dragData,
  });
  const openAgent = useCallback(() => onOpen(agent), [agent, onOpen]);
  const cursorClass = isDragging ? "cursor-grabbing" : "cursor-grab";

  return (
    <li
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-md",
        self ? "bg-foreground/8 px-2" : "pl-5 pr-2 hover:bg-foreground/5",
        isDragging && "opacity-60",
      )}
    >
      <TooltipWrapper
        label={`Open ${agent.title}`}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <button
          ref={dragRef}
          {...attributes}
          {...listeners}
          type="button"
          aria-label={`Open ${agent.title}`}
          onClick={openAgent}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
            cursorClass,
          )}
        >
          <ActivityDot active={agent.active} />
          <span
            className={cn(
              "block min-w-0 flex-1 truncate text-ui-xs text-foreground/85",
              self && "font-medium",
            )}
          >
            {agent.title}
          </span>
          <span className="shrink-0 rounded bg-foreground/8 px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
            {agent.surface}
          </span>
        </button>
      </TooltipWrapper>
      {self ? (
        // The current agent's "Stop all" stays visible - it is the primary
        // action and keeps the parent row from looking stop-less.
        <AgentStopButton
          epicId={epicId}
          agentId={agent.id}
          hostId={agent.hostId}
          label="Stop all"
          iconOnly={compact}
          testId="agent-stop-all"
        />
      ) : (
        <StopAffordance revealOnHover={compact}>
          <AgentStopButton
            epicId={epicId}
            agentId={agent.id}
            hostId={agent.hostId}
            label="Stop"
            iconOnly={compact}
            testId={undefined}
          />
        </StopAffordance>
      )}
    </li>
  );
}

/**
 * Shared row list for both agent-stop surfaces. The current agent is the
 * topmost row; its active descendants follow, indented, each individually
 * stoppable. Keeping this in one place is what guarantees the two surfaces stay
 * consistent.
 *
 * Every row carries a trailing stop control occupying the same slot, so the
 * surface badges stay column-aligned regardless of which stops are visible. The
 * single `surface` prop drives the only presentation difference:
 *   - `composer-panel` uses compact icon-only stops; the current agent's
 *     "Stop all" stays visible (so the parent row never looks stop-less) while
 *     each descendant's stop reveals on hover (matching the accumulated-changes
 *     per-file Undo).
 *   - `tui-popover` uses labelled, always-visible stops on every row.
 */
export function AgentStopList(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly self: AgentRow;
  readonly descendants: ReadonlyArray<AgentRow>;
  readonly surface: "composer-panel" | "tui-popover";
}) {
  const compact = props.surface === "composer-panel";
  const tileNavigation = useEpicTileNavigation();
  const openAgent = useCallback(
    (agent: AgentRow) => {
      tileNavigation.openTileInTab(props.viewTabId, {
        id: agent.id,
        instanceId: uuidv4(),
        type: nodeKindForSurface(agent.surface),
        name: agent.title,
        hostId: agent.hostId,
      });
    },
    [props.viewTabId, tileNavigation],
  );
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
      <AgentStopRow
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        agent={props.self}
        self
        compact={compact}
        onOpen={openAgent}
      />
      {props.descendants.map((agent) => (
        <AgentStopRow
          key={agent.id}
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          agent={agent}
          self={false}
          compact={compact}
          onOpen={openAgent}
        />
      ))}
    </ul>
  );
}
