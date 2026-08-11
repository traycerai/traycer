import { useState, type ReactNode } from "react";
import { LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostClient } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { StatusRowChromeBoundary } from "@/components/epic-canvas/panels/status-row-chrome-boundary";
import { EpicUsageDialog } from "@/components/epic-canvas/panels/epic-usage-dialog";
import { cn } from "@/lib/utils";

/**
 * Ticket 12: replaces the ambient epic cost badge (ticket 7 + fixup-01).
 * User ruling - "too in the face", and the one surface showing a dollar
 * figure without its qualifier visible - so this renders NO number at all,
 * just a numberless entry point that opens the scoped epic panel
 * (`EpicUsageDialog`) on click. Cost is on-demand by construction now: there
 * is no ambient query here to silently revert, which is what fixup-01 had
 * to work around for the old badge.
 *
 * The fixup-01 PLUMBING itself stays - `useUsageSummaryForClient`'s
 * `enabled`/`poll` params, `StatusRowChromeBoundary` - just with no ambient
 * consumer of `poll: true` left in this file; the dialog opens the query
 * on-demand with `poll: false`, matching every other actively-viewed usage
 * surface.
 *
 * App-wide host access (`useReactiveActiveHostId`/`useHostClient`), not
 * `useTabHostId` - this status row sits above the per-tile `TabHostProvider`
 * scope, same as its siblings.
 */
export function EpicUsageEntryPoint(props: {
  readonly epicId: string;
}): ReactNode {
  return (
    <StatusRowChromeBoundary label="usage entry point">
      <EpicUsageEntryPointBody epicId={props.epicId} />
    </StatusRowChromeBoundary>
  );
}

function EpicUsageEntryPointBody(props: {
  readonly epicId: string;
}): ReactNode {
  const hostId = useReactiveActiveHostId();
  const client = useHostClient();
  const supported = useUsageSummarySupported(hostId);
  const [open, setOpen] = useState(false);

  if (!supported) return null;

  return (
    <>
      <TooltipWrapper
        label="Usage"
        side="bottom"
        sideOffset={undefined}
        align="end"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Usage"
          aria-haspopup="dialog"
          data-testid="epic-usage-entry-point"
          className={cn("text-muted-foreground hover:text-foreground")}
          onClick={() => setOpen(true)}
        >
          <LineChart className="size-3.5" />
        </Button>
      </TooltipWrapper>
      <EpicUsageDialog
        epicId={props.epicId}
        client={client}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
