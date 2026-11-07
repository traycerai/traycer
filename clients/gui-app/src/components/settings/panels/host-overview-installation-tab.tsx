import type { ReactNode } from "react";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { HostOverviewAboutThisHost } from "@/components/settings/panels/host-overview-about-this-host";
import {
  HostOverviewFact,
  HostOverviewFacts,
} from "@/components/settings/panels/host-overview-facts";
import {
  deriveInstallationDetails,
  deriveInstallRecordRows,
  type HostOverviewAboutSource,
  type InstallationDetailRow,
} from "@/components/settings/panels/host-overview-installation-model";
import type { OverviewDegradeReason } from "@/components/settings/panels/host-overview-model";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import {
  OsServiceSection,
  type OsServiceSectionProps,
} from "@/components/settings/panels/host-overview-os-service-section";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import { HostOverviewTabSections } from "@/components/settings/panels/host-overview-tabs";
import {
  InstallRecordGroup,
  type InstallationDetailsRecord,
} from "@/components/settings/panels/host-settings-installation-details";
import { LocalPackageManagerUpgradeHint } from "@/components/settings/panels/host-settings-package-manager-upgrade-hint";
import { SettingsGroup } from "@/components/settings/settings-group";

/**
 * Overview ▸ Installation: what the account knows about this host, how it is
 * installed and started, and removing it - About this host, a compact install
 * line or the install record, Details, the OS service, this computer's
 * command-line tools hint, and the Danger zone, last.
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
  /**
   * The header's running version: `view.hostVersion ?? host.version`. Null
   * when neither the process nor the registry has one. Required, not optional,
   * so a caller cannot forget the live value and leave the registry number
   * standing in for it.
   */
  readonly runningVersion: string | null;
  readonly scope: HostScope;
}

export function HostOverviewInstallationTab(
  props: HostOverviewInstallationTabProps,
): ReactNode {
  const live = props.usable && !props.connecting;
  const recordReadable =
    live && props.installInfoDegrade === null && !props.recordReadFailed;
  const shownRecord = recordReadable ? props.record : null;
  const detailRows = deriveInstallationDetails({
    about: props.about,
    live,
    runningVersion: props.runningVersion,
    record: shownRecord,
  });
  return (
    <HostOverviewTabSections>
      {/* The account's facts first. Not a host read, so it stands whether or
          not the host answers - the state someone most often comes here in. */}
      {props.about === null ? null : (
        <HostOverviewAboutThisHost {...props.about} />
      )}
      {recordReadable ? (
        <HostOverviewInstallStatus
          record={props.record}
          loading={props.recordLoading}
          runningVersion={props.runningVersion}
        />
      ) : null}
      <InstallationDetails
        rows={detailRows}
        serviceManifestLine={
          live && props.service?.degrade === null
            ? props.service.manifestLine
            : null
        }
      />
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
 * A missing install record is one line. A record that arrived keeps the facts
 * that did not move into Details (source, when it was installed, verification,
 * the digest, and the install id when that id is not the running version).
 */
function HostOverviewInstallStatus(props: {
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  readonly runningVersion: string | null;
}): ReactNode {
  const { record } = props;
  if (record === null) {
    return (
      <p
        className="min-w-0 break-words text-ui-sm text-muted-foreground"
        data-testid="host-overview-installation-empty"
      >
        {props.loading
          ? "Reading install record…"
          : "Running from a checkout or unpacked tree · no installation record"}
      </p>
    );
  }
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.installRecord}
      showTitle
      tone="default"
      dataTestId="host-overview-install-record"
      fill={false}
    >
      <HostOverviewFacts testId="host-overview-install-record-facts">
        {deriveInstallRecordRows(record, props.runningVersion).map((row) => (
          <InstallationFact key={row.testId} row={row} />
        ))}
      </HostOverviewFacts>
    </SettingsGroup>
  );
}

function InstallationDetails(props: {
  readonly rows: readonly InstallationDetailRow[];
  readonly serviceManifestLine: string | null;
}): ReactNode {
  if (props.rows.length === 0 && props.serviceManifestLine === null)
    return null;
  return (
    <details
      className="min-w-0"
      data-testid="host-overview-installation-details"
    >
      <summary className="cursor-pointer text-ui-sm font-medium text-foreground">
        Details
      </summary>
      <dl className="mt-2 flex min-w-0 flex-col gap-3">
        {props.rows.map((row) => (
          <InstallationFact key={row.testId} row={row} />
        ))}
        {props.serviceManifestLine === null ? null : (
          <HostOverviewFact
            label="OS service"
            value={props.serviceManifestLine}
            kind="code"
            tone="default"
            copy={null}
            testId="host-overview-service-manifest"
          />
        )}
      </dl>
    </details>
  );
}

function InstallationFact(props: {
  readonly row: InstallationDetailRow;
}): ReactNode {
  const { row } = props;
  return (
    <HostOverviewFact
      label={row.label}
      value={row.value}
      kind={row.kind}
      tone={row.tone}
      copy={row.copy}
      testId={row.testId}
    />
  );
}

/**
 * The two groups read FROM the host - the install record and the OS service.
 * While it connects or restarts they are the loading shape; when it cannot be
 * reached, one line says both need a connection, rather than two empty titled
 * cards or a second "can't reach" notice under the header's. A version that
 * answers neither is one line too, saying what an update brings back.
 *
 * A record that loaded is drawn above Details. This function still owns the
 * failure notices, which are not "no record".
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
  if (
    props.installInfoDegrade === "unsupported" &&
    props.service?.degrade === "unsupported"
  ) {
    return (
      <HostOverviewNotice testId="host-overview-installation-unsupported">
        {`Update ${props.hostName} to see its activity here.`}
      </HostOverviewNotice>
    );
  }
  const recordFailed =
    props.installInfoDegrade !== null || props.recordReadFailed;
  return (
    <>
      {recordFailed ? (
        <InstallRecordGroup
          hostName={props.hostName}
          degrade={props.installInfoDegrade}
          record={props.record}
          loading={props.recordLoading}
          readFailed={props.recordReadFailed}
        />
      ) : null}
      {props.service === null ? null : <OsServiceSection {...props.service} />}
    </>
  );
}
