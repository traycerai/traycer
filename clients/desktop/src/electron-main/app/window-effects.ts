import {
  app,
  BrowserWindow,
  nativeImage,
  type IpcMainInvokeEvent,
} from "electron";
import { log } from "./logger";

const PROGRESS_BAR_CLEAR = -1;

interface ResolvedWindow {
  readonly window: BrowserWindow;
}

function resolveSenderWindow(event: IpcMainInvokeEvent): ResolvedWindow | null {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return null;
  return { window };
}

/**
 * Flashes the dock icon (macOS) / taskbar button (Windows) to draw the
 * user's eye when a window in the background needs attention - e.g.,
 * pending approval, host error, completed long task. Renderer passes
 * `true` to start flashing and `false` to clear.
 */
export function handleFlashFrame(
  event: IpcMainInvokeEvent,
  shouldFlash: unknown,
): void {
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.flashFrame(shouldFlash === true);
}

/**
 * Sets a 0.0-1.0 progress value in the dock (macOS) / taskbar (Windows).
 * Pass a negative number to clear. Values outside [-1, 1] are clamped.
 */
export function handleSetProgressBar(
  event: IpcMainInvokeEvent,
  value: unknown,
): void {
  if (typeof value !== "number" || Number.isNaN(value)) return;
  const clamped = value < 0 ? PROGRESS_BAR_CLEAR : value > 1 ? 1 : value;
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.setProgressBar(clamped);
}

/**
 * Sets the dock badge text (macOS) or taskbar overlay text (Windows).
 * Empty string clears. Renderer should pass short strings - most badges
 * are 1-3 chars (e.g., "3", "99+", "!").
 */
export function handleSetBadge(
  _event: IpcMainInvokeEvent,
  text: unknown,
): void {
  if (typeof text !== "string") return;
  if (typeof app.dock?.setBadge === "function") {
    app.dock.setBadge(text);
    return;
  }
  if (process.platform === "win32") {
    // Windows uses overlay icons rather than badge text; renderer should
    // pre-render a NativeImage and use a different IPC path for icons.
    log.debug("[window-effects] setBadge ignored on win32", { text });
  }
}

/**
 * macOS-only: sets the "represented file" of the window - the title bar
 * gets a clickable file-icon glyph that opens the file's parent folder
 * in Finder. Pair with `setDocumentEdited(true)` to show the close-button
 * dirty-dot for the standard macOS document-window UX.
 */
export function handleSetRepresentedFilename(
  event: IpcMainInvokeEvent,
  path: unknown,
): void {
  if (process.platform !== "darwin") return;
  if (typeof path !== "string") return;
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.setRepresentedFilename(path);
}

export function handleSetDocumentEdited(
  event: IpcMainInvokeEvent,
  edited: unknown,
): void {
  if (process.platform !== "darwin") return;
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.setDocumentEdited(edited === true);
}

/**
 * macOS/Windows: excludes the window from screen recordings, screenshots,
 * and screen-share sessions. Useful for views that surface secrets
 * (auth tokens, generated credentials, confidential prompts) - turning
 * this on prevents the content from leaking through screenshare.
 */
export function handleSetContentProtection(
  event: IpcMainInvokeEvent,
  enabled: unknown,
): void {
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.setContentProtection(enabled === true);
}

/**
 * Windows-only: repaints the native window controls (min/max/close) drawn by
 * Chromium's Window Controls Overlay. The `BrowserWindow`'s `titleBarOverlay`
 * colors are static after creation, so the renderer pushes theme-derived
 * colors here on every theme change to keep the controls in sync with the
 * active theme / light-dark mode. macOS draws OS-native traffic lights and
 * Linux uses default chrome, so both are no-ops.
 */
export function handleSetTitleBarOverlay(
  event: IpcMainInvokeEvent,
  color: unknown,
  symbolColor: unknown,
): void {
  if (process.platform !== "win32") return;
  if (typeof color !== "string" || typeof symbolColor !== "string") return;
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.setTitleBarOverlay({ color, symbolColor });
}

/**
 * Windows-only: places a 16×16 overlay on the bottom-right corner of the
 * taskbar button (e.g., a red dot for "needs attention", a number badge,
 * or a checkmark for "task complete"). Renderer passes a data-URL or
 * file path; pass `null` to clear. macOS uses dock badges instead - see
 * `handleSetBadge`. Linux has no equivalent and is a no-op.
 */
export function handleSetOverlayIcon(
  event: IpcMainInvokeEvent,
  image: unknown,
  description: unknown,
): void {
  if (process.platform !== "win32") return;
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  const desc = typeof description === "string" ? description : "";
  if (image === null || image === undefined || image === "") {
    resolved.window.setOverlayIcon(null, desc);
    return;
  }
  if (typeof image !== "string") {
    log.warn("[window-effects] setOverlayIcon expected string|null");
    return;
  }
  const nimage = image.startsWith("data:")
    ? nativeImage.createFromDataURL(image)
    : nativeImage.createFromPath(image);
  if (nimage.isEmpty()) {
    log.warn("[window-effects] setOverlayIcon image empty/unreadable", {
      image,
    });
    return;
  }
  resolved.window.setOverlayIcon(nimage, desc);
}
