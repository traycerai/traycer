import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";
import {
  describeUpdateOperation,
  operationProgressBytes,
  operationProgressPercent,
  showsProgressBar,
} from "@/components/home/host-update-operation-copy";
import {
  offersForceRestart,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import { cn } from "@/lib/utils";

/** The overflow Restart remains the secondary path to the same place, so a person is never required to engage
 * with this card to recover their host. */
export function HostOverviewOperationCard(props: {
  readonly view: FleetUpdateView;
  readonly hostName: string;
  /** Never restarts directly - the ellipsis on the button is a promise, and the confirmation is what re-reads
   * live work before anything happens. */
  readonly onForceRestart: () => void;
}): ReactNode {
  const { view } = props;
  const copy = describeUpdateOperation({ view, hostName: props.hostName });
  const percent = operationProgressPercent(view);
  const bytes = operationProgressBytes(view);
  const showProgress = showsProgressBar(view);
  return (
    <div
      // `aria-live` here rather than on a wrapper: phase changes should be announced, and a failure asserted.
      aria-live={copy.assertive ? "assertive" : "polite"}
      aria-label={copy.accessibleLabel}
      data-testid="host-overview-operation-card"
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2 text-ui-sm",
        // `bg-foreground/5`, never `bg-muted`: this card sits on the raised Overview surface, where every preset
        // theme's dark variant collapses `--muted` into the card colour and the fill would simply vanish.
        view.kind === "failed"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border/60 bg-foreground/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 flex-1"
          data-testid="host-overview-operation-phase"
        >
          {copy.primary}
          {/* `needsQualifiedMarker`, not `view.qualified` - a sentence that already reads "Last seen: …" must not also
             carry "(last known)". */}
          {copy.needsQualifiedMarker ? (
            <span
              className="ml-1 opacity-70"
              data-testid="host-overview-operation-qualified"
            >
              (last known)
            </span>
          ) : null}
        </span>
        {/* Measured bytes whenever the host reported them - including with no percentage, where the bar alone says
           nothing at all. */}
        {bytes === null ? null : (
          <span
            className="shrink-0 font-mono text-code-xs tabular-nums opacity-80"
            data-testid="host-overview-operation-bytes"
          >
            {bytes}
          </span>
        )}
        {percent === null ? null : (
          <span className="shrink-0 font-mono text-code-xs tabular-nums">
            {percent}%
          </span>
        )}
        {offersForceRestart(view) ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            className="shrink-0"
            onClick={props.onForceRestart}
            data-testid="host-overview-operation-force-restart"
          >
            Force restart…
          </Button>
        ) : null}
      </div>
      {showProgress ? (
        <UpdateProgressBar
          percent={percent}
          label={copy.accessibleLabel}
          className={undefined}
        />
      ) : null}
    </div>
  );
}
