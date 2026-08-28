import { HostSettingsDisclosure } from "@/components/settings/panels/host-settings-disclosure";
import {
  formatInstallDate,
  formatSource,
} from "@/components/settings/panels/host-settings-panel-model";
import { cn } from "@/lib/utils";
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

interface InstallationDetailsDisclosureProps {
  readonly record: InstallationDetailsRecord | null;
  readonly loading: boolean;
  /**
   * What "no record" means here, because it is not always the same thing. The
   * bridge says "nothing is installed on this computer"; the host says
   * `unmanaged`, which means it is running from a checkout or a hand-unpacked
   * tree and has no install record to read. Rendering the first sentence for
   * the second state told every developer their host was missing.
   */
  readonly emptyMessage: string;
}

export function InstallationDetailsDisclosure(
  props: InstallationDetailsDisclosureProps,
) {
  const { record, loading } = props;
  return (
    <HostSettingsDisclosure label="Installation details" defaultOpen={false}>
      {record === null ? (
        <div className="text-ui-sm text-muted-foreground">
          {loading ? "Reading install record…" : props.emptyMessage}
        </div>
      ) : (
        <dl className="flex flex-col gap-3 text-ui-sm">
          <DetailField
            label="Version"
            value={`v${record.runtimeVersion ?? record.version}`}
            valueClassName={undefined}
            testId="settings-host-install-version"
          />
          {record.runtimeVersion === null ||
          record.runtimeVersion === record.version ? null : (
            <DetailField
              label="Build"
              value={record.version}
              valueClassName={undefined}
              testId="settings-host-install-build"
            />
          )}
          <DetailField
            label="Source"
            value={formatSource(record.source)}
            valueClassName={undefined}
            testId={undefined}
          />
          <DetailField
            label="Installed"
            value={formatInstallDate(record.installedAt)}
            valueClassName={undefined}
            testId={undefined}
          />
          <DetailField
            label="Verification"
            value={describeVerification(record)}
            valueClassName={
              isSignatureVerified(record)
                ? "text-emerald-500"
                : "text-amber-500"
            }
            testId="settings-host-verification"
          />
          {record.archiveSha256 !== null && record.archiveSha256.length > 0 ? (
            <DetailField
              label="SHA-256"
              value={record.archiveSha256}
              valueClassName={undefined}
              testId={undefined}
            />
          ) : null}
          <DetailField
            label="Platform"
            value={`${record.platform}/${record.arch}`}
            valueClassName={undefined}
            testId={undefined}
          />
        </dl>
      )}
    </HostSettingsDisclosure>
  );
}

interface DetailFieldProps {
  readonly label: string;
  readonly value: string;
  readonly valueClassName: string | undefined;
  readonly testId: string | undefined;
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

function DetailField(props: DetailFieldProps) {
  const { label, value, valueClassName, testId } = props;
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-ui-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "font-mono text-code-xs break-all text-foreground",
          valueClassName,
        )}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}
