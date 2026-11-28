/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ The notices strip).
 * Update that file whenever this settings surface changes.
 */
import type { ComponentProps, ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HostUpdateDrainGateRow } from "@/components/settings/host-scope/host-registry-updates";
import { HostOverviewOperationCard } from "@/components/settings/panels/host-overview-operation-card";

/**
 * The strip between the Overview's header and its tab bar: what is happening
 * to this host right now, on every tab.
 *
 * Top to bottom and only while each applies: the offline notice, the update
 * card (the host's own report) and the account's wait on open work. At rest
 * it draws nothing, so a healthy, current host's header sits directly on the
 * tab bar. There is only ever one wait on screen: the panel withholds the
 * account's once the host reports a wait of its own.
 *
 * Every piece is resolved by the panel - the page owns the queries, the
 * mutations and the dialogs these controls open - and arrives here as the
 * props of the component that draws it, or `null` where the page withholds it.
 */
export interface HostOverviewNoticesProps {
  /**
   * The offline notice's sentence, or `null`. Set only while the host can't be
   * reached for a reason other than a restart, and then it is the strip's only
   * unreachable wording: the update card is withheld, and the notice carries
   * the phase that card would have retained.
   */
  readonly offlineNotice: string | null;
  /**
   * Reads the host's status again, drawn beside the offline notice, while a
   * failed status read is why Settings shows the host from its row alone.
   */
  readonly offlineRetry: (() => void) | null;
  /**
   * The update operation the host reports, or `null` for none. A QUIET view
   * is `null` too: the card is for an operation, and when there is none the
   * answer card on Updates is the whole story (the landing banner hides on
   * the same predicate).
   */
  readonly operation: ComponentProps<typeof HostOverviewOperationCard> | null;
  /**
   * The account's wait ("Waiting for 2 agents", Apply now). `null` for a host
   * with no account registry row, while the host can't be reached (it names
   * live work), and once the host reports a wait of its own.
   */
  readonly drainGate: ComponentProps<typeof HostUpdateDrainGateRow> | null;
}

export function HostOverviewNotices(
  props: HostOverviewNoticesProps,
): ReactNode {
  if (
    props.offlineNotice === null &&
    props.offlineRetry === null &&
    props.operation === null &&
    props.drainGate === null
  ) {
    return null;
  }
  const retry =
    props.offlineRetry === null ? null : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.offlineRetry}
        data-testid="host-overview-offline-retry"
      >
        Try again
      </Button>
    );
  return (
    // `shrink-0`: on desktop it is pinned with the header rather than scrolled
    // away with a tab body, since its controls (Restart, Force update…, Apply
    // now) are the page's only ones with deadlines. On a phone the page
    // scrolls as one, and this scrolls with the header.
    <div
      className="flex shrink-0 flex-col gap-2 px-5 pb-3"
      data-testid="host-overview-notices"
    >
      {props.offlineNotice === null ? (
        retry
      ) : (
        <div
          className="flex items-start gap-2 rounded-md border border-border/60 bg-foreground/3 px-3 py-2.5 text-ui-sm text-muted-foreground"
          data-testid="host-overview-offline-notice"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{props.offlineNotice}</span>
          {retry}
        </div>
      )}
      {props.operation === null ? null : (
        <HostOverviewOperationCard {...props.operation} />
      )}
      {props.drainGate === null ? null : (
        <HostUpdateDrainGateRow {...props.drainGate} />
      )}
    </div>
  );
}
