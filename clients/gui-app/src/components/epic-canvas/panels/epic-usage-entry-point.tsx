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
 * Resolves against the EPIC SESSION's host, not `useTabHostId` and not the
 * app-wide effective host. The status row sits above the per-tile
 * `TabHostProvider` scope, so a tab binding is genuinely unavailable here -
 * but "outside a tab" does not make the app-wide host the right answer, and
 * reading it was a defect with a visible failure: activation or failover moves
 * the effective host from A to B while `EpicSessionProvider` is still
 * rendering its retained A session (the whole of a re-point that is
 * establishing, and after one that failed), during which only the CANVAS is
 * made inert - this row stays interactive. The dialog then asked B for A's
 * `epicId` and showed another machine's usage, or an error.
 *
 * The Epic is the scope of the question this button answers, so the session's
 * host is the one that can answer it - the same rule the terminals sidebar
 * follows for `terminal.list` and for the same reason.
 *
 * FAILS CLOSED on a null session host rather than following: passing `null` to
 * `useHostClientForHostId` resolves the EFFECTIVE host's client, so a "no
 * session yet" render would silently reproduce the defect instead of hiding.
 * `supported` gates on the same id, so it already fails closed too; the
 * explicit check is here because that agreement is a property to state, not
 * one to inherit.
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
