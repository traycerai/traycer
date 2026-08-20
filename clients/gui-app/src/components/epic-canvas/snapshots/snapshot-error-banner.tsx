import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useLocalStoreRebindMutation } from "@/hooks/local-store/use-local-store-rebind-mutation";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useEpicRequestFreshSnapshot } from "@/lib/epic-selectors";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { getClientAppVersion } from "@/lib/app-version";
import { describeVersionSkew } from "@/lib/host/version-skew-copy";
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
  return (
    <>
      <p
        className="text-ui-xs text-muted-foreground"
        data-testid="local-store-refusal-remedy"
      >
        {repairRefusal?.remedy ?? props.error.localStoreRemedy}
      </p>
      {repairRefusal === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          {repairRefusal.message}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        data-testid="local-store-rebind"
        disabled={props.error.localStoreRemedy === undefined}
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
        actionLabel="I’ve stopped the other host"
        isPending={rebindLocalStore.isPending}
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
        openExternalLink.mutate(
          resolveManageSubscriptionUrl(runnerHost.authnBaseUrl),
        );
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
