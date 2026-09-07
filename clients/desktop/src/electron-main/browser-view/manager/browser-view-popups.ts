import type { BrowserWindowConstructorOptions, Event } from "electron";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import { log } from "../../app/logger";
import {
  handleExternalGuestScheme,
  installGuestNavigationGuard,
  isAllowedGuestNavigationUrl,
  traceRefusedGuestNavigation,
} from "../browser-guest-navigation";
import {
  trackBrowserViewPopupGesture,
  type BrowserViewPopupGesture,
} from "./browser-view-popup-gesture";
import { toTileKey, type BrowserViewSend } from "./browser-view-entry";
import type { BrowserViewEntryKey } from "./browser-view-entry-registry";
import type {
  BrowserViewPopupCreateWindowOptions,
  BrowserViewPopupWebContents,
  BrowserViewPopupWindow,
  BrowserViewWindowOpenDetails,
  BrowserViewWindowOpenResult,
} from "../browser-view-port";

/** Bounded so a page holding a real gesture stream cannot paper the desktop in windows. */
export const MAX_BROWSER_VIEW_POPUPS = 4;

interface PopupGestureOpener {
  readonly on: NodeJS.EventEmitter["on"];
  readonly off: NodeJS.EventEmitter["off"];
}

interface BrowserViewPopupOpener {
  readonly surface: BrowserViewEntryKey | null;
  readonly currentUrl: string;
}

interface BrowserViewPopupsOptions {
  readonly createPopupWindowOptions: () => BrowserWindowConstructorOptions;
  readonly createPopupWindow: (input: {
    readonly windowOptions: BrowserWindowConstructorOptions;
    readonly createWindowOptions: BrowserViewPopupCreateWindowOptions;
  }) => BrowserViewPopupWindow;
  readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  readonly send: BrowserViewSend;
}

export class BrowserViewPopups {
  private readonly createPopupWindowOptions: () => BrowserWindowConstructorOptions;
  private readonly createPopupWindow: (input: {
    readonly windowOptions: BrowserWindowConstructorOptions;
    readonly createWindowOptions: BrowserViewPopupCreateWindowOptions;
  }) => BrowserViewPopupWindow;
  private readonly registerPopupWebContents: (
    webContents: BrowserViewPopupWebContents,
  ) => void;
  private readonly send: BrowserViewSend;
  /** Keep the policy install keyed by WebContents so a duplicate delivery cannot stack handlers, while allowing each popup to recursively create policy-bound children of its own. */
  private readonly policyInstalledOn =
    new WeakSet<BrowserViewPopupWebContents>();
  private readonly trackedPopupWindows = new WeakSet<BrowserViewPopupWindow>();
  private readonly openWindows = new Set<BrowserViewPopupWindow>();
  private readonly gestures = new WeakMap<
    PopupGestureOpener,
    BrowserViewPopupGesture
  >();

  constructor(options: BrowserViewPopupsOptions) {
    this.createPopupWindowOptions = options.createPopupWindowOptions;
    this.createPopupWindow = options.createPopupWindow;
    this.registerPopupWebContents = options.registerPopupWebContents;
    this.send = options.send;
  }

  installGuestGesture(opener: PopupGestureOpener): void {
    if (this.gestures.has(opener)) return;
    const gesture = trackBrowserViewPopupGesture(opener, () => Date.now());
    this.gestures.set(opener, gesture);
    opener.on("destroyed", () => {
      this.gestures.delete(opener);
      gesture.dispose();
    });
  }

  hadRecentGuestGesture(opener: PopupGestureOpener): boolean {
    return this.gestures.get(opener)?.peek() ?? false;
  }

  handleWindowOpen(
    opener: BrowserViewPopupOpener,
    details: BrowserViewWindowOpenDetails,
    gestureOpener: PopupGestureOpener,
  ): BrowserViewWindowOpenResult {
    const surface = opener.surface;
    if (surface === null) return { action: "deny" };
    // Resolved against the opener first, because `window.open("/x")` is relative and a scheme check on the raw string would be checking the wrong string.
    const target = normalizeOpenedUrl(details.url, opener.currentUrl);
    if (!isAllowedGuestNavigationUrl(target)) {
      // Chromium must never open a non-web scheme, but a real external one (mailto:, an app deep link) is handed to the OS rather than dropped.
      handleExternalGuestScheme(
        target,
        "window-open",
        this.hadRecentGuestGesture(gestureOpener),
      );
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
    // Native popup: allowed only for a real, recent user gesture on the opener
    // and while the concurrent-popup cap has room. A gesture-less open is spam;
    // GSI's post-async open still rides the click that started the flow.
    const gesture = this.gestures.get(gestureOpener);
    if (
      this.openWindows.size >= MAX_BROWSER_VIEW_POPUPS ||
      gesture === undefined ||
      !gesture.consume()
    ) {
      traceRefusedGuestNavigation(target, "window-open");
      return { action: "deny" };
    }
    const windowOptions = this.createPopupWindowOptions();
    return {
      action: "allow",
      overrideBrowserWindowOptions: windowOptions,
      outlivesOpener: false,
      createWindow: (createWindowOptions) => {
        const adopted = createWindowOptions.webContents;
        if (adopted === undefined) {
          // ponytail: Chromium always pre-creates contents for a scripted
          // popup that reaches the allow path; fail closed if that ever stops
          // holding rather than open an opener-less window that breaks OAuth.
          throw new Error("browser popup created without pre-created contents");
        }
        const window = this.createPopupWindow({
          windowOptions,
          createWindowOptions,
        });
        this.trackPopupWindow(surface, target, window);
        return adopted;
      },
    };
  }

  private trackPopupWindow(
    surface: BrowserViewEntryKey,
    initialUrl: string,
    window: BrowserViewPopupWindow,
  ): void {
    if (this.trackedPopupWindows.has(window)) return;
    this.trackedPopupWindows.add(window);
    this.registerPopupWebContents(window.webContents);
    this.installPopupPolicy(surface, initialUrl, window.webContents);
    this.openWindows.add(window);
    window.on("closed", () => {
      this.openWindows.delete(window);
    });
    log.info("[browser-view] popup created", {
      popupWebContentsId: window.webContents.id,
    });
  }

  private installPopupPolicy(
    surface: BrowserViewEntryKey,
    initialUrl: string,
    webContents: BrowserViewPopupWebContents,
  ): void {
    if (this.policyInstalledOn.has(webContents)) return;
    this.policyInstalledOn.add(webContents);
    this.installGuestGesture(webContents);
    installGuestNavigationGuard(webContents, () =>
      this.hadRecentGuestGesture(webContents),
    );
    const popupOpener = { surface, currentUrl: initialUrl };
    webContents.on("did-navigate", (_event: Event, url: string) => {
      popupOpener.currentUrl = url;
    });
    webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpen(
        { surface: popupOpener.surface, currentUrl: popupOpener.currentUrl },
        details,
        webContents,
      ),
    );
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
