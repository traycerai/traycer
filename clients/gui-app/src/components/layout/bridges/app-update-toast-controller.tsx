import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { progressToast } from "@/lib/toast/progress-toast";

const APP_UPDATE_TOAST_ID = "traycer-app-update";
const APP_UPDATE_TRANSIENT_TOAST_DURATION_MS = 4000;
const APP_UPDATE_REPORT_CONTEXT = createReportIssueContext({
  title: "Could not update Traycer",
  message: null,
  code: null,
  source: "App update",
});

export function AppUpdateToastController(): null {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openConfirmRestartUpdate = useDesktopDialogStore(
    (state) => state.openConfirmRestartUpdate,
  );
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  const openReportIssueWithContext = useDesktopDialogStore(
    (state) => state.openReportIssueWithContext,
  );
  const reportIssueAvailable = useDesktopDialogStore(
    (state) => state.reportIssueAvailable,
  );
  const handledSequenceRef = useRef(0);
  const handledReportCapabilityRef = useRef<boolean | null>(null);
  const bridgeRef = useRef<DesktopAppUpdatesBridge | null | undefined>(
    undefined,
  );
  const mountedAtMsRef = useRef<number | null>(null);

  useEffect(() => {
    mountedAtMsRef.current ??= Date.now();
    if (bridgeRef.current !== bridge) {
      const isInitialBridge = bridgeRef.current === undefined;
      bridgeRef.current = bridge;
      handledSequenceRef.current = 0;
      handledReportCapabilityRef.current = null;
      if (!isInitialBridge) {
        mountedAtMsRef.current = Date.now();
      }
    }
    if (bridge === null) return;
    if (snapshot.sequence === 0) return;
    const capabilityChangedForCurrentError =
      snapshot.status === "error" &&
      handledSequenceRef.current === snapshot.sequence &&
      handledReportCapabilityRef.current !== reportIssueAvailable;
    if (
      handledSequenceRef.current > snapshot.sequence ||
      (handledSequenceRef.current === snapshot.sequence &&
        !capabilityChangedForCurrentError)
    ) {
      return;
    }
    handledSequenceRef.current = snapshot.sequence;
    handledReportCapabilityRef.current = reportIssueAvailable;
    const mountedAtMs = mountedAtMsRef.current;
    if (isManualReplayFromBeforeMount(snapshot, mountedAtMs)) {
      return;
    }

    showAppUpdateToast(snapshot, {
      onDownload: () => {
        void bridge.downloadUpdate();
      },
      onRestart: openConfirmRestartUpdate,
      onViewInstructions: openInstallGuidance,
      onReportIssue: reportIssueAvailable
        ? () => openReportIssueWithContext(APP_UPDATE_REPORT_CONTEXT)
        : null,
    });
  }, [
    bridge,
    snapshot,
    openConfirmRestartUpdate,
    openInstallGuidance,
    openReportIssueWithContext,
    reportIssueAvailable,
  ]);

  return null;
}

interface AppUpdateToastActions {
  readonly onDownload: () => void;
  readonly onRestart: () => void;
  readonly onViewInstructions: () => void;
  readonly onReportIssue: (() => void) | null;
}

function showAppUpdateToast(
  snapshot: DesktopAppUpdateSnapshot,
  actions: AppUpdateToastActions,
): void {
  switch (snapshot.status) {
    case "checking":
      if (snapshot.lastCheckIntent === "manual") {
        toast.info("Checking for Traycer updates...", {
          id: APP_UPDATE_TOAST_ID,
          description: null,
          duration: APP_UPDATE_TRANSIENT_TOAST_DURATION_MS,
          cancel: null,
        });
      }
      return;
    case "available":
      // Updates blocked by the install location (read-only volume): a brief,
      // self-dismissing heads-up explaining why it can't be installed - the
      // disabled header button + tooltip is the persistent reminder, so this
      // toast doesn't linger or stack into a nag.
      if (snapshot.installBlockedReason !== null) {
        toast("Update available", {
          id: APP_UPDATE_TOAST_ID,
          description: snapshot.installBlockedReason,
          duration: APP_UPDATE_TRANSIENT_TOAST_DURATION_MS,
          cancel: null,
        });
        return;
      }
      // A quiet, dismissible heads-up - the header button is the persistent
      // fallback once it's dismissed.
      toast(
        <AppUpdateActionToastContent
          title="Update available"
          description={updateAvailableDescription(snapshot.latestVersion)}
          actionLabel="Download"
          onAction={actions.onDownload}
        />,
        {
          id: APP_UPDATE_TOAST_ID,
          description: null,
          duration: Infinity,
          cancel: null,
        },
      );
      return;
    case "downloading":
      progressToast("Downloading update…", {
        id: APP_UPDATE_TOAST_ID,
        description:
          snapshot.downloadProgress === null
            ? "Starting download…"
            : `${snapshot.downloadProgress}% complete`,
        duration: Infinity,
        cancel: null,
      });
      return;
    case "ready":
      // Linux deb/rpm where silent install can't/didn't work: the download
      // succeeded, but "Restart" would trigger the same doomed install
      // attempt. Point at the step-by-step dialog instead.
      toast(
        snapshot.installGuidance === null ? (
          <AppUpdateActionToastContent
            title="Update ready to install"
            description="Restart Traycer to finish updating."
            actionLabel="Restart"
            onAction={actions.onRestart}
          />
        ) : (
          <AppUpdateActionToastContent
            title="Update downloaded"
            description="One manual step finishes installing it."
            actionLabel="View instructions"
            onAction={actions.onViewInstructions}
          />
        ),
        {
          id: APP_UPDATE_TOAST_ID,
          description: null,
          duration: Infinity,
          cancel: null,
        },
      );
      return;
    case "error": {
      reportableErrorToast(
        "Couldn't update Traycer",
        {
          id: APP_UPDATE_TOAST_ID,
          cancel: null,
          description: (
            <AppUpdateErrorToastDescription
              message={snapshot.errorMessage}
              onReportIssue={actions.onReportIssue}
              onViewInstructions={
                snapshot.installGuidance === null
                  ? null
                  : actions.onViewInstructions
              }
            />
          ),
          duration: Infinity,
        },
        APP_UPDATE_REPORT_CONTEXT,
      );
      return;
    }
    case "up-to-date":
      toast.success("Traycer is up to date", {
        id: APP_UPDATE_TOAST_ID,
        description:
          snapshot.currentVersion.length === 0
            ? null
            : `Current version: v${snapshot.currentVersion}`,
        duration: APP_UPDATE_TRANSIENT_TOAST_DURATION_MS,
        cancel: null,
      });
      return;
    case "unavailable":
      toast.info("Updates are not available for this build.", {
        id: APP_UPDATE_TOAST_ID,
        description: null,
        duration: APP_UPDATE_TRANSIENT_TOAST_DURATION_MS,
        cancel: null,
      });
      return;
    case "idle":
      return;
  }
}

function updateAvailableDescription(latestVersion: string | null): string {
  if (latestVersion === null) {
    return "A new version of Traycer is ready to download.";
  }
  return `Version ${latestVersion} is ready to download.`;
}

function isManualReplayFromBeforeMount(
  snapshot: DesktopAppUpdateSnapshot,
  mountedAtMs: number,
): boolean {
  if (!isManualFeedbackSnapshot(snapshot)) {
    return false;
  }
  if (snapshot.lastCheckedAt === null) {
    return true;
  }
  const checkedAtMs = Date.parse(snapshot.lastCheckedAt);
  return Number.isFinite(checkedAtMs) && checkedAtMs < mountedAtMs;
}

function isManualFeedbackSnapshot(snapshot: DesktopAppUpdateSnapshot): boolean {
  // Errors are deliberately excluded: a failed download/install (e.g. the
  // read-only-volume install error) is a live, important event, so it surfaces
  // even in a window mounted right after - we only suppress stale, low-stakes
  // manual-check chatter ("checking" / "up to date" / "unavailable").
  return (
    snapshot.lastCheckIntent === "manual" &&
    (snapshot.status === "checking" ||
      snapshot.status === "up-to-date" ||
      snapshot.status === "unavailable")
  );
}

function AppUpdateActionToastContent(props: {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  const actionHandledRef = useRef(false);
  const [actionHandled, setActionHandled] = useState(false);

  function handleAction(): void {
    if (actionHandledRef.current) return;
    actionHandledRef.current = true;
    setActionHandled(true);
    toast.dismiss(APP_UPDATE_TOAST_ID);
    props.onAction();
  }

  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{props.title}</div>
        <div className="mt-1 text-muted-foreground">{props.description}</div>
      </div>
      <div className="grid shrink-0 grid-cols-1 gap-1.5">
        <Button
          type="button"
          size="sm"
          className="w-full min-w-max"
          disabled={actionHandled}
          onClick={handleAction}
        >
          {props.actionLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-full min-w-max"
          onClick={() => {
            toast.dismiss(APP_UPDATE_TOAST_ID);
          }}
        >
          Later
        </Button>
      </div>
    </div>
  );
}

function AppUpdateErrorToastDescription(props: {
  readonly message: string | null;
  readonly onReportIssue: (() => void) | null;
  readonly onViewInstructions: (() => void) | null;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      {props.message === null ? null : <span>{props.message}</span>}
      <div className="flex flex-wrap gap-2">
        {props.onViewInstructions === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={props.onViewInstructions}
          >
            View instructions
          </Button>
        )}
        {props.onReportIssue === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={props.onReportIssue}
          >
            Report an issue
          </Button>
        )}
      </div>
    </div>
  );
}
