import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDesktopAppUpdates } from "@/hooks/runner/use-desktop-app-updates";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

const APP_UPDATE_TOAST_ID = "traycer-app-update";

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
        });
      }
      return;
    case "available":
      // A quiet, dismissible heads-up - the header button is the persistent
      // fallback once it's dismissed.
      toast("Update available", {
        id: APP_UPDATE_TOAST_ID,
        description: updateAvailableDescription(snapshot.latestVersion),
        duration: Infinity,
        action: {
          label: "Download",
          onClick: actions.onDownload,
        },
        cancel: {
          label: "Later",
          onClick: () => {
            toast.dismiss(APP_UPDATE_TOAST_ID);
          },
        },
      });
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
      toast("Update ready to install", {
        id: APP_UPDATE_TOAST_ID,
        description: "Restart Traycer to finish updating.",
        duration: Infinity,
        action: {
          label: "Restart",
          onClick: actions.onRestart,
        },
        cancel: {
          label: "Later",
          onClick: () => {
            toast.dismiss(APP_UPDATE_TOAST_ID);
          },
        },
      });
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
            ? undefined
            : `Current version: v${snapshot.currentVersion}`,
      });
      return;
    case "unavailable":
      toast.info("Updates are not available for this build.", {
        id: APP_UPDATE_TOAST_ID,
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
  return (
    snapshot.lastCheckIntent === "manual" &&
    (snapshot.status === "checking" ||
      snapshot.status === "up-to-date" ||
      snapshot.status === "unavailable" ||
      snapshot.status === "error")
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
