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

async function writeImageBlobToDesktopClipboard(blob: Blob): Promise<void> {
  const writeImage = desktopImageClipboardWrite();
  if (writeImage === null) {
    throw new Error("Image clipboard is unavailable");
  }
  await writeImage({
    type: blob.type,
    bytes: await blob.arrayBuffer(),
  });
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

  await writeImageBlobToDesktopClipboard(blob);
}

/**
 * Issues the browser write against a still-pending blob, or `null` when this
 * runtime has no usable `ClipboardItem` write path. Everything here runs
 * synchronously so the write is attributed to the caller's user activation.
 */
function startBrowserImageWrite(
  blobPromise: Promise<Blob>,
): Promise<void> | null {
  const browserClipboard: unknown = Reflect.get(navigator, "clipboard");
  if (
    typeof ClipboardItem !== "function" ||
    !isBrowserImageClipboard(browserClipboard)
  ) {
    return null;
  }
  try {
    // A promise-valued item is the sanctioned way to hold the clipboard open
    // while the bytes are produced; the MIME type is fixed because the blob
    // it resolves to cannot be inspected yet.
    return browserClipboard.write([
      new ClipboardItem({ "image/png": blobPromise }),
    ]);
  } catch {
    // Constructing the item or issuing the write can throw synchronously
    // (unsupported type, no activation) - the desktop bridge covers both.
    return null;
  }
}

/**
 * Copy an image to the clipboard while its bytes are still being produced.
 *
 * WebKit consumes the user activation at the first `await`, so a write issued
 * only after the capture resolved is rejected as untrusted. Passing the
 * pending blob to `ClipboardItem` starts the write inside the activation and
 * streams the pixels in when `blobPromise` settles. Callers must therefore
 * create `blobPromise` and call this synchronously from the event handler.
 */
export async function copyImageBlobPromiseToClipboard(
  blobPromise: Promise<Blob>,
): Promise<void> {
  const browserWrite = startBrowserImageWrite(blobPromise);
  if (browserWrite !== null) {
    try {
      await browserWrite;
      return;
    } catch {
      // Electron's renderer clipboard can be unavailable for this MIME type;
      // the main-process nativeImage bridge below is the desktop fallback.
    }
  }

  // Awaiting the capture before the bridge keeps a failed capture surfacing as
  // its own error rather than as "Image clipboard is unavailable".
  const blob = await blobPromise;
  await writeImageBlobToDesktopClipboard(blob);
}
