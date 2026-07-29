import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  WindowSummary,
} from "../../ipc-contracts/window-types";

export interface MenuHostPresentation {
  readonly status: "ready" | "starting";
  readonly version: string | null;
}

export interface MenuState {
  readonly appName: string;
  readonly platform: NodeJS.Platform;
  readonly authSession: DesktopAuthSessionSnapshot;
  readonly host: MenuHostPresentation;
  readonly windows: readonly WindowSummary[];
  readonly focusedWindowId: string | null;
  readonly canCloseTab: boolean;
  readonly canCheckForUpdates: boolean;
  readonly canOpenDevTools: boolean;
  // The launch-time host-registry probe surfaces an available version
  // here when an upgrade is queued (Flow 6). `null` means no update is
  // pending. The tray and macOS app menus use it to insert an update row.
  readonly hostUpdateAvailableVersion: string | null;
}

export function toMenuHostPresentation(
  snapshot: DesktopLocalHostSnapshot | null,
): MenuHostPresentation {
  if (snapshot === null) {
    return { status: "starting", version: null };
  }
  return { status: "ready", version: snapshot.version };
}
