import type { ComponentProps, ReactNode } from "react";
import { Info } from "lucide-react";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { HostUpdateDrainGateRow } from "@/components/settings/host-scope/host-registry-updates";
import { HostOverviewOperationCard } from "@/components/settings/panels/host-overview-operation-card";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import { HostOverviewVersionCard } from "@/components/settings/panels/host-overview-updates";

/**
 * Overview ▸ Status: is this host current, and updating it.
 *
 * At rest it is one version card. Above it, top to bottom and only while each
 * applies: the offline notice, the update card (the host's own report) and
 * the account's wait on open work. There is only ever one wait on screen: the
 * panel withholds the account's once the host reports a wait of its own.
 *
 * Every piece is resolved by the panel - the page owns the queries, the
 * mutations and the dialogs these controls open - and arrives here as the
 * props of the component that draws it, or `null` where the page withholds it.
 */
export interface HostOverviewStatusTabProps {
  /**
   * The offline notice's sentence, or `null`. Set only while the host can't be
   * reached for a reason other than a restart, and then it is the tab's only
   * unreachable wording: the update card is withheld, and the notice carries
   * the phase that card would have retained.
   */
  readonly offlineNotice: string | null;
  /**
   * The update operation the host reports, or `null` for none. A QUIET view
   * is `null` too: the card is for an operation, and when there is none the
   * version card below is the whole story (the landing banner hides on the
   * same predicate).
   */
  readonly operation: ComponentProps<typeof HostOverviewOperationCard> | null;
  /**
   * The account's wait ("Waiting for 2 agents", Apply now). `null` for a host
   * with no account registry row, while the host can't be reached (it names
   * live work), and once the host reports a wait of its own.
   */
  readonly drainGate: ComponentProps<typeof HostUpdateDrainGateRow> | null;
  /**
   * The version card, or `null` while the scope is still connecting with no
   * update retained - the loading shape stands in its place then.
   */
  readonly versionCard: ComponentProps<typeof HostOverviewVersionCard> | null;
  /**
   * The host's name while the scope is still connecting, `null` otherwise:
   * the loading shape's subject.
   */
  readonly connectingHostName: string | null;
}

export function HostOverviewStatusTab(
  props: HostOverviewStatusTabProps,
): ReactNode {
  return (
    <div data-testid="host-overview-status-tab">
      <HostOverviewTabSections>
        {props.offlineNotice === null ? null : (
          <div
            className="flex items-start gap-2 rounded-md border border-border/60 bg-foreground/3 px-3 py-2.5 text-ui-sm text-muted-foreground"
            data-testid="host-overview-offline-notice"
          >
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{props.offlineNotice}</span>
          </div>
        )}
        {props.operation === null ? null : (
          <HostOverviewOperationCard {...props.operation} />
        )}
        {/* The only control on the page with a deadline - it renders solely
            while an update is blocked on open sessions - so it sits on the tab
            the page opens on, never behind a click. */}
        {props.drainGate === null ? null : (
          <HostUpdateDrainGateRow {...props.drainGate} />
        )}
        <StatusVersionSlot
          versionCard={props.versionCard}
          connectingHostName={props.connectingHostName}
        />
      </HostOverviewTabSections>
    </div>
  );
}

/** The version card, or the loading shape in its place while connecting. */
function StatusVersionSlot(props: {
  readonly versionCard: HostOverviewStatusTabProps["versionCard"];
  readonly connectingHostName: string | null;
}): ReactNode {
  if (props.versionCard !== null) {
    return <HostOverviewVersionCard {...props.versionCard} />;
  }
  if (props.connectingHostName === null) return null;
  return <HostScopeConnecting hostName={props.connectingHostName} />;
}
