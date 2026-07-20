import { Menu, Tray, app, nativeImage } from "electron";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { platform as nodePlatform } from "node:process";
import { isDevBuild } from "../../config";
import type {
  DesktopTrayEpic,
  DesktopTrayIndicatorState,
} from "../../ipc-contracts/host-types";
import type { MenuCommandId } from "../../ipc-contracts/window-types";
import { log } from "../app/logger";

// Stable GUID so Windows preserves tray icon position across explorer
// restarts and app upgrades. Only takes effect on signed Windows builds.
const TRAY_GUID = "9b1d3a7e-4c52-4f8a-bd62-3e7f1a8c5d09";

// Recent epics rendered inline; any beyond this collapse into a "More" submenu.
const TRAY_EPIC_PRIMARY_LIMIT = 5;

/**
 * Inputs to `resolveTrayIconPath`. Kept as plain data so the helper is
 * unit-testable without spinning up an Electron process. The `trayDir`
 * field is the absolute directory that contains the tray asset PNGs -
 * shipped builds populate it from `<process.resourcesPath>/tray`, the dev
 * slot resolves it from the workspace `resources/tray`.
 */
export interface TrayAssetContext {
  readonly platform: NodeJS.Platform;
  readonly trayDir: string;
}

export interface TrayIconAsset {
  readonly path: string;
  readonly isTemplate: boolean;
}

export function buildTrayAssetContext(): TrayAssetContext {
  return {
    platform: nodePlatform,
    trayDir: resolveTrayDir(),
  };
}

function resolveTrayDir(): string {
  // Shipped: `<resources>/tray`. Dev slot: `<appPath>/resources/tray`.
  return isDevBuild
    ? join(app.getAppPath(), "resources", "tray")
    : join(process.resourcesPath, "tray");
}

/**
 * Resolves the on-disk location of the tray icon for the current platform.
 * macOS uses a black-on-alpha template image so AppKit inverts it for the
 * active menu-bar appearance; every other platform uses an opaque white
 * glyph so the icon stays visible against dark trays.
 */
export function resolveTrayIconPath(ctx: TrayAssetContext): TrayIconAsset {
  const isMac = ctx.platform === "darwin";
  const baseName = isMac ? "trayTemplate.png" : "tray.png";
  return { path: join(ctx.trayDir, baseName), isTemplate: isMac };
}

/**
 * Loads the resolved tray asset into a `nativeImage`. Throws with a
 * targeted message when the file is missing or fails to decode so the caller
 * (`createTraySafe`) logs an actionable diagnostic instead of silently
 * falling back to an invisible tray.
 *
 * Resolved and awaited in `createTraySafe` before the `Tray` is
 * constructed, so the asset probe and image decode can be async: we
 * `await access(F_OK)` (throws on missing) then decode.
 */
export async function loadTrayIconImage(
  asset: TrayIconAsset,
): Promise<Electron.NativeImage> {
  try {
    await access(asset.path, constants.F_OK);
  } catch {
    throw new Error(
      `[tray] icon asset missing at ${asset.path} - regenerate via 'bun scripts/assets/generate-tray-icons.cjs' or stage the resources/tray directory.`,
    );
  }
  const image = nativeImage.createFromPath(asset.path);
  if (image.isEmpty()) {
    throw new Error(
      `[tray] icon at ${asset.path} could not be decoded as a native image`,
    );
  }
  if (asset.isTemplate) {
    image.setTemplateImage(true);
  }
  return image;
}

/**
 * Optional wiring the desktop entrypoint passes in so the tray controller
 * stays free of `ipcMain` imports. `RunnerIpcBridge` owns the actual IPC send
 * and exposes a `deliverTrayEpicSelected` helper that the entrypoint binds
 * into this callback after both the bridge and the tray exist.
 */
export interface DesktopTrayControllerOptions {
  readonly onEpicSelected: ((epicId: string) => void) | null;
  // `hostUpdateVersion` is the version captured into a `host.installUpdate`
  // item when that row was built ("Update to <version>"). Every other command
  // passes `null`. The callback must not re-read live presentation state -
  // an already-open native menu can still fire the old item's click after
  // presentation has moved on.
  readonly onCommand:
    ((command: MenuCommandId, hostUpdateVersion: string | null) => void) | null;
}

/**
 * Subset of `BrowserWindow` the tray controller depends on. Declaring the
 * minimum surface keeps the controller testable without constructing a
 * real Electron window - callers still pass a full `BrowserWindow` at
 * runtime because that shape structurally satisfies this interface.
 */
export interface TrayManagedWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

export type DesktopTrayAuthStatus = "signed-in" | "signed-out" | "signing-in";

export interface DesktopTrayAccount {
  readonly name: string | null;
  readonly email: string;
}

export interface DesktopTrayPresentation {
  readonly authStatus: DesktopTrayAuthStatus;
  // Present only when signed in; rendered as a disabled identity row directly
  // above the Sign Out action.
  readonly account: DesktopTrayAccount | null;
  readonly canCheckForUpdates: boolean;
  // Surfaced from the launch-time registry probe. When non-null, the menu
  // inserts an `Update to <version>` row that dispatches `host.installUpdate`
  // through the CLI-backed host-management bridge.
  readonly hostUpdateAvailableVersion: string | null;
}

/**
 * Identity line shown beside the Sign Out action: `Name (email)` when a
 * display name is known, otherwise just the email.
 */
function formatAccountLabel(account: DesktopTrayAccount): string {
  return account.name !== null
    ? `${account.name} (${account.email})`
    : account.email;
}

/**
 * Native tray controller. The recent-epic list and indicator transitions are
 * driven by the renderer via `ipcRenderer.invoke` (`tray:setEpics` /
 * `tray:setIndicator`); `gui-app` sources the epics from the same history
 * store that backs the in-app epic list.
 */
export class DesktopTrayController {
  private readonly tray: Tray;
  private readonly window: TrayManagedWindow;
  private epics: readonly DesktopTrayEpic[] = [];
  private indicator: DesktopTrayIndicatorState = "idle";
  private presentation: DesktopTrayPresentation = {
    authStatus: "signed-out",
    account: null,
    canCheckForUpdates: false,
    hostUpdateAvailableVersion: null,
  };
  private onEpicSelected: ((epicId: string) => void) | null;
  private onCommand:
    ((command: MenuCommandId, hostUpdateVersion: string | null) => void) | null;

  constructor(
    window: TrayManagedWindow,
    image: Electron.NativeImage,
    options: DesktopTrayControllerOptions,
  ) {
    this.window = window;
    this.onEpicSelected = options.onEpicSelected;
    this.onCommand = options.onCommand;
    this.tray = new Tray(image, TRAY_GUID);
    this.tray.setToolTip("Traycer");
    this.tray.on("click", () => this.showMainWindow());
    this.rebuildMenu();
  }

  /**
   * Lets the entrypoint install the epic-selected sink after the
   * controller and the `RunnerIpcBridge` have both been constructed.
   */
  setEpicSelectedHandler(handler: ((epicId: string) => void) | null): void {
    this.onEpicSelected = handler;
  }

  setCommandHandler(
    handler:
      | ((command: MenuCommandId, hostUpdateVersion: string | null) => void)
      | null,
  ): void {
    this.onCommand = handler;
  }

  setEpics(epics: readonly DesktopTrayEpic[]): void {
    this.epics = epics;
    this.rebuildMenu();
  }

  setIndicator(state: DesktopTrayIndicatorState): void {
    this.indicator = state;
    this.tray.setToolTip(`Traycer (${state})`);
  }

  setPresentation(presentation: DesktopTrayPresentation): void {
    this.presentation = presentation;
    this.rebuildMenu();
  }

  dispose(): void {
    this.tray.destroy();
  }

  private showMainWindow(): void {
    if (this.window.isDestroyed()) {
      return;
    }
    if (!this.window.isVisible()) {
      this.window.show();
    }
    this.window.focus();
  }

  private rebuildMenu(): void {
    // Text-forward, grouped layout that mirrors the native system menus:
    // primary action, the recent-epic list (overflow folds into a "More"
    // submenu), quick actions, the signed-in identity beside Sign Out, and
    // Quit isolated at the bottom. No per-item icons - they read as oversized
    // clutter in a native menu and the references we match are plain text.
    const toEpicItem = (epic: DesktopTrayEpic) => ({
      label: epic.title,
      sublabel: epic.subtitle,
      click: () => {
        // Bring the app forward, then ask the renderer to open the epic in
        // the owned-or-MRU window.
        this.showMainWindow();
        if (this.onEpicSelected !== null) {
          this.onEpicSelected(epic.epicId);
        }
      },
    });
    const epicItems =
      this.epics.length === 0
        ? [{ label: "No recent epics", enabled: false }]
        : [
            ...this.epics.slice(0, TRAY_EPIC_PRIMARY_LIMIT).map(toEpicItem),
            ...(this.epics.length > TRAY_EPIC_PRIMARY_LIMIT
              ? [
                  {
                    label: "More",
                    submenu: this.epics
                      .slice(TRAY_EPIC_PRIMARY_LIMIT)
                      .map(toEpicItem),
                  },
                ]
              : []),
          ];

    const { authStatus, account } = this.presentation;
    const isSignedIn = authStatus === "signed-in";
    // `account` is contractually only populated when signed in. Gate on
    // `isSignedIn` too so a sign-out/sign-in transition that leaves stale
    // account data in the presentation can't render the previous identity
    // above the "Sign In" row.
    const accountItems =
      isSignedIn && account !== null
        ? [{ label: formatAccountLabel(account), enabled: false }]
        : [];
    // Capture the labelled version into the item's click closure. An open
    // native tray menu can still fire this click after presentation has been
    // rebuilt to a different version; re-reading live state would send the
    // new version and defeat main's expected-version guard (cold-review #3).
    const hostUpdateVersion = this.presentation.hostUpdateAvailableVersion;
    const updateItems =
      hostUpdateVersion !== null
        ? [
            {
              label: `Update to ${hostUpdateVersion}`,
              click: () =>
                this.runCommand("host.installUpdate", hostUpdateVersion),
            },
          ]
        : [];
    const menu = Menu.buildFromTemplate([
      {
        label: "Open Traycer",
        click: () => this.showMainWindow(),
      },
      { type: "separator" },
      ...epicItems,
      { type: "separator" },
      {
        label: "Settings…",
        click: () => this.runCommand("app.openSettings", null),
      },
      ...updateItems,
      {
        label: "Check for Updates",
        enabled: this.presentation.canCheckForUpdates,
        click: () => this.runCommand("app.checkForUpdates", null),
      },
      {
        label: "Restart Host",
        click: () => this.runCommand("host.restart", null),
      },
      {
        label: "Open Logs",
        click: () => this.runCommand("app.openLogs", null),
      },
      { type: "separator" },
      ...accountItems,
      {
        label: isSignedIn ? "Sign Out" : "Sign In",
        enabled: authStatus !== "signing-in",
        click: () =>
          this.runCommand(isSignedIn ? "app.signOut" : "app.signIn", null),
      },
      { type: "separator" },
      {
        label: "Quit Traycer",
        click: () => {
          log.info("[tray] quitting from tray menu");
          app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  private runCommand(
    command: MenuCommandId,
    hostUpdateVersion: string | null,
  ): void {
    if (this.onCommand === null) {
      return;
    }
    // Tray commands fire while the app is backgrounded or hidden, and the
    // renderer that handles them lives in the main window - surface it so
    // the user sees the result (settings pane, sign-in screen, confirm
    // modal) instead of it landing in an invisible window.
    this.showMainWindow();
    this.onCommand(command, hostUpdateVersion);
  }
}
