import { HostSettingsDisclosure } from "@/components/settings/panels/host-settings-disclosure";
import {
  formatInstallDate,
  formatSource,
} from "@/components/settings/panels/host-settings-panel-model";
import { cn } from "@/lib/utils";
import type { HostInstalledRecord } from "@traycer-clients/shared/platform/runner-host";

interface InstallationDetailsDisclosureProps {
  readonly record: HostInstalledRecord | null;
  readonly loading: boolean;
}

export function InstallationDetailsDisclosure(
  props: InstallationDetailsDisclosureProps,
) {
  const { record, loading } = props;
  return (
    <HostSettingsDisclosure label="Installation details" defaultOpen={false}>
      {record === null ? (
        <div className="text-ui-sm text-muted-foreground">
          {loading ? "Reading install record…" : "No host currently installed."}
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
          {record.archiveSha256.length > 0 ? (
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
