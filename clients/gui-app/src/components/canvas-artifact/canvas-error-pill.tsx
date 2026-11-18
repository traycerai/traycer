import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";

export function CanvasErrorPill({
  error,
  onAdd,
}: {
  readonly error: CanvasPageError | null;
  readonly onAdd: (() => void) | null;
}) {
  if (error === null) return null;
  return (
    <div className="touch-auto flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="status"
            className="flex min-w-0 items-center gap-1 rounded border border-destructive/30 bg-destructive/10 px-1 text-ui-xs text-destructive"
          >
            <AlertCircle className="size-3 shrink-0" />
            <span className="truncate">{error.message.slice(0, 80)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{error.message}</TooltipContent>
      </Tooltip>
      {onAdd === null ? null : (
        <Button type="button" variant="ghost" size="xs" onClick={onAdd}>
          Add to chat
        </Button>
      )}
    </div>
  );
}
