import type { ComponentProps, ReactNode } from "react";
import { HostPortForwardsCard } from "@/components/settings/panels/host-port-forwards-card";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";

/**
 * Overview ▸ Ports: the forwards agents on this host own, and the ports other
 * machines hold on it.
 *
 * The card reads its own lists, as it always has, and still renders nothing
 * where it rendered nothing on the single-scroll page - a host too old for
 * port forwarding, an unreachable one, one with nothing forwarded.
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
