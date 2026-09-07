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

export function handleFlashFrame(
  event: IpcMainInvokeEvent,
  shouldFlash: unknown,
): void {
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.flashFrame(shouldFlash === true);
}

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

export function handleSetContentProtection(
  event: IpcMainInvokeEvent,
  enabled: unknown,
): void {
  const resolved = resolveSenderWindow(event);
  if (resolved === null) return;
  resolved.window.setContentProtection(enabled === true);
}

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
