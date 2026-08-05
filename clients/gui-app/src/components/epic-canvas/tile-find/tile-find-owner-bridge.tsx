import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import { parseSystemTabOverlayView } from "@/lib/system-tab-overlay-search";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";
import { useAppDialogStore } from "@/stores/dialogs/app-dialog-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useMigrationRunStore } from "@/stores/migration/migration-run-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useTileFindStore } from "@/stores/tile-find";
import { resolveTileFindOwnerBlocker } from "@/components/epic-canvas/tile-find/tile-find-owner-blocker";

export function TileFindOwnerBridge(): ReactNode {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const systemOverlayActive = useRouterState({
    select: (state) => {
      const overlay = parseSystemTabOverlayView(state.location.search);
      return overlay.settingsOverlay || overlay.historyOverlay;
    },
  });
  const commandPaletteOpen = useCommandPaletteStore((state) => state.open);
  const appDialogActive = useAppDialogStore(
    (state) => state.activeDialog !== null,
  );
  const desktopDialogActive = useDesktopDialogStore(
    (state) => state.activeDialog !== null,
  );
  const notificationPopoverOpen = useNotificationsPopoverStore(
    (state) => state.open,
  );
  const migrationDialogActive = useMigrationRunStore(
    (state) =>
      state.status === "running" ||
      state.status === "error" ||
      state.remoteRunning,
  );
  const domDialogActive = useBlockingDomDialogActive();
  const setOwnerBlocker = useTileFindStore((state) => state.setOwnerBlocker);

  const blocker = useMemo(
    () =>
      resolveTileFindOwnerBlocker({
        pathname,
        commandPaletteOpen,
        systemOverlayActive,
        appDialogActive,
        desktopDialogActive,
        migrationDialogActive,
        notificationPopoverOpen,
        domDialogActive,
      }),
    [
      appDialogActive,
      commandPaletteOpen,
      desktopDialogActive,
      domDialogActive,
      migrationDialogActive,
      notificationPopoverOpen,
      pathname,
      systemOverlayActive,
    ],
  );

  useEffect(() => {
    setOwnerBlocker(blocker);
  }, [blocker, setOwnerBlocker]);

  useEffect(
    () => () => {
      setOwnerBlocker(null);
    },
    [setOwnerBlocker],
  );

  return null;
}

function useBlockingDomDialogActive(): boolean {
  return useSyncExternalStore(
    subscribeBlockingDomDialog,
    hasBlockingDomDialog,
    () => false,
  );
}

function subscribeBlockingDomDialog(listener: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(listener);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-state", "role"],
  });
  return () => {
    observer.disconnect();
  };
}

function hasBlockingDomDialog(): boolean {
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll(
    '[role="dialog"][data-state="open"]',
  );
  return Array.from(dialogs).some((dialog) => {
    if (!(dialog instanceof HTMLElement)) return true;
    return dialog.closest("[data-tile-find-scope]") === null;
  });
}
