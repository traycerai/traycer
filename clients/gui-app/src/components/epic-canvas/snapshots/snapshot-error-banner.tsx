import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useRebindLocalStoreMutation } from "@/hooks/local-store/use-rebind-local-store-mutation";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
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
  const rebindLocalStore = useRebindLocalStoreMutation();
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
                if (response.status === "rebound") {
                  setConfirmRepairOpen(false);
                  requestFreshSnapshot();
                  return;
                }
                if (response.status === "refused") {
                  setRepairRefusal({
                    message: response.message,
                    remedy: response.remedy,
                  });
                }
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
  return (
    <Button
      type="button"
      size="sm"
      data-testid="snapshot-error-upgrade"
      onClick={() => {
        void runnerHost.openExternalLink(
          resolveManageSubscriptionUrl(runnerHost.authnBaseUrl),
        );
      }}
    >
      Upgrade
    </Button>
  );
}
