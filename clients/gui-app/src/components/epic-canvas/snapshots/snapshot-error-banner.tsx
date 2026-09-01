import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useLocalStoreRebindMutation } from "@/hooks/local-store/use-local-store-rebind-mutation";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useEpicRequestFreshSnapshot } from "@/lib/epic-selectors";
import { resolvePlatformBaseUrl } from "@/lib/auth/platform-base-url";
import { getClientAppVersion } from "@/lib/app-version";
import { describeVersionSkew } from "@/lib/host/version-skew-copy";
import { useServerClockSkew } from "@/lib/clock/use-server-clock-skew";
import {
  clockCanMakeValidBearersLookExpired,
  describeClockOffset,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useRunnerHost } from "@/providers/use-runner-host";
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
        {props.error.code === "LOCAL_STORE_UNAVAILABLE" ? (
          <LocalStoreRepair error={props.error} />
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          {props.error.code === "ENTITLEMENT_REQUIRED" ? (
            <UpgradeButton />
          ) : null}
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

function LocalStoreRepair(props: { readonly error: SnapshotFetchError }) {
  const requestFreshSnapshot = useEpicRequestFreshSnapshot();
  const rebindLocalStore = useLocalStoreRebindMutation();
  const [confirmRepairOpen, setConfirmRepairOpen] = useState(false);
  const [repairRefusal, setRepairRefusal] = useState<{
    readonly message: string;
    readonly remedy: string;
  } | null>(null);
  const remedy = repairRefusal?.remedy ?? props.error.localStoreRemedy;
  return (
    <>
      {remedy === undefined || remedy.trim().length === 0 ? null : (
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="local-store-refusal-remedy"
        >
          {remedy}
        </p>
      )}
      {repairRefusal === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          {repairRefusal.message}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        data-testid="local-store-rebind"
        onClick={() => setConfirmRepairOpen(true)}
      >
        Rebind local store
      </Button>
      <ConfirmDestructiveDialog
        open={confirmRepairOpen}
        onOpenChange={setConfirmRepairOpen}
        title="Rebind this local store?"
        description="Confirm that no other Traycer host is using this data directory. Rebinding while another host is writing could put your local data at risk."
        cascadeSummary={null}
        blockedReason={null}
        actionLabel="I’ve stopped the other host"
        isPending={
          rebindLocalStore.isPending || rebindLocalStore.isHostEntryPending
        }
        onConfirm={() => {
          rebindLocalStore.mutate(
            { confirmOldHostStopped: true },
            {
              onSuccess: (response) => {
                // `not-needed` is a SUCCESS: a healthy process-held store the
                // stale panel asked to tear down. Treat it exactly like a
                // completed repair - leaving the destructive confirmation
                // open over an error that no longer exists is the one
                // outcome the honest no-op was added to avoid.
                if (
                  response.status === "rebound" ||
                  response.status === "not-needed"
                ) {
                  setConfirmRepairOpen(false);
                  setRepairRefusal(null);
                  requestFreshSnapshot();
                  return;
                }
                // Close FIRST: the remedy renders in the banner behind this
                // dialog, so leaving it open returns the user to an enabled
                // destructive button with no visible reason for the refusal.
                setConfirmRepairOpen(false);
                setRepairRefusal({
                  message: response.message,
                  remedy: response.remedy,
                });
              },
            },
          );
        }}
      />
    </>
  );
}

function UpgradeButton() {
  const runnerHost = useRunnerHost();
  const openExternalLink = useRunnerOpenExternalLink();
  return (
    <Button
      type="button"
      size="sm"
      data-testid="snapshot-error-upgrade"
      disabled={openExternalLink.isPending}
      onClick={() => {
        openExternalLink.mutate(resolvePlatformBaseUrl(runnerHost.signInUrl));
      }}
    >
      Upgrade
      {openExternalLink.isPending ? (
        <AgentSpinningDots
          className="size-3"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </Button>
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
