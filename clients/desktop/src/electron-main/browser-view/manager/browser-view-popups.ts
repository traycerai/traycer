import type { BrowserWindowConstructorOptions } from "electron";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { log } from "../../app/logger";
import {
  toTileKey,
  type BrowserViewEntry,
  type BrowserViewSend,
} from "./browser-view-entry";
import type {
  BrowserViewPopupWebContents,
  BrowserViewPopupWindow,
  BrowserViewWindowOpenDetails,
  BrowserViewWindowOpenResult,
} from "../browser-view-port";

interface BrowserViewPopupsOptions {
  readonly createPopupWindowOptions: (
    windowId: string,
  ) => BrowserWindowConstructorOptions;
  readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  readonly send: BrowserViewSend;
}

/**
 * Decision #22: real popups keep their opener as a native window, while
 * `target=_blank` and tab dispositions become Traycer tiles.
 */
export class BrowserViewPopups {
  private readonly createPopupWindowOptions: (
    windowId: string,
  ) => BrowserWindowConstructorOptions;
  private readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  private readonly send: BrowserViewSend;
  // ponytail: popups are opened with `parent` + `outlivesOpener: false`, but
  // `parent` degrades to undefined when the opener window record is missing,
  // so quit-time closing is not provably Electron's job. Tracked here only to
  // close them in `dispose()`.
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
      this.send(surface.windowId, RunnerHostEvent.browserViewOpenTileRequest, {
        ...toTileKey(surface),
        url: normalizeOpenedUrl(details.url, entry.currentUrl),
      });
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: this.createPopupWindowOptions(
        surface.windowId,
      ),
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

function normalizeOpenedUrl(url: string, baseUrl: string): string {
  if (url.length === 0) return "about:blank";
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}
