/**
 * Picks which renderer draws the communication graph: the office floor or the
 * node graph.
 *
 * A segmented control rather than an icon that cycles: both renderings are
 * first-class and neither is a "detail" of the other, so the control names them
 * and shows which one is live. It floats over the canvas in BOTH modes - the
 * way back has to be visible from wherever you are.
 */
import { Building2, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CommGraphTileViewState } from "@/stores/epics/canvas/types";

export type CommGraphViewMode = CommGraphTileViewState["mode"];

export interface CommGraphViewModeToggleProps {
  readonly mode: CommGraphViewMode;
  readonly onModeChange: (mode: CommGraphViewMode) => void;
}

interface ModeOption {
  readonly mode: CommGraphViewMode;
  readonly label: string;
  readonly testId: string;
  readonly Icon: typeof Building2;
}

const MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  {
    mode: "office",
    label: "Office",
    testId: "comm-graph-mode-office",
    Icon: Building2,
  },
  {
    mode: "graph",
    label: "Graph",
    testId: "comm-graph-mode-graph",
    Icon: Waypoints,
  },
];

export function CommGraphViewModeToggle(props: CommGraphViewModeToggleProps) {
  const { mode, onModeChange } = props;
  return (
    <div
      className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 shadow-xs"
      data-testid="comm-graph-mode-toggle"
    >
      {MODE_OPTIONS.map((option) => {
        const active = option.mode === mode;
        return (
          <Button
            key={option.mode}
            type="button"
            size="xs"
            variant="ghost"
            // `aria-pressed` rather than a radio group: each button is a toggle
            // whose pressed state is the whole state, and assistive tech reads
            // the pair correctly without a group label to invent.
            aria-pressed={active}
            data-testid={option.testId}
            // An alpha of the foreground, so the active segment stays visible
            // on every preset - `--muted` collapses into `--popover` in the
            // dark and flat-light presets, which is exactly this surface.
            className={cn(active && "bg-foreground/8 text-foreground")}
            onClick={() => onModeChange(option.mode)}
          >
            <option.Icon data-icon="inline-start" aria-hidden />
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
