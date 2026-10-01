import type { ReactNode } from "react";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import {
  HostOverviewFact,
  HostOverviewFacts,
} from "@/components/settings/panels/host-overview-facts";
import { abbreviateIdentifier } from "@/components/settings/panels/host-overview-installation-model";
import {
  describeOverviewDegrade,
  type OverviewDegradeReason,
} from "@/components/settings/panels/host-overview-model";
import { HostOverviewNotice } from "@/components/settings/panels/host-overview-status-card";
import {
  formatInstallDate,
  formatSource,
} from "@/components/settings/panels/host-settings-panel-model";
import { SettingsGroup } from "@/components/settings/settings-group";
import type { HostInstallSourceTag } from "@traycer-clients/shared/platform/runner-host";

/**
 * The install record as either reader states it.
 *
 * The local CLI bridge (`HostInstalledRecord`) and the host's own
 * `host.getInstallationInfo` return the same record — they read the same
 * `install.json`, through the shared protocol module the maintenance ticket
 * moved it into. They differ only in nullability at the edges, so this is their
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

/** The CLI's sentinel for "this install was never signed". */
const UNSIGNED_SIGNATURE_KEY_ID = "local-file:unsigned";

interface InstallRecordGroupProps {
  readonly hostName: string;
  /** `host.getInstallationInfo` support, or why it is missing. */
  readonly degrade: OverviewDegradeReason | null;
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  /** The read itself failed - which is NOT the same as "no record". */
  readonly readFailed: boolean;
}

/**
 * Installation ▸ Install record, shown open: how this host was installed.
 *
 * It used to be a collapsed "Installation details" disclosure, which made the
 * one group on the page about the install a click away on the tab named for
 * it. Its states keep their words.
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
      <InstallRecordBody {...props} />
    </SettingsGroup>
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
function InstallRecordBody(props: InstallRecordGroupProps): ReactNode {
  const { record } = props;
  if (props.degrade !== null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-degraded">
        {describeOverviewDegrade(props.degrade, props.hostName)}
      </HostOverviewNotice>
    );
  }
  if (props.readFailed && record === null) {
    return (
      <HostOverviewNotice testId="host-overview-installation-unreadable">
        {`Couldn't read ${props.hostName}'s installation record.`}
      </HostOverviewNotice>
    );
  }
  if (record === null) {
    return (
      <p
        className="px-5 py-4 text-ui-sm text-muted-foreground"
        data-testid="host-overview-installation-empty"
      >
        {props.loading
          ? "Reading install record…"
          : `${props.hostName} is running from a checkout or an unpacked tree, so it has no installation record.`}
      </p>
    );
  }
  const verified = isSignatureVerified(record);
  return (
    <HostOverviewFacts testId="host-overview-install-record-facts">
      <HostOverviewFact
        label="Version"
        value={`v${record.runtimeVersion ?? record.version}`}
        kind="code"
        tone="default"
        copy={null}
        testId="settings-host-install-version"
      />
      {record.runtimeVersion === null ||
      record.runtimeVersion === record.version ? null : (
        <HostOverviewFact
          label="Build"
          value={record.version}
          kind="code"
          tone="default"
          copy={null}
          testId="settings-host-install-build"
        />
      )}
      <HostOverviewFact
        label="Source"
        value={formatSource(record.source)}
        kind="code"
        tone="default"
        copy={null}
        testId={undefined}
      />
      <HostOverviewFact
        label="Installed"
        value={formatInstallDate(record.installedAt)}
        kind="code"
        tone="default"
        copy={null}
        testId={undefined}
      />
      <HostOverviewFact
        label="Verification"
        value={describeVerification(record)}
        kind="code"
        tone={verified ? "success" : "warning"}
        copy={null}
        testId="settings-host-verification"
      />
      {record.archiveSha256 !== null && record.archiveSha256.length > 0 ? (
        <HostOverviewFact
          label="SHA-256"
          value={abbreviateIdentifier(record.archiveSha256)}
          kind="code"
          tone="default"
          copy={{ value: record.archiveSha256, label: "Copy SHA-256" }}
          testId="settings-host-install-sha256"
        />
      ) : null}
      <HostOverviewFact
        label="Platform"
        value={`${record.platform}/${record.arch}`}
        kind="code"
        tone="default"
        copy={null}
        testId={undefined}
      />
    </HostOverviewFacts>
  );
}

function isSignatureVerified(record: InstallationDetailsRecord): boolean {
  return (
    record.signatureVerifiedAt !== null &&
    record.signatureKeyId !== UNSIGNED_SIGNATURE_KEY_ID
  );
}

function describeVerification(record: InstallationDetailsRecord): string {
  if (record.signatureKeyId === UNSIGNED_SIGNATURE_KEY_ID) {
    // Not "Unverified": nothing failed and nothing is wrong. This build was
    // installed from a local file or run from a tree, so there was no
    // signature to check in the first place, and saying so is the difference
    // between a state and a fault.
    return "Unsigned local build";
  }
  return record.signatureVerifiedAt === null
    ? "Unverified"
    : `Verified ${formatInstallDate(record.signatureVerifiedAt)}`;
}
