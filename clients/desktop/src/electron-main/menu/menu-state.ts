import type { DesktopPublishedHostSnapshot } from "../../ipc-contracts/host-types";
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
  // Whether this instance runs the local-host lanes (off when booted in
  // `none` or once `none` is committed this session). "Restart Host" is
  // offered only then: otherwise the restart is refused, and a destructive
  // confirm for an action the app has already ruled out is a dead control.
  // The same fact the tray reads (`trayHostLifecyclePresentation`).
  readonly offerRestartHost: boolean;
}

export function toMenuHostPresentation(
  snapshot: DesktopPublishedHostSnapshot | null,
): MenuHostPresentation {
  if (snapshot === null) {
    return { status: "starting", version: null };
  }
  return { status: "ready", version: snapshot.version };
}
