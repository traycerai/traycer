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
import type { TileFindOwnerBlocker } from "@/stores/tile-find/types";

const EPIC_CANVAS_ROUTE_PATTERN = /^\/epics\/[^/]+\/[^/]+\/?$/;

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

function resolveTileFindOwnerBlocker(args: {
  readonly pathname: string;
  readonly commandPaletteOpen: boolean;
  readonly systemOverlayActive: boolean;
  readonly appDialogActive: boolean;
  readonly desktopDialogActive: boolean;
  readonly migrationDialogActive: boolean;
  readonly notificationPopoverOpen: boolean;
  readonly domDialogActive: boolean;
}): TileFindOwnerBlocker | null {
  if (!EPIC_CANVAS_ROUTE_PATTERN.test(args.pathname)) {
    return { reason: "non-canvas-route", ownerId: args.pathname };
  }
  if (args.commandPaletteOpen) {
    return { reason: "command-palette", ownerId: "command-palette" };
  }
  if (args.systemOverlayActive) {
    return { reason: "system-overlay", ownerId: "system-overlay" };
  }
  if (args.appDialogActive) {
    return { reason: "app-dialog", ownerId: "app-dialog" };
  }
  if (args.desktopDialogActive) {
    return { reason: "desktop-dialog", ownerId: "desktop-dialog" };
  }
  if (args.migrationDialogActive) {
    return { reason: "migration-dialog", ownerId: "migration-dialog" };
  }
  if (args.notificationPopoverOpen) {
    return { reason: "notification-popover", ownerId: "notifications" };
  }
  if (args.domDialogActive) {
    return { reason: "dom-dialog", ownerId: "dom-dialog" };
  }
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
