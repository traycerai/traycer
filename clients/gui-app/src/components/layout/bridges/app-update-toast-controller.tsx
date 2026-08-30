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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  settleUpdateDownloadOutcome,
  trackUpdateDownloadStarted,
  trackUpdateRestartRequested,
} from "@/lib/app-update-analytics";
import { requestAppUpdateInstall } from "@/lib/app-update/request-app-update-install";
import {
  gateBlocksApp,
  useHostReadinessController,
  useSurfaceReadiness,
  windowNarratorOwns,
} from "@/components/layout/host-readiness-controller-context";
import { useAuthStore } from "@/stores/auth/auth-store";

const APP_UPDATE_TOAST_ID = "traycer-app-update";
const APP_UPDATE_TRANSIENT_TOAST_DURATION_MS = 4000;
const APP_UPDATE_REPORT_CONTEXT = createReportIssueContext({
  title: "Could not update Traycer",
  message: null,
  code: null,
  source: "App update",
});

interface DownloadProgressToastState {
  dismissed: boolean;
  active: boolean;
}

function prepareDownloadProgressToast(
  status: DesktopAppUpdateSnapshot["status"],
  state: DownloadProgressToastState,
): boolean {
  if (status !== "downloading") {
    // A terminal or reset state ends the dismissal scope. Mark the progress
    // toast inactive before replacing it because Sonner also invokes
    // `onDismiss` for programmatic removal and replacement.
    state.active = false;
    state.dismissed = false;
    return true;
  }
  if (state.dismissed) return false;
  state.active = true;
  return true;
}

export function AppUpdateToastController(): null {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openInstallGuidance = useDesktopDialogStore(
    (state) => state.openInstallGuidance,
  );
  const openReportIssueWithContext = useDesktopDialogStore(
    (state) => state.openReportIssueWithContext,
  );
  const reportIssueAvailable = useDesktopDialogStore(
    (state) => state.reportIssueAvailable,
  );
  // Whether the window narrator owns the frame - i.e. the full-screen host
  // modal is up because this machine's host is still being set up.
  //
  // Read here, in place, rather than by moving this mount: the controller
  // already renders inside `HostReadinessControllerProvider`, and it sits
  // outside the router deliberately so root-route bridges survive setup.
  //
  // SUPPRESSED ONLY WHILE THE BLOCKING DIALOG CAN BE UP - narrator-owned
  // readiness with the gate ALREADY OPEN, i.e. the ∅ dialog over a mounted
  // app, where a toast is visible but computed `pointer-events: none`
  // (measured). During the LAUNCH itself the narration is the startup CARD
  // now: no overlay, no pointer trap, and a pending update is at its most
  // actionable exactly there - a user staring at a slow first setup should be
  // able to take the update that may well contain the fix. That is also the
  // released behavior this restores; the old whole-launch suppression existed
  // because the launch surface used to be a modal.
  //
  // Same predicate inputs as the narrator's own presentation split
  // (`NarratingWindowHostModal`), so the two cannot disagree about whether a
  // dialog exists for this toast to be dead behind.
  const readiness = useSurfaceReadiness("default-host", null);
  const { hasBeenDefaultHostReady } = useHostReadinessController();
  const authStatus = useAuthStore((state) => state.status);
  const narrated =
    windowNarratorOwns(readiness) &&
    !gateBlocksApp({
      readiness,
      hasBeenReady: hasBeenDefaultHostReady,
      signedIn: authStatus === "signed-in",
      bypassed: false,
    });
  const handledSequenceRef = useRef(0);
  const handledReportCapabilityRef = useRef<boolean | null>(null);
  const bridgeRef = useRef<DesktopAppUpdatesBridge | null | undefined>(
    undefined,
  );
  const mountedAtMsRef = useRef<number | null>(null);
  const downloadProgressToastStateRef = useRef<DownloadProgressToastState>({
    dismissed: false,
    active: false,
  });

  useEffect(() => {
    mountedAtMsRef.current ??= Date.now();
    if (bridgeRef.current !== bridge) {
      const isInitialBridge = bridgeRef.current === undefined;
      bridgeRef.current = bridge;
      handledSequenceRef.current = 0;
      handledReportCapabilityRef.current = null;
      downloadProgressToastStateRef.current.dismissed = false;
      downloadProgressToastStateRef.current.active = false;
      if (!isInitialBridge) {
        mountedAtMsRef.current = Date.now();
      }
    }
    if (bridge === null) return;
    if (snapshot.sequence === 0) return;
    // SUPPRESS, DO NOT DROP. Ordered before the `handledSequenceRef` write
    // below on purpose: that write consumes the sequence, and the dedupe guard
    // beneath it would then treat this update as already handled for ever - the
    // toast would be silently lost, not deferred, and the header button would be
    // the only remaining route. An early return placed a few lines later reads
    // identical and behaves completely differently.
    //
    // `narrated` is in this effect's dependency list for the same reason: the
    // effect has to re-run when the narrator releases the frame, or the update
    // is dropped by a second route with the ordering above still correct.
    //
    // Re-emit on release rather than unfreeze in place. The toast cannot be
    // dismissed while the modal is up (measured: Radix's modal sets
    // `pointer-events: none` on the body and nothing in the Sonner subtree
    // re-enables it), and it carries `duration: Infinity`, so "leave it there"
    // means handing the user a notification they were unable to clear for the
    // whole of setup and that only becomes live afterwards. A fresh one arrives
    // at a moment they chose to be in.
    if (narrated) return;
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
    // Terminal download outcomes settle the window-local flow armed by a
    // download gesture; replayed snapshots in other windows are no-ops there.
    if (snapshot.status === "ready" || snapshot.status === "error") {
      settleUpdateDownloadOutcome(snapshot.status, snapshot.errorMessage);
    }
    const mountedAtMs = mountedAtMsRef.current;
    if (isManualReplayFromBeforeMount(snapshot, mountedAtMs)) {
      return;
    }

    showPreparedAppUpdateToast(
      snapshot,
      {
        onDownload: () => {
          trackUpdateDownloadStarted("direct_ui");
          void bridge.downloadUpdate();
        },
        // "Restart" installs straight away UNLESS some epic holds work that can
        // never sync. The old comment here read "the click is the confirmation,
        // and the host keeps running agents across the app restart" - both
        // clauses are still true and neither covers this: the click confirms a
        // RESTART, not the discarding of editor work the user was never told
        // about, and "agents keep running" is a promise about agents, not about a
        // retained `Y.Doc` with no transport for the host to keep anything alive
        // through.
        onRestart: () => {
          trackUpdateRestartRequested("direct_ui");
          void requestAppUpdateInstall(bridge);
        },
        onViewInstructions: () => {
          Analytics.getInstance().track(
            AnalyticsEvent.UpdateInstallGuidanceOpened,
            { source: "direct_ui" },
          );
          openInstallGuidance();
        },
        onReportIssue: reportIssueAvailable
          ? () => openReportIssueWithContext(APP_UPDATE_REPORT_CONTEXT)
          : null,
        onDownloadProgressDismiss: () => {
          const state = downloadProgressToastStateRef.current;
          if (!state.active) return;
          state.dismissed = true;
          state.active = false;
        },
      },
      downloadProgressToastStateRef.current,
    );
  }, [
    bridge,
    snapshot,
    narrated,
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
  readonly onDownloadProgressDismiss: () => void;
}

function showPreparedAppUpdateToast(
  snapshot: DesktopAppUpdateSnapshot,
  actions: AppUpdateToastActions,
  downloadProgressState: DownloadProgressToastState,
): void {
  if (!prepareDownloadProgressToast(snapshot.status, downloadProgressState)) {
    return;
  }
  showAppUpdateToast(snapshot, actions);
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
        onDismiss: actions.onDownloadProgressDismiss,
      });
      return;
    case "ready":
      // The restart was already requested (here, from the header tick, or from
      // another window) and the quit is draining. Replacing the action toast
      // with progress is what tells the user the click landed - the install
      // emits nothing further on success, it just ends the process - and it
      // retires the second "Restart" button before it can fire a duplicate.
      if (snapshot.installInFlight) {
        progressToast("Restarting to install update…", {
          id: APP_UPDATE_TOAST_ID,
          description: "Traycer will reopen once the update is applied.",
          duration: Infinity,
          cancel: null,
        });
        return;
      }
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
