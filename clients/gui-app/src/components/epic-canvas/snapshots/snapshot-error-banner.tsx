import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { useEpicRequestFreshSnapshot } from "@/lib/epic-selectors";
import { getClientAppVersion } from "@/lib/app-version";
import { describeVersionSkew } from "@/lib/host/version-skew-copy";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { SnapshotFetchError } from "@/stores/epics/open-epic/store";

interface SnapshotErrorBannerProps {
  readonly error: SnapshotFetchError;
  readonly className: string | undefined;
}

export function SnapshotErrorBanner(props: SnapshotErrorBannerProps) {
  const requestFreshSnapshot = useEpicRequestFreshSnapshot();
  // Direction-aware copy (R4-D2) only for a genuine INCOMPATIBLE close — every
  // other fatal code keeps its plain message.
  const skew =
    props.error.code === "INCOMPATIBLE"
      ? describeVersionSkew({
          hostAppVersion: null,
          clientAppVersion: getClientAppVersion(),
          guidance: props.error.upgradeGuidance,
        })
      : null;
  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full items-center justify-center p-4",
        props.className,
      )}
    >
      <div
        role="alert"
        data-testid="snapshot-error-banner"
        data-error-code={props.error.code}
        className="flex max-w-sm flex-col items-center gap-2 text-center text-ui-sm"
      >
        <AlertTriangle className="size-6 text-destructive" aria-hidden />
        <p className="font-medium text-destructive">
          {skew === null ? "Failed to load epic" : skew.title}
        </p>
        <p className="text-ui-xs text-muted-foreground">
          {props.error.message}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="snapshot-error-retry"
            onClick={() => requestFreshSnapshot()}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Failed to load epic",
              message: "The Epic snapshot could not be loaded.",
              code: props.error.code,
              source: "Epic snapshot",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    </div>
  );
}
