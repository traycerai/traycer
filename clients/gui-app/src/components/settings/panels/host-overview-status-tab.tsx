import type { ComponentProps, ReactNode } from "react";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import { HostUpdateDrainGateRow } from "@/components/settings/host-scope/host-registry-updates";
import { HostOverviewOperationCard } from "@/components/settings/panels/host-overview-operation-card";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import { HostOverviewUpdatesRegion } from "@/components/settings/panels/host-overview-updates";

/**
 * Overview ▸ Status: is this host current, and updating it.
 *
 * What the host card used to carry below its identity: the update operation,
 * the update answer with its buttons, and the drain-gate row. Every one of them
 * is resolved by the panel - the page owns the queries, the mutations and the
 * dialogs these controls open - and arrives here as the props of the component
 * that draws it, or `null` where the page withholds it.
 *
 * The three render as the bands they were on the card, flush under the tab
 * bar, in the order they had there.
 */
export interface HostOverviewStatusTabProps {
  /**
   * The update operation the host reports, or `null` for none. A QUIET view
   * is `null` too: the card is for an operation, and when there is none the
   * answer below is the whole story (the landing banner hides on the same
   * predicate).
   */
  readonly operation: ComponentProps<typeof HostOverviewOperationCard> | null;
  /** The update answer; `null` while the scope cannot reach the host. */
  readonly updates: ComponentProps<typeof HostOverviewUpdatesRegion> | null;
  /** "Apply now"; `null` for a host with no account registry row. */
  readonly drainGate: ComponentProps<typeof HostUpdateDrainGateRow> | null;
  /**
   * The host's name while the scope is still connecting, `null` otherwise.
   * The answer cannot be read yet, so the loading shape stands in its place -
   * unless the host's update progress is retained, which is the answer then.
   */
  readonly connectingHostName: string | null;
}

export function HostOverviewStatusTab(
  props: HostOverviewStatusTabProps,
): ReactNode {
  return (
    <div className="flex flex-col" data-testid="host-overview-status-tab">
      {props.operation === null ? null : (
        <HostOverviewOperationCard {...props.operation} />
      )}
      {props.updates === null ? null : (
        <HostOverviewUpdatesRegion {...props.updates} />
      )}
      {props.operation !== null || props.connectingHostName === null ? null : (
        <HostOverviewTabSections>
          <HostScopeConnecting hostName={props.connectingHostName} />
        </HostOverviewTabSections>
      )}
      {/* The only control on the page with a deadline - it renders solely
          while an update is blocked on open sessions - so it sits on the tab
          the page opens on, never behind a click. */}
      {props.drainGate === null ? null : (
        <HostUpdateDrainGateRow {...props.drainGate} />
      )}
    </div>
  );
}
