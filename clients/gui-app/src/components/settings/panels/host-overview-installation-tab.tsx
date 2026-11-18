import type { ReactNode } from "react";
import { SandboxInstallationGroup } from "@/components/hosts/sandbox-card";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { HostScopeConnecting } from "@/components/settings/host-scope/host-scope-gate";
import type { HostScopeSandbox } from "@/components/settings/host-scope/host-scope-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { HostOverviewAboutThisHost } from "@/components/settings/panels/host-overview-about-this-host";
import type { HostOverviewAboutSource } from "@/components/settings/panels/host-overview-installation-model";
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
 * Overview ▸ Installation: sandbox facts when this host is one, what the
 * account knows, how it is installed and started, and removing it.
 */
export interface HostOverviewInstallationTabProps {
  /** Whether the scope can reach the host; the record and service need it. */
  readonly usable: boolean;
  readonly hostName: string;
  /**
   * The account's record of this host, or `null` for a host the account has
   * no record of, which gets no About group.
   */
  readonly about: HostOverviewAboutSource | null;
  /** `host.getInstallationInfo` support, or why it is missing. */
  readonly installInfoDegrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly recordLoading: boolean;
  /** The record read itself failed. That is not the same as no record. */
  readonly recordReadFailed: boolean;
  /**
   * The host is connecting, or restarting to finish an update: an answer is
   * coming, so the install record and OS service wait in the loading shape.
   */
  readonly connecting: boolean;
  /**
   * The OS service section, already resolved by the page's adapter, or `null`
   * to withhold it while the host cannot be reached.
   */
  readonly service: OsServiceSectionProps | null;
  /**
   * This computer's package-manager hint. Local machine with a CLI bridge
   * only: the hint is Desktop's launch-time comparison of its bundled CLI
   * against this machine's package-manager CLI.
   */
  readonly showPackageManagerHint: boolean;
  /** The scoped sandbox, or null for a computer. Facts only; no grants or ledger. */
  readonly sandbox: HostScopeSandbox | null;
  readonly scope: HostScope;
}

export function HostOverviewInstallationTab(
  props: HostOverviewInstallationTabProps,
): ReactNode {
  return (
    <HostOverviewTabSections>
      {props.sandbox === null ? null : (
        <SettingsGroup
          group={HOST_OVERVIEW.definitions.sandboxFacts}
          showTitle
          tone="default"
          dataTestId="host-overview-sandbox-facts"
          fill={false}
        >
          <div className="flex min-w-0 flex-col gap-3 px-5 py-4">
            <SandboxInstallationGroup sandbox={props.sandbox} />
          </div>
        </SettingsGroup>
      )}
      {props.about === null ? null : (
        <HostOverviewAboutThisHost {...props.about} />
      )}
      <HostOverviewInstallationHostGroups {...props} />
      {props.showPackageManagerHint ? <LocalPackageManagerUpgradeHint /> : null}
      <HostDangerZone scope={props.scope} />
    </HostOverviewTabSections>
  );
}

/**
 * The two groups read from the host: the install record and the OS service.
 * While it connects they are the loading shape. When it cannot be reached,
 * one line says both need a connection. A version that answers neither is
 * one line saying what an update brings back.
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
