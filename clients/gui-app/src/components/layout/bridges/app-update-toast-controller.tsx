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

    showAppUpdateToast(snapshot, bridge, openReportIssue);
  }, [bridge, snapshot, openReportIssue]);

  return null;
}

function showAppUpdateToast(
  snapshot: DesktopAppUpdateSnapshot,
  bridge: DesktopAppUpdatesBridge,
  onReportIssue: () => void,
): void {
  switch (snapshot.status) {
    case "checking":
      if (snapshot.lastCheckIntent === "manual") {
        toast.info("Checking for Traycer updates...", {
          id: APP_UPDATE_TOAST_ID,
        });
      }
      return;
    case "downloading":
      if (snapshot.lastCheckIntent === "manual") {
        toast.info("Downloading Traycer update...", {
          id: APP_UPDATE_TOAST_ID,
        });
      }
      return;
    case "ready":
      toast("Traycer update ready", {
        id: APP_UPDATE_TOAST_ID,
        description: updateReadyDescription(snapshot.latestVersion),
        duration: Infinity,
        action: {
          label: "Restart",
          onClick: () => {
            void bridge.installUpdate();
          },
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
            onReportIssue={onReportIssue}
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

function updateReadyDescription(latestVersion: string | null): string {
  if (latestVersion === null) {
    return "Restart Traycer to install the downloaded update.";
  }
  return `Restart Traycer to install v${latestVersion}.`;
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
      snapshot.status === "downloading" ||
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
