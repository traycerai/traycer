import { BrowserWindow } from "electron";
import { safelyOpenExternal } from "../../app/security";
import { describeLogError, log } from "../../app/logger";

/**
 * A small always-on-top window showing one tile's page.
 *
 * ## Why it is a second VIEW, not the tile's guest moved
 *
 * A browser tile is a renderer-owned `<webview>` guest, anchored in the app's
 * DOM (`docs/adr/0001-browser-tile-rendering.md`). There is no supported way to
 * re-parent that guest into another `BrowserWindow`: the guest belongs to the
 * host renderer's document, and taking it away would leave the tile a hole and
 * the guest's placement, chords and annotation host pointing at a window that no
 * longer holds it.
 *
 * So this window loads the tile's current address into its OWN contents, on the
 * tile's OWN session partition. Same jar, so a page behind a login stays behind
 * it; separate document, so scroll position and form state are its own. That is
 * a real difference from mirroring the tile's pixels, and the honest description
 * of it is "a second window on the same page", which is what a floating preview
 * is wanted for - watching a page while working elsewhere.
 *
 * ## Why it is deliberately spartan
 *
 * No chrome, no address bar, no DevTools of its own. Every control already
 * exists on the tile, and a second set would be a second place for state to
 * drift. The window is a viewport; the tile stays the instrument.
 */
export interface BrowserPreviewWindowHandle {
  /** Brings an already-open window forward instead of opening a second one. */
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  /** Points the window at a new address, for a tile that navigated. */
  navigate(url: string): void;
}

export interface BrowserPreviewWindowInput {
  readonly url: string;
  /** The tile's partition, so this view shares its cookies and storage. */
  readonly partition: string;
  /** Called once the window is gone, however it went. */
  readonly onClosed: () => void;
}

const PREVIEW_WINDOW_WIDTH = 480;
const PREVIEW_WINDOW_HEIGHT = 720;
/** Smaller than the default but still a usable page, for a corner of a screen. */
const PREVIEW_WINDOW_MIN_WIDTH = 320;
const PREVIEW_WINDOW_MIN_HEIGHT = 400;

export function createBrowserPreviewWindow(
  input: BrowserPreviewWindowInput,
): BrowserPreviewWindowHandle {
  const window = new BrowserWindow({
    show: true,
    alwaysOnTop: true,
    width: PREVIEW_WINDOW_WIDTH,
    height: PREVIEW_WINDOW_HEIGHT,
    minWidth: PREVIEW_WINDOW_MIN_WIDTH,
    minHeight: PREVIEW_WINDOW_MIN_HEIGHT,
    // Deliberately parentless: a child window is always above its parent AND
    // minimizes with it, which defeats the point - this is for watching a page
    // while the app itself is behind something else.
    fullscreenable: false,
    webPreferences: {
      partition: input.partition,
      // The same three the tile's own guest is born with. This window shows a
      // remote page, so it gets no Node and no shared context.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // A preview window is one window on one page, opened by one menu click. The
  // page inside it must not be able to mint more: every window here is
  // always-on-top, so a page that could call `window.open` in a loop would paper
  // the screen with windows the user has to dismiss one at a time. Links that
  // want a new window get the system browser, matching the app's own windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void safelyOpenExternal(url);
    return { action: "deny" };
  });
  window.once("closed", input.onClosed);
  loadPreviewUrl(window, input.url);
  return {
    focus: () => {
      if (window.isDestroyed()) return;
      window.show();
      window.focus();
    },
    close: () => {
      if (window.isDestroyed()) return;
      window.close();
    },
    isDestroyed: () => window.isDestroyed(),
    navigate: (url) => {
      if (window.isDestroyed()) return;
      loadPreviewUrl(window, url);
    },
  };
}

/**
 * A load failure is logged and dropped rather than thrown: the caller is a menu
 * click, and a page that refuses to load leaves a visible empty window, which
 * is its own report.
 */
function loadPreviewUrl(window: BrowserWindow, url: string): void {
  void window.webContents.loadURL(url).catch((error: unknown) => {
    log.warn("[browser-view] preview window load failed", {
      ...describeLogError(error),
    });
  });
}
