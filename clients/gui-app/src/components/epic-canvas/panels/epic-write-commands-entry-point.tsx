import { useState, type ReactNode } from "react";
import { FileClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { StatusRowChromeBoundary } from "@/components/epic-canvas/panels/status-row-chrome-boundary";
import { EpicWriteCommandsDialog } from "@/components/epic-canvas/panels/epic-write-commands-dialog";
import { useEpicWriteCommands } from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";

/**
 * Status-row entry point for the write-command queue, present only while the
 * queue holds something.
 *
 * Deliberately NOT folded into the sync pill. The pill answers "can this window
 * claim your work is safe" and must stay one light with at most one label; this
 * answers "which change, and what do I do about it", which is a list and two
 * buttons. They read the same rows - the pill's input (v) is a fold of exactly
 * this queue - so they can never disagree about whether something is
 * outstanding, only about how much detail they show.
 */
export function EpicWriteCommandsEntryPoint(): ReactNode {
  return (
    <StatusRowChromeBoundary label="write commands entry point">
      <EpicWriteCommandsEntryPointBody />
    </StatusRowChromeBoundary>
  );
}

function EpicWriteCommandsEntryPointBody(): ReactNode {
  const commands = useEpicWriteCommands();
  const [open, setOpen] = useState(false);

  // Absent rather than disabled when there is nothing outstanding: an empty
  // queue is the ordinary state of every epic, and a permanent control for it
  // would be one more thing in the row that never does anything.
  if (commands.length === 0) return null;

  const label =
    commands.length === 1
      ? "1 pending change"
      : `${commands.length} pending changes`;

  return (
    <>
      <TooltipWrapper
        label={label}
        side="bottom"
        sideOffset={undefined}
        align="end"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-haspopup="dialog"
          data-testid="epic-write-commands-entry-point"
          className={cn("text-muted-foreground hover:text-foreground")}
          onClick={() => setOpen(true)}
        >
          <FileClock className="size-3.5" />
        </Button>
      </TooltipWrapper>
      <EpicWriteCommandsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
