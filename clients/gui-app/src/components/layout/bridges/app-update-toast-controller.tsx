import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

const APP_UPDATE_TOAST_ID = "traycer-app-update";
const APP_UPDATE_TRANSIENT_TOAST_DURATION_MS = 4000;

export function AppUpdateToastController(): null {
  const { bridge, snapshot } = useDesktopAppUpdates();
  const openReportIssue = useDesktopDialogStore(
    (state) => state.openReportIssue,
  );
  const openConfirmRestartUpdate = useDesktopDialogStore(
    (state) => state.openConfirmRestartUpdate,
  );
  const handledSequenceRef = useRef(0);
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
      if (!isInitialBridge) {
        mountedAtMsRef.current = Date.now();
      }
    }
    if (bridge === null) return;
    if (snapshot.sequence === 0) return;
    if (handledSequenceRef.current >= snapshot.sequence) return;
    handledSequenceRef.current = snapshot.sequence;
    const mountedAtMs = mountedAtMsRef.current;
    if (isManualReplayFromBeforeMount(snapshot, mountedAtMs)) {
      return;
    }

    showAppUpdateToast(snapshot, {
      onDownload: () => {
        void bridge.downloadUpdate();
      },
      onRestart: openConfirmRestartUpdate,
      onReportIssue: openReportIssue,
    });
  }, [bridge, snapshot, openReportIssue, openConfirmRestartUpdate]);

  return null;
}

interface AppUpdateToastActions {
  readonly onDownload: () => void;
  readonly onRestart: () => void;
  readonly onReportIssue: () => void;
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
        },
      );
      return;
    case "downloading":
      toast.loading("Downloading update…", {
        id: APP_UPDATE_TOAST_ID,
        description:
          snapshot.downloadProgress === null
            ? "Starting download…"
            : `${snapshot.downloadProgress}% complete`,
        duration: Infinity,
      });
      return;
    case "ready":
      toast(
        <AppUpdateActionToastContent
          title="Update ready to install"
          description="Restart Traycer to finish updating."
          actionLabel="Restart"
          onAction={actions.onRestart}
        />,
        {
          id: APP_UPDATE_TOAST_ID,
          description: null,
          duration: Infinity,
        },
      );
      return;
    case "error":
      toast.error("Couldn't update Traycer", {
        id: APP_UPDATE_TOAST_ID,
        description: (
          <AppUpdateErrorToastDescription
            message={snapshot.errorMessage}
            onReportIssue={actions.onReportIssue}
          />
        ),
        duration: Infinity,
      });
      return;
    case "up-to-date":
      toast.success("Traycer is up to date", {
        id: APP_UPDATE_TOAST_ID,
        description:
          snapshot.currentVersion.length === 0
            ? null
            : `Current version: v${snapshot.currentVersion}`,
        duration: APP_UPDATE_TRANSIENT_TOAST_DURATION_MS,
      });
      return;
    case "unavailable":
      toast.info("Updates are not available for this build.", {
        id: APP_UPDATE_TOAST_ID,
        description: null,
        duration: APP_UPDATE_TRANSIENT_TOAST_DURATION_MS,
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
  readonly onReportIssue: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      {props.message === null ? null : <span>{props.message}</span>}
      <Button type="button" size="sm" onClick={props.onReportIssue}>
        Report an issue
      </Button>
    </div>
  );
}
