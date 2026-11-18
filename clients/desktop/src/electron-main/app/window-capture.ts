import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { WindowCaptureRect } from "../../ipc-contracts/window-capture-types";

function isCaptureRect(value: unknown): value is WindowCaptureRect {
  if (typeof value !== "object" || value === null) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const coordinate: unknown = Reflect.get(value, key);
    return typeof coordinate === "number" && Number.isFinite(coordinate);
  });
}

/** Only the invoking, trusted GUI window is capturable; no caller-supplied window id. */
export async function captureWindowRegion(
  event: IpcMainInvokeEvent,
  input: unknown,
): Promise<ArrayBuffer | null> {
  if (!isCaptureRect(input) || input.width <= 0 || input.height <= 0)
    return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    window === null ||
    window.isDestroyed() ||
    window.webContents !== event.sender
  )
    return null;
  const zoom = event.sender.getZoomFactor();
  const [contentWidth, contentHeight] = window.getContentSize();
  const x = Math.max(0, Math.floor(input.x * zoom));
  const y = Math.max(0, Math.floor(input.y * zoom));
  const right = Math.min(
    contentWidth,
    Math.ceil((input.x + input.width) * zoom),
  );
  const bottom = Math.min(
    contentHeight,
    Math.ceil((input.y + input.height) * zoom),
  );
  if (right <= x || bottom <= y) return null;
  const image = await event.sender.capturePage({
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
  if (image.isEmpty()) return null;
  return Uint8Array.from(image.toPNG()).buffer;
}
