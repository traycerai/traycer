import type { ReactNode } from "react";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import { SettingsGroup } from "@/components/settings/settings-group";
import type { HostInstallSourceTag } from "@traycer-clients/shared/platform/runner-host";

/**
 * The install record as either reader states it.
 *
 * The local CLI bridge (`HostInstalledRecord`) and the host's own
 * `host.getInstallationInfo` return the same record — they read the same
 * `install.json`, through the shared protocol module they were moved into.
 * They differ only in nullability at the edges, so this is their
 * intersection rather than a third format: the host is authoritative about its
 * own installation, and the bridge is what answers when the host cannot.
 */
export interface InstallationDetailsRecord {
  /**
   * The install's own id — for a CLI-staged dev tree that is a timestamp stamp
   * (`local-runtime-2026-…`), not a Traycer version.
   *
   * Shown as `Build`, and only when it differs from the version above it.
   * Rendering it AS the version is what put two different numbers for "what is
   * this host running" on one page: the identity card reads the host's live
   * `hostVersion` (`0.0.0-dev`), this panel read the stamp, and neither was
   * wrong — they are different facts that were both labelled "Version".
   */
  readonly version: string;
  /**
   * What the record says the host actually RUNS, which is the same fact the
   * identity card shows. `null` on the CLI-bridge path: `HostInstalledRecord`
   * has no such field, so the bridge cannot answer for it and the display falls
   * back to `version` there — the pre-existing behaviour, unchanged.
   */
  readonly runtimeVersion: string | null;
  readonly installedAt: string;
  readonly source: HostInstallSourceTag;
  readonly archiveSha256: string | null;
  readonly signatureVerifiedAt: string | null;
  /**
   * Which key verified the archive — or the sentinel that says none did.
   *
   * Carried because `signatureVerifiedAt` alone cannot tell the two apart. An
   * unsigned local-file install stamps it with the install time anyway (the
   * CLI's `stageLocalSource` does, and `scripts/remote-host-staging.js` follows
   * it), so reading only that field captioned every hand-installed and every
   * tree-run host with a green "Verified <date>" — an assertion about a
   * signature that was never checked, on exactly the hosts least likely to have
   * one.
   */
  readonly signatureKeyId: string;
  readonly platform: string;
  readonly arch: string;
}

interface InstallRecordGroupProps {
  readonly hostName: string;
  /** `host.getInstallationInfo` support, or why it is missing. */
  readonly degrade: OverviewDegradeReason | null;
}

/**
 * Installation ▸ Install record, shown only when the record cannot be shown:
 * `host.getInstallationInfo` is unsupported (`degrade`), or, with no `degrade`,
 * the read itself failed. A record that loaded, and a host with none, are
 * drawn by the tab from the model.
 */
export function InstallRecordGroup(props: InstallRecordGroupProps): ReactNode {
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.installRecord}
      showTitle
      tone="default"
      dataTestId="host-overview-install-record"
      fill={false}
    >
      <InstallRecordFailure {...props} />
    </SettingsGroup>
  );
}

/**
 * A FAILED read is not an unmanaged host: collapsing both to "no record" made
 * the card assert that this host runs from a checkout or an unpacked tree - a
 * fact the RPC never established.
 */
function InstallRecordFailure(props: InstallRecordGroupProps): ReactNode {
  if (props.degrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-degraded">
        {describeOverviewDegrade(props.degrade, props.hostName)}
      </HostOverviewNotice>
    );
  }
  return (
    <HostOverviewNotice testId="host-overview-installation-unreadable">
      {`Couldn't read ${props.hostName}'s installation record.`}
    </HostOverviewNotice>
  );
}
