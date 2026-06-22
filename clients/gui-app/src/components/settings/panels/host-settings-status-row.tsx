import { SettingsRow } from "@/components/settings/settings-row";
import { Skeleton } from "@/components/ui/skeleton";
import {
  statusColorClass,
  statusDescription,
  statusLabel,
} from "@/components/settings/panels/host-settings-panel-model";
import { cn } from "@/lib/utils";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";

interface StatusRowProps {
  readonly status: ServiceStatusSnapshot | undefined;
  readonly pending: boolean;
}

export function StatusRow(props: StatusRowProps) {
  const { status, pending } = props;
  return (
    <SettingsRow
      label="Status"
      description={statusDescription(status?.state)}
      control={
        <div
          className="flex max-w-full flex-col items-end gap-1 text-ui-sm"
          data-testid="settings-host-status"
        >
          {pending || status === undefined ? (
            <>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-32" />
            </>
          ) : (
            <>
              <span
                className={cn("font-medium", statusColorClass(status.state))}
              >
                {statusLabel(status.state)}
              </span>
              <StatusMetaLine status={status} />
            </>
          )}
        </div>
      }
    />
  );
}

function StatusMetaLine(props: { readonly status: ServiceStatusSnapshot }) {
  const { status } = props;
  const parts: string[] = [];
  if (status.version !== null) parts.push(`v${status.version}`);
  if (status.listenUrl !== null) parts.push(status.listenUrl);
  if (status.pid !== null) parts.push(`pid ${status.pid}`);
  if (parts.length === 0) return null;
  return (
    <span className="break-all text-right font-mono text-code-xs text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}
