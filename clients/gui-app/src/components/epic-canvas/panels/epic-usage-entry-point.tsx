import { useState, type ReactNode } from "react";
import { LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { StatusRowChromeBoundary } from "@/components/epic-canvas/panels/status-row-chrome-boundary";
import { EpicUsageDialog } from "@/components/epic-canvas/panels/epic-usage-dialog";
import { cn } from "@/lib/utils";

/**
 * The status row sits above the per-tile `TabHostProvider` scope, so a tab binding is genuinely unavailable here - but "outside a tab" does not make the app-wide host the right answer, and reading it was a defect with a visible failure: activation or failover moves the effective host from A to B while `EpicSessionProvider` is still rendering its retained A session (the whole of a re-point that is establishing, and after one that failed), during which only the CANVAS is made inert - this row stays interactive.
 * FAILS CLOSED on a null session host rather than following: passing `null` to `useHostClientForHostId` resolves the EFFECTIVE host's client, so a "no session yet" render would silently reproduce the defect instead of hiding.
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
  const hostId = useEpicSessionHostId();
  const client = useHostClientForHostId(hostId);
  const supported = useUsageSummarySupported(hostId);
  const [open, setOpen] = useState(false);

  if (hostId === null || !supported) return null;

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
