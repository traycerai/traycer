import type { ReactNode } from "react";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import {
  OsServiceSection,
  type OsServiceSectionProps,
} from "@/components/settings/panels/host-overview-os-service-section";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import {
  InstallationDetailsDisclosure,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
import { LocalPackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { SettingsGroup } from "@/components/settings/settings-group";

/**
 * Overview ▸ Installation: how this host is set up, and removing it - the
 * install record, the OS service, this computer's command-line tools hint, and
 * the Danger zone, last.
 */
export interface HostOverviewInstallationTabProps {
  /** Whether the scope can reach the host; the record and service need it. */
  readonly usable: boolean;
  readonly hostName: string;
  /** `host.getInstallationInfo` support, or why it is missing. */
  readonly installInfoDegrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly recordLoading: boolean;
  /** The record read itself failed - which is NOT the same as "no record". */
  readonly recordReadFailed: boolean;
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
   * alone can read. There is no remote equivalent to render.
   */
  readonly showPackageManagerHint: boolean;
  readonly scope: HostScope;
}

export function HostOverviewInstallationTab(
  props: HostOverviewInstallationTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {/* Pure host RPC, both halves - the record and the service - so with no
          route the group is withheld rather than drawn as an empty titled
          card. The header's health line already says the host cannot be
          reached; a second notice here would say it twice. */}
      {!props.usable ? null : (
        <SettingsGroup
          group={HOST_OVERVIEW.definitions.installation}
          showTitle
          tone="default"
          dataTestId="host-installation"
          fill={false}
        >
          <HostOverviewInstallationBody
            hostName={props.hostName}
            degrade={props.installInfoDegrade}
            record={props.record}
            loading={props.recordLoading}
            readFailed={props.recordReadFailed}
          />
          {props.service === null ? null : (
            <div className="px-5 py-4">
              <OsServiceSection {...props.service} />
            </div>
          )}
        </SettingsGroup>
      )}
      {props.showPackageManagerHint ? <LocalPackageManagerUpgradeHint /> : null}
      {/* No list of the OTHER hosts, and no "Add host": a page about one host
          is the wrong place to manage the collection it belongs to. The
          sidebar switcher owns both.

          Not gated from out here: the zone's rows sit on three different
          capability planes (host RPC, the local CLI bridge, an account write)
          and it gates each of them itself. A gate around all three took the
          recovery actions away in the states that need them. */}
      <HostDangerZone scope={props.scope} />
    </HostOverviewTabSections>
  );
}

/**
 * Three outcomes, and the middle one is the finding: a FAILED read is not an
 * unmanaged host. Collapsing both to `record: null` made the card assert that
 * this host runs from a checkout or an unpacked tree - a fact the RPC never
 * established, stated to the user as if it had.
 *
 * `unmanaged` IS a real state rather than an error: a host run from a checkout
 * has no install record, and reporting that as "nothing is installed" put a
 * false alarm on every developer's machine.
 */
function HostOverviewInstallationBody(props: {
  readonly hostName: string;
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  readonly readFailed: boolean;
}): ReactNode {
  if (props.degrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-degraded">
        {describeOverviewDegrade(props.degrade, props.hostName)}
      </HostOverviewNotice>
    );
  }
  if (props.readFailed && props.record === null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-unreadable">
        {`Couldn't read ${props.hostName}'s installation record.`}
      </HostOverviewNotice>
    );
  }
  return (
    <InstallationDetailsDisclosure
      record={props.record}
      loading={props.loading}
      emptyMessage={`${props.hostName} is running from a checkout or an unpacked tree, so it has no installation record.`}
    />
  );
}
