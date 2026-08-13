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
  readonly version: string;
  readonly installedAt: string;
  readonly source: HostInstallSourceTag;
  readonly archiveSha256: string | null;
  readonly signatureVerifiedAt: string | null;
  readonly platform: string;
  readonly arch: string;
}

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
            value={`v${record.version}`}
            valueClassName={undefined}
            testId={undefined}
          />
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
            value={
              record.signatureVerifiedAt !== null
                ? `Verified ${formatInstallDate(record.signatureVerifiedAt)}`
                : "Unverified"
            }
            valueClassName={
              record.signatureVerifiedAt !== null
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
