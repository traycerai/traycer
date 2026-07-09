import { useCallback, type ReactNode } from "react";
import { v4 as uuidv4 } from "uuid";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AgentStopButton } from "@/components/chat/agent-stop-button";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";

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
  readonly self: AgentRow;
  readonly descendants: ReadonlyArray<AgentRow>;
  readonly surface: "composer-panel" | "tui-popover";
}) {
  const compact = props.surface === "composer-panel";
  const tileNavigation = useEpicTileNavigation();
  // Opening a sub-agent reuses the same path as the agent-reference chip:
  // resolve the epic's target tab and open (or focus) the agent's tile there.
  const openAgent = useCallback(
    (agent: AgentRow) => {
      tileNavigation.openTileInEpic(props.epicId, {
        id: agent.id,
        instanceId: uuidv4(),
        type: nodeKindForSurface(agent.surface),
        name: agent.title,
        hostId: agent.hostId,
      });
    },
    [props.epicId, tileNavigation],
  );
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
      <li className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 px-2 py-1">
        <ActivityDot active={props.self.active} />
        <span className="block min-w-0 flex-1 truncate text-ui-xs font-medium text-foreground/85">
          {props.self.title}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
          {props.self.surface}
        </span>
        {/* The current agent's "Stop all" stays visible - it is the primary
            action and keeps the parent row from looking stop-less. */}
        <AgentStopButton
          epicId={props.epicId}
          agentId={props.self.id}
          hostId={props.self.hostId}
          label="Stop all"
          iconOnly={compact}
          testId="agent-stop-all"
        />
      </li>
      {props.descendants.map((agent) => (
        <li
          key={agent.id}
          className="group flex min-w-0 items-center gap-2 rounded-md pl-5 pr-2 hover:bg-muted/40"
        >
          <button
            type="button"
            onClick={() => openAgent(agent)}
            title={`Open ${agent.title}`}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ActivityDot active={agent.active} />
            <span className="block min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
              {agent.title}
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
              {agent.surface}
            </span>
          </button>
          <StopAffordance revealOnHover={compact}>
            <AgentStopButton
              epicId={props.epicId}
              agentId={agent.id}
              hostId={agent.hostId}
              label="Stop"
              iconOnly={compact}
              testId={undefined}
            />
          </StopAffordance>
        </li>
      ))}
    </ul>
  );
}
