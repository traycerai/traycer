import { BrowserWindow, webContents, type BaseWindow } from "electron";

/** Reload the page owning keyboard focus in this window, including a guest. */
export function reloadFocusedPage(
  window: BaseWindow | undefined,
  ignoreCache: boolean,
): void {
  // Built-in detached DevTools has no BaseWindow; this lookup also recognizes
  // a BrowserWindow whose inspector owns focus.
  const owner = window ?? BrowserWindow.getFocusedWindow();
  if (!(owner instanceof BrowserWindow) || owner.isDestroyed()) return;
  const host = owner.webContents;
  if (host.isDestroyed()) return;
  // Guest isFocused() reflects the root view's focus, so Electron's global
  // getFocusedWebContents() can choose an unrelated, even retained, webview.
  // Chromium's focused frame identifies the actual keyboard recipient.
  const frame = host.focusedFrame;
  const target =
    host.isDevToolsFocused() || frame === null
      ? host
      : (webContents.fromFrame(frame) ?? host);
  if (target.isDestroyed()) return;
  // Preserve Electron's reload-role behavior when a detached inspector owns
  // the window: reload its inspected page, not the DevTools UI itself.
  const page =
    webContents
      .getAllWebContents()
      .find((contents) => contents.devToolsWebContents === target) ?? target;
  if (page.isDestroyed()) return;
  if (ignoreCache) page.reloadIgnoringCache();
  else page.reload();
}
