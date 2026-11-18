/**
 * Docs: see ../SETTINGS.md (Host ▸ Overview ▸ Ports).
 * Update that file whenever this settings surface changes.
 */
import type { ComponentProps, ReactNode } from "react";
import { HostPortForwardsCard } from "@/components/settings/panels/host-port-forwards-card";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";

/**
 * Overview ▸ Ports: the forwards agents on this host own, and the ports other
 * machines hold on it. On every host, in every state - the card says what it
 * cannot show and why.
 *
 * The lists are the panel's one read (`useHostPortForwards`), handed in so the
 * body and the count on this tab's trigger ({@link HostOverviewPortsCount})
 * are the same answer.
 */
export type HostOverviewPortsTabProps = ComponentProps<
  typeof HostPortForwardsCard
>;

export function HostOverviewPortsTab(
  props: HostOverviewPortsTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      <HostPortForwardsCard {...props} />
    </HostOverviewTabSections>
  );
}

/**
 * The Ports trigger's badge, and the phone dropdown's: how many forwards this
 * host owns plus how many of its ports other machines hold. The panel draws
 * it only when there is at least one (`HostPortForwards.count`), and it is as
 * current as the panel's 15-second read.
 *
 * The number is spoken with its meaning, since a bare digit after "Ports"
 * reads as part of the tab's name.
 */
export function HostOverviewPortsCount(props: {
  readonly count: number;
}): ReactNode {
  return (
    <span
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1.5 text-micro font-semibold leading-none text-foreground tabular-nums"
      data-testid="host-overview-ports-count"
      data-count={props.count}
    >
      <span aria-hidden>{props.count}</span>
      <span className="sr-only">{`, ${props.count} forwarded or held`}</span>
    </span>
  );
}
