import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { isDevBuild } from "../../config";
import type {
  AppIconBadgeSnapshot,
  AppIconBadgeWindows,
} from "../windows/app-icon-badge-windows";
import { log } from "./logger";
import { applyOverlayIcon } from "./window-effects";

const DOCK_BADGE_MAX = 99;
const OVERLAY_BADGE_MAX = 9;

/** The Dock's text for `count`: `""` clears it. */
export function dockBadgeText(count: number): string {
  if (count === 0) return "";
  return count > DOCK_BADGE_MAX ? `${DOCK_BADGE_MAX}+` : String(count);
}

/** The `resources/badge/` image for `count`, `null` for none. */
export function overlayBadgeFileName(count: number): string | null {
  if (count === 0) return null;
  return count > OVERLAY_BADGE_MAX
    ? `badge-${OVERLAY_BADGE_MAX}-plus.png`
    : `badge-${count}.png`;
}

/** The overlay's accessible description: the real count, past the image's cap. */
export function overlayBadgeDescription(count: number): string {
  if (count === 0) return "";
  return count === 1 ? "1 notification" : `${count} notifications`;
}

function resolveBadgeDir(): string {
  // Shipped: `<resources>/badge`. Dev slot: `<appPath>/resources/badge`.
  return isDevBuild
    ? join(app.getAppPath(), "resources", "badge")
    : join(process.resourcesPath, "badge");
}

/**
 * Draws `windows`' count on the app icon for the rest of the process: the
 * macOS Dock, the Linux launcher (where the desktop shows counts), the
 * Windows taskbar overlay of every visible window, found by registry id
 * through `windowById`. A window hidden to the tray has no taskbar button, so
 * nothing is drawn for it; it is drawn again when it is shown. Installed
 * before the first window exists.
 */
export function installAppIconBadgeOutput(
  windows: AppIconBadgeWindows,
  windowById: (windowId: string) => BrowserWindow | null,
): void {
  switch (process.platform) {
    case "darwin": {
      let shown = "";
      windows.subscribe(({ count }) => {
        const text = dockBadgeText(count);
        if (text === shown) return;
        shown = text;
        app.dock?.setBadge(text);
      });
      return;
    }
    case "linux": {
      let shown = 0;
      windows.subscribe(({ count }) => {
        if (count === shown) return;
        shown = count;
        const applied = app.setBadgeCount(count);
        log.debug("[app-icon-badge] launcher count set", { count, applied });
      });
      return;
    }
    case "win32": {
      const badgeDir = resolveBadgeDir();
      windows.subscribe((snapshot) => {
        drawOverlays(snapshot, badgeDir, windowById);
      });
      return;
    }
    default:
      return;
  }
}

function drawOverlays(
  { count, visibleWindowIds }: AppIconBadgeSnapshot,
  badgeDir: string,
  windowById: (windowId: string) => BrowserWindow | null,
): void {
  const fileName = overlayBadgeFileName(count);
  const image = fileName === null ? null : join(badgeDir, fileName);
  const description = overlayBadgeDescription(count);
  for (const windowId of visibleWindowIds) {
    const window = windowById(windowId);
    if (window === null || window.isDestroyed()) continue;
    applyOverlayIcon(window, image, description);
  }
}
