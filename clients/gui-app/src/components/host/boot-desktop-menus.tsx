import { useEffect, type ReactNode } from "react";
import { AboutDetailsDialog } from "@/components/layout/dialogs/desktop/about-details-dialog";
import { LogsChooserDialog } from "@/components/layout/dialogs/desktop/logs-chooser-dialog";
import { useDesktopMenuBarActive } from "@/components/layout/header/use-desktop-menu-bar-active";
import {
  resolveDesktopMenuBridge,
  resolveDesktopSupportBridge,
} from "@/lib/windows/desktop-capabilities";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/**
 * Pre-runtime counterpart of the routed menu listener/dialog host. These
 * support actions need only preload, so failed host startup cannot strand
 * diagnostics behind a provider that has not mounted yet. The routed listener
 * takes over when this fallback unmounts; dialog state survives that handoff.
 */
export function BootDesktopMenus(props: {
  readonly onOpenSettings: () => void;
}): ReactNode {
  const { onOpenSettings } = props;
  const runnerHost = useRunnerHostOrNull();
  const active = useDesktopMenuBarActive();
  const menu =
    runnerHost === null ? null : resolveDesktopMenuBridge(runnerHost);
  const support =
    runnerHost === null ? null : resolveDesktopSupportBridge(runnerHost);
  const activeDialog = useDesktopDialogStore((state) => state.activeDialog);
  const close = useDesktopDialogStore((state) => state.close);

  useEffect(() => {
    if (!active || menu === null) return;
    const subscription = menu.onCommand(({ command }) => {
      const dialogs = useDesktopDialogStore.getState();
      if (command === "app.openSettings") onOpenSettings();
      else if (command === "app.openLogs") dialogs.openLogs();
      else if (command === "app.aboutDetails") dialogs.openAboutDetails();
    });
    return () => subscription.dispose();
  }, [active, menu, onOpenSettings]);

  if (!active) return null;
  return (
    <>
      <LogsChooserDialog
        open={activeDialog === "logs"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        support={support}
      />
      <AboutDetailsDialog
        open={activeDialog === "about-details"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        support={support}
      />
    </>
  );
}
