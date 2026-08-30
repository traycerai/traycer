import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { useEpicRequestFreshSnapshot } from "@/lib/epic-selectors";
import { getClientAppVersion } from "@/lib/app-version";
import { describeVersionSkew } from "@/lib/host/version-skew-copy";
import { useServerClockSkew } from "@/lib/clock/use-server-clock-skew";
import {
  clockCanMakeValidBearersLookExpired,
  describeClockOffset,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { SnapshotFetchError } from "@/stores/epics/open-epic/store";

interface SnapshotErrorBannerProps {
  readonly error: SnapshotFetchError;
  readonly className: string | undefined;
}

export function SnapshotErrorBanner(props: SnapshotErrorBannerProps) {
  const requestFreshSnapshot = useEpicRequestFreshSnapshot();
  const clock = useServerClockSkew();
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
  // A clock running FAST outranks whatever fatal code got recorded, because
  // under that skew the recorded code is a symptom: an UNAUTHORIZED whose cause
  // was the clock, or a session that went terminal on an older build before
  // parking existed. Retrying is futile until the clock is fixed, so the copy
  // has to say so rather than offering "Failed to load epic" as the diagnosis.
  //
  // Never on the error code — so a genuinely broken host on a machine with a
  // correct clock keeps its own message. And never on `skewed` alone: this
  // block REPLACES the recorded error with a causal claim, and a clock running
  // BEHIND cannot make any bearer look expired or make a host reject one, so
  // the claim would be false AND would bury the real message. The ambient
  // clock banner still tells that user their clock is wrong; this pane keeps
  // telling them what actually failed here.
  const clockOffsetMs = clockCanMakeValidBearersLookExpired(clock)
    ? clock.offsetMs
    : null;
  const title = errorTitle(clockOffsetMs, skew?.title ?? null);
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
        data-clock-skewed={clockOffsetMs === null ? undefined : "true"}
        className="flex max-w-sm flex-col items-center gap-2 text-center text-ui-sm"
      >
        <AlertTriangle className="size-6 text-destructive" aria-hidden />
        <p className="font-medium text-destructive">{title}</p>
        <p className="text-ui-xs text-muted-foreground">
          {clockOffsetMs !== null
            ? `This computer's clock is ${describeClockOffset(clockOffsetMs)}, so Traycer's sign-in tokens are rejected. Correct the clock and this reconnects on its own.`
            : props.error.message}
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

/**
 * Headline for the pane, in priority order: a wrong local clock outranks
 * everything (it explains every other code and makes retrying futile), then the
 * direction-aware version-skew title, then the generic failure.
 */
function errorTitle(
  clockOffsetMs: number | null,
  versionSkewTitle: string | null,
): string {
  if (clockOffsetMs !== null) {
    return "System clock is incorrect";
  }
  return versionSkewTitle ?? "Failed to load epic";
}
