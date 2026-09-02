import type { BrowserWindowConstructorOptions } from "electron";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { log } from "../../app/logger";
import { safelyOpenExternal } from "../../app/security";
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
 * Non-http(s) targets are not tiles at all: they leave to the OS through
 * `safelyOpenExternal`'s scheme allowlist, and no tile request is sent. The
 * one exception is `about:blank` - a page opening a blank tab it will
 * navigate itself, which stays in the session (see {@link isTileTarget}).
 */
export class BrowserViewPopups {
  private readonly createPopupWindowOptions: (
    request: BrowserSessionProfileRequest,
  ) => BrowserWindowConstructorOptions;
  private readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  private readonly send: BrowserViewSend;
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
    // Electron exposes featureless scripted window.open the same as _blank
    // tab opens, so the available guardrail is non-empty popup features.
    if (windowOpenShouldCreateTile(details)) {
      const url = normalizeOpenedUrl(details.url, entry.currentUrl);
      // A4: only web URLs become tiles. mailto:/custom schemes go to the OS
      // through the existing allowlist, which rejects the opaque ones.
      if (!isTileTarget(url)) {
        void safelyOpenExternal(url);
        return { action: "deny" };
      }
      this.send(surface.windowId, RunnerHostEvent.browserViewOpenTileRequest, {
        ...toTileKey(surface),
        url,
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
    this.registerPopupWebContents(window.webContents);
    this.openWindows.add(window);
    window.on("closed", () => {
      this.openWindows.delete(window);
    });
    log.info("[browser-view] popup created", {
      openerWebContentsId: entry.view.webContents.id,
      popupWebContentsId: window.webContents.id,
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

/**
 * `about:blank` is a page opening its own blank tab before navigating it - a
 * tile target, not an OS handoff. `safelyOpenExternal` rejects the `about:`
 * scheme, so classifying it as external would leave the user with no popup
 * AND no tile.
 */
function isTileTarget(url: string): boolean {
  return url === "about:blank" || isWebUrl(url);
}

function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeOpenedUrl(url: string, baseUrl: string): string {
  if (url.length === 0) return "about:blank";
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}
