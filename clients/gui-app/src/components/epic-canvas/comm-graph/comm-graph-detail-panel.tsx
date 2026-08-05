/**
 * The canvas's ONE detail surface: a header plus a chronological list of raw
 * captured events.
 *
 * Two things open it - clicking a pair edge, and clicking an agent node - and
 * they are siblings by construction rather than by resemblance: same shell, same
 * row grammar, same markdown bodies, only the header and the event set differ.
 * Exactly one is open at a time; opening either replaces the other.
 *
 * WHAT IT CAN HONESTLY SHOW is what the host captured: A2A messages and broker
 * notices. It is not a tool-call log, nor a record of what an agent DID, and
 * must not be labelled as either - an agent's turn is full of work that never
 * reaches this record.
 */
import { useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { CommGraphEvent } from "@/lib/comm-graph/comm-graph-events";
import { commGraphEventKey } from "@/lib/comm-graph/comm-graph-timeline";
import { CommGraphEventRow } from "@/components/epic-canvas/comm-graph/comm-graph-event-row";
import {
  pointerDragHandleAxisClassName,
  usePointerDragCommit,
} from "@/components/epic-canvas/canvas/use-pointer-drag-commit";
import {
  DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX,
  MAX_COMM_GRAPH_PANEL_WIDTH_PX,
  MIN_COMM_GRAPH_PANEL_WIDTH_PX,
  useCommGraphPanelStore,
  useCommGraphPanelWidthPx,
} from "@/stores/epics/comm-graph-panel-store";
import { cn } from "@/lib/utils";

export interface CommGraphDetailPanelProps {
  readonly title: ReactNode;
  /** Header affordances between the title and the close button. */
  readonly actions: ReactNode;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly events: ReadonlyArray<CommGraphEvent>;
  readonly epicId: string;
  readonly agentNames: ReadonlyMap<string, string>;
  readonly emptyLabel: string;
  readonly canOpenAgentForEvent: (event: CommGraphEvent) => boolean;
  readonly canJump: (event: CommGraphEvent) => boolean;
  readonly onJump: (event: CommGraphEvent) => void;
  /** Sender-side jump to the "Sent message" card - see `CommGraphJump`. */
  readonly canJumpToSender: (event: CommGraphEvent) => boolean;
  readonly onJumpToSender: (event: CommGraphEvent) => void;
  /** Created-row jump to the child's transcript start - see `CommGraphJump`. */
  readonly canJumpToCreated: (event: CommGraphEvent) => boolean;
  readonly onJumpToCreated: (event: CommGraphEvent) => void;
  /** Opens an agent's tile with no scroll - the sender-side heading link. */
  readonly onOpenAgentId: (agentId: string) => void;
  readonly onClose: () => void;
}

export function CommGraphDetailPanel(props: CommGraphDetailPanelProps) {
  const {
    actions,
    agentNames,
    ariaLabel,
    canOpenAgentForEvent,
    canJump,
    canJumpToCreated,
    canJumpToSender,
    emptyLabel,
    epicId,
    events,
    onClose,
    onJump,
    onJumpToCreated,
    onJumpToSender,
    onOpenAgentId,
    testId,
    title,
  } = props;
  const panelWidthPx = useCommGraphPanelWidthPx();
  return (
    <aside
      aria-label={ariaLabel}
      data-testid={testId}
      data-comm-graph-detail-panel
      // User-adjustable width (drag the left edge), persisted across tiles;
      // the `50%` cap mirrors the handle's live-drag cap so the canvas always
      // keeps space on a narrow tile.
      className="relative flex max-w-[50%] min-w-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width: panelWidthPx }}
    >
      <CommGraphPanelResizeHandle />
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-ui-sm font-medium text-foreground/90">
          {title}
        </span>
        {/* One action cluster, tight, so the header reads as title-then-actions
            rather than three separately-floating controls. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          <TooltipWrapper
            label="Close details"
            side="bottom"
            sideOffset={undefined}
            align={undefined}
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Close details"
              className="text-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          </TooltipWrapper>
        </div>
      </header>
      {events.length === 0 ? (
        <p
          data-testid={`${testId}-empty`}
          className="px-3 py-4 text-ui-xs text-muted-foreground"
        >
          {emptyLabel}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {events.map((event) => (
            <CommGraphEventRow
              key={commGraphEventKey(event)}
              event={event}
              epicId={epicId}
              agentNames={agentNames}
              testIdPrefix="comm-graph-detail"
              canOpenAgent={canOpenAgentForEvent(event)}
              canJump={canJump(event)}
              onJump={onJump}
              canJumpToSender={canJumpToSender(event)}
              onJumpToSender={onJumpToSender}
              canJumpToCreated={canJumpToCreated(event)}
              onJumpToCreated={onJumpToCreated}
              onOpenAgent={onOpenAgentId}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

interface PanelDragState {
  readonly startWidth: number;
  readonly maxWidth: number;
  readonly panelElement: HTMLElement;
  readonly initialStyleWidth: string;
  latestWidth: number;
}

/**
 * Live drag additionally caps the panel at half the tile so the canvas always
 * keeps space; the shell's render-time `max-w-[50%]` mirrors it.
 */
const MAX_PANEL_DRAG_FRACTION = 0.5;
const KEYBOARD_RESIZE_STEP_PX = 24;

function isDetailPanelElement(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.dataset.commGraphDetailPanel !== undefined
  );
}

/**
 * Width handle on the panel's LEFT edge, on the shared `usePointerDragCommit`
 * state machine - the same mechanics as the epic sidebar's handle with the
 * axis mirrored: the panel is docked RIGHT, so dragging left GROWS it and the
 * grow arrow key is ArrowLeft. Per-frame direct `style.width` mutation, one
 * store commit on release, double-click resets to the default width.
 */
function CommGraphPanelResizeHandle() {
  const panelWidthPx = useCommGraphPanelWidthPx();
  const setPanelWidthPx = useCommGraphPanelStore((s) => s.setPanelWidthPx);
  const dragRef = useRef<PanelDragState | null>(null);

  const sliderProps = usePointerDragCommit({
    axis: "horizontal",
    onDragStart: (event) => {
      const panelElement = event.currentTarget.parentElement;
      const container = panelElement?.parentElement ?? null;
      if (!isDetailPanelElement(panelElement) || container === null) {
        return false;
      }
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth <= 0) return false;
      const startWidth = panelElement.getBoundingClientRect().width;
      dragRef.current = {
        startWidth,
        maxWidth: Math.min(
          MAX_COMM_GRAPH_PANEL_WIDTH_PX,
          containerWidth * MAX_PANEL_DRAG_FRACTION,
        ),
        panelElement,
        initialStyleWidth: panelElement.style.width,
        latestWidth: startWidth,
      };
      return true;
    },
    onDragFrame: (deltaPx) => {
      const drag = dragRef.current;
      if (drag === null) return;
      // Right-docked: the pointer moving LEFT (negative delta) grows the panel.
      const nextWidth = Math.min(
        drag.maxWidth,
        Math.max(MIN_COMM_GRAPH_PANEL_WIDTH_PX, drag.startWidth - deltaPx),
      );
      drag.latestWidth = nextWidth;
      // Direct DOM mutation - zero React renders while the pointer moves.
      drag.panelElement.style.width = `${nextWidth}px`;
    },
    onDragCommit: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      setPanelWidthPx(drag.latestWidth);
    },
    onDragCancel: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag === null) return;
      drag.panelElement.style.width = drag.initialStyleWidth;
    },
    onReset: () => {
      setPanelWidthPx(DEFAULT_COMM_GRAPH_PANEL_WIDTH_PX);
    },
    onKeyNudge: (nudgeDirection) => {
      // Mirrored axis: ArrowRight (direction 1) SHRINKS a right-docked panel.
      setPanelWidthPx(panelWidthPx - nudgeDirection * KEYBOARD_RESIZE_STEP_PX);
    },
  });

  return (
    <div
      {...sliderProps}
      aria-valuenow={panelWidthPx}
      aria-valuemin={MIN_COMM_GRAPH_PANEL_WIDTH_PX}
      aria-valuemax={MAX_COMM_GRAPH_PANEL_WIDTH_PX}
      aria-label="Resize details panel"
      data-testid="comm-graph-detail-resize-handle"
      className={cn(
        "absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 ring-offset-background focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
        "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:border-l before:border-transparent before:transition-colors before:content-[''] hover:before:border-ring/50 focus-visible:before:border-ring/50",
        pointerDragHandleAxisClassName("horizontal"),
      )}
    />
  );
}
