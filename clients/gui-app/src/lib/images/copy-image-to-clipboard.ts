interface DesktopImageClipboardInput {
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

type DesktopImageClipboardWrite = (
  input: DesktopImageClipboardInput,
) => Promise<void>;

interface BrowserImageClipboard {
  write(items: ClipboardItem[]): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDesktopImageClipboardWrite(
  value: unknown,
): value is DesktopImageClipboardWrite {
  return typeof value === "function";
}

function isBrowserImageClipboard(
  value: unknown,
): value is BrowserImageClipboard {
  return isRecord(value) && typeof value.write === "function";
}

function desktopImageClipboardWrite(): DesktopImageClipboardWrite | null {
  const runnerHost = (globalThis as { runnerHost?: unknown }).runnerHost;
  if (!isRecord(runnerHost) || !isRecord(runnerHost.platform)) return null;
  const clipboard = runnerHost.platform.clipboard;
  if (!isRecord(clipboard)) {
    return null;
  }
  const writeImage = clipboard.writeImage;
  return isDesktopImageClipboardWrite(writeImage) ? writeImage : null;
}

export async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  const browserClipboard: unknown = Reflect.get(navigator, "clipboard");
  if (
    typeof ClipboardItem === "function" &&
    isBrowserImageClipboard(browserClipboard)
  ) {
    try {
      await browserClipboard.write([
        new ClipboardItem({ [blob.type || "image/png"]: blob }),
      ]);
      return;
    } catch {
      // Electron's renderer clipboard can be unavailable for this MIME type;
      // the main-process nativeImage bridge below is the desktop fallback.
    }
  }

  const writeImage = desktopImageClipboardWrite();
  if (writeImage === null) {
    throw new Error("Image clipboard is unavailable");
  }
  await writeImage({
    type: blob.type,
    bytes: await blob.arrayBuffer(),
  });
}
