import type { BrowserWindowConstructorOptions } from "electron";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { log } from "../../app/logger";
import {
  installGuestNavigationGuard,
  isAllowedGuestNavigationUrl,
  traceRefusedGuestNavigation,
} from "../browser-guest-navigation";
import {
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./browser-view-entry";
import type { BrowserSessionProfileRequest } from "../browser-session";
import type {
  BrowserViewPopupWebContents,
  BrowserViewPopupWindow,
  BrowserViewWindowOpenDetails,
  BrowserViewWindowOpenResult,
} from "../browser-view-port";

interface BrowserViewPopupsOptions {
  readonly createPopupWindowOptions: (
    request: BrowserSessionProfileRequest,
  ) => BrowserWindowConstructorOptions;
  readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  readonly send: BrowserViewSend;
}

/**
 * Decision #22: real popups keep their opener as a native window, while
 * `target=_blank` and tab dispositions become Traycer tiles carrying
 * Chromium's disposition (`background-tab` -> background, else foreground).
 */
export class BrowserViewPopups {
  private readonly createPopupWindowOptions: (
    request: BrowserSessionProfileRequest,
  ) => BrowserWindowConstructorOptions;
  private readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  private readonly send: BrowserViewSend;
  /**
   * A native popup is still a browser guest. Keep the policy install keyed by
   * WebContents so a duplicate did-create-window delivery cannot stack
   * handlers, while allowing each popup to recursively create policy-bound
   * children of its own.
   */
  private readonly policyInstalledOn =
    new WeakSet<BrowserViewPopupWebContents>();
  private readonly trackedPopupWindows = new WeakSet<BrowserViewPopupWindow>();
  // `outlivesOpener: false` preserves Chromium's opener lifetime, while these
  // windows intentionally have no native BrowserWindow parent: a native child
  // of a fullscreen macOS window can black out its owner after closing. Keep
  // tracking them so manager disposal closes any popup that is still alive.
  private readonly openWindows = new Set<BrowserViewPopupWindow>();

  constructor(options: BrowserViewPopupsOptions) {
    this.createPopupWindowOptions = options.createPopupWindowOptions;
    this.registerPopupWebContents = options.registerPopupWebContents;
    this.send = options.send;
  }

  handleWindowOpen(
    entry: BrowserViewEntry,
    details: BrowserViewWindowOpenDetails,
  ): BrowserViewWindowOpenResult {
    const surface = entry.surface;
    if (surface === null) return { action: "deny" };
    // The third door the guest scheme gate has to cover: a guest CAN open
    // windows, and both outcomes below carry the target onward - one into a
    // new tile, one into a real popup on the opener's jar. Resolved against
    // the opener first, because `window.open("/x")` is relative and a scheme
    // check on the raw string would be checking the wrong string.
    const target = normalizeOpenedUrl(details.url, entry.currentUrl);
    if (!isAllowedGuestNavigationUrl(target)) {
      traceRefusedGuestNavigation(target, "window-open");
      return { action: "deny" };
    }
    // Electron exposes featureless scripted window.open the same as _blank
    // tab opens, so the available guardrail is non-empty popup features.
    if (windowOpenShouldCreateTile(details)) {
      this.send(surface.windowId, RunnerHostEvent.browserViewOpenTileRequest, {
        ...toTileKey(surface),
        url: target,
        disposition:
          details.disposition === "background-tab"
            ? "background"
            : "foreground",
      });
      return { action: "deny" };
    }
    return {
      action: "allow",
      // A popup shares its opener's jar; same profile, same session id.
      overrideBrowserWindowOptions: this.createPopupWindowOptions({
        profile: entry.profile,
        sessionId: entry.identity.key.sessionId,
      }),
      outlivesOpener: false,
    };
  }

  handleDidCreateWindow(
    entry: BrowserViewEntry,
    window: BrowserViewPopupWindow,
  ): void {
    if (entry.surface === null) {
      window.close();
      return;
    }
    if (this.trackedPopupWindows.has(window)) return;
    this.trackedPopupWindows.add(window);
    this.registerPopupWebContents(window.webContents);
    this.installPopupPolicy(entry, window.webContents);
    this.openWindows.add(window);
    window.on("closed", () => {
      this.openWindows.delete(window);
    });
    log.info("[browser-view] popup created", {
      openerWebContentsId: entry.webContents.id,
      popupWebContentsId: window.webContents.id,
    });
  }

  private installPopupPolicy(
    entry: BrowserViewEntry,
    webContents: BrowserViewPopupWebContents,
  ): void {
    if (this.policyInstalledOn.has(webContents)) return;
    this.policyInstalledOn.add(webContents);
    installGuestNavigationGuard(webContents);
    webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpen(entry, details),
    );
    webContents.on("did-create-window", (window: BrowserViewPopupWindow) => {
      this.handleDidCreateWindow(entry, window);
    });
  }

  dispose(): void {
    for (const window of Array.from(this.openWindows)) {
      this.openWindows.delete(window);
      if (!window.isDestroyed()) window.close();
    }
  }
}

function windowOpenShouldCreateTile(
  details: BrowserViewWindowOpenDetails,
): boolean {
  if (
    details.disposition === "foreground-tab" ||
    details.disposition === "background-tab"
  ) {
    return true;
  }
  if (details.features.trim().length > 0) return false;
  if (details.frameName === "_blank") return true;
  return false;
}

function normalizeOpenedUrl(url: string, baseUrl: string): string {
  if (url.length === 0) return "about:blank";
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}
