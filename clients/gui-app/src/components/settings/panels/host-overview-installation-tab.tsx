import type { ReactNode } from "react";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { HostOverviewAboutThisHost } from "@/components/settings/panels/host-overview-about-this-host";
import type { HostOverviewAboutSource } from "@/components/settings/panels/host-overview-installation-model";
import type { OverviewDegradeReason } from "@/components/settings/panels/host-overview-model";
import {
  OsServiceSection,
  type OsServiceSectionProps,
} from "@/components/settings/panels/host-overview-os-service-section";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import {
  InstallRecordGroup,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
import { LocalPackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";

/**
 * Overview ▸ Installation: what the account knows about this host, how it is
 * installed and started, and removing it - About this host, the install
 * record, the OS service, this computer's command-line tools hint, and the
 * Danger zone, last.
 */
export interface HostOverviewInstallationTabProps {
  /** Whether the scope can reach the host; the record and service need it. */
  readonly usable: boolean;
  readonly hostName: string;
  /**
   * The account's record of this host, or `null` for a host the account has
   * no record of (reachable, but not in the account), which gets no About
   * this host group - as it gets no Danger zone.
   */
  readonly about: HostOverviewAboutSource | null;
  /** `host.getInstallationInfo` support, or why it is missing. */
  readonly installInfoDegrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly recordLoading: boolean;
  /** The record read itself failed - which is NOT the same as "no record". */
  readonly recordReadFailed: boolean;
  /**
   * The host is connecting, or restarting to finish an update: an answer is
   * coming, so the install record and OS service wait in the loading shape.
   */
  readonly connecting: boolean;
  /**
   * The OS service section, already resolved by the page's adapter, or `null`
   * to withhold it - as it is while the host cannot be reached.
   */
  readonly service: OsServiceSectionProps | null;
  /**
   * This computer's package-manager hint. Local machine with a CLI bridge
   * only, by the nature of the fact rather than a scope rule: the hint is
   * Desktop's launch-time comparison of ITS bundled CLI against THIS machine's
   * package-manager CLI, recorded in Desktop-local reconcile state the bridge
   * alone can read. There is no remote equivalent to render. The tab's dot
   * (`LocalPackageManagerUpgradeDot`) takes the same gate from the panel.
   */
  readonly showPackageManagerHint: boolean;
  readonly scope: HostScope;
}

export function HostOverviewInstallationTab(
  props: HostOverviewInstallationTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {/* The account's facts first. Not a host read, so it stands whether or
          not the host answers - the state someone most often comes here in. */}
      {props.about === null ? null : (
        <HostOverviewAboutThisHost {...props.about} />
      )}
      <HostOverviewInstallationHostGroups {...props} />
      {/* A bridge fact about THIS computer's CLI, not a host read, so it
          stays while the host is down. */}
      {props.showPackageManagerHint ? <LocalPackageManagerUpgradeHint /> : null}
      {/* No list of the OTHER hosts, and no "Add host": a page about one host
          is the wrong place to manage the collection it belongs to. The
          sidebar switcher owns both.

          Not gated from out here: the zone's rows sit on different capability
          planes (the local CLI bridge, an account write) and it gates each of
          them itself. A gate around them took the recovery actions away in the
          states that need them. */}
      <HostDangerZone scope={props.scope} />
    </HostOverviewTabSections>
  );
}

/**
 * The two groups read FROM the host - the install record and the OS service.
 * While it connects or restarts they are the loading shape; when it cannot be
 * reached, one line says both need a connection, rather than two empty titled
 * cards or a second "can't reach" notice under the header's.
 */
function HostOverviewInstallationHostGroups(
  props: HostOverviewInstallationTabProps,
): ReactNode {
  if (props.connecting) {
    return <HostScopeConnecting hostName={props.hostName} />;
  }
  if (!props.usable) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="host-overview-installation-needs-connection"
      >
        The install record and OS service are read from {props.hostName}, so
        they need a connection.
      </p>
    );
  }
  return (
    <>
      <InstallRecordGroup
        hostName={props.hostName}
        degrade={props.installInfoDegrade}
        record={props.record}
        loading={props.recordLoading}
        readFailed={props.recordReadFailed}
      />
      {props.service === null ? null : <OsServiceSection {...props.service} />}
    </>
  );
}
