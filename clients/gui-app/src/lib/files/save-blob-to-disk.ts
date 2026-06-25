interface FsaFileHandle {
  readonly name: string;
  createWritable: () => Promise<FsaWritable>;
}
interface FsaWritable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}
interface SaveFilePickerType {
  readonly description: string;
  readonly accept: Record<string, ReadonlyArray<string>>;
}
interface SaveFilePickerOptions {
  readonly suggestedName: string;
  readonly types: ReadonlyArray<SaveFilePickerType>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (
      options: SaveFilePickerOptions,
    ) => Promise<FsaFileHandle>;
  }
}

interface DesktopSaveFileInput {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

type DesktopSaveFile = (input: DesktopSaveFileInput) => Promise<string | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDesktopSaveFile(value: unknown): value is DesktopSaveFile {
  return typeof value === "function";
}

/**
 * Traycer Desktop exposes a native save bridge under
 * `runnerHost.fileDrops.saveFile`. The sandboxed Electron renderer cannot use
 * the File System Access API's `createWritable()` (it throws `NotAllowedError`),
 * so the bytes are handed to the main process, which writes them after a native
 * save dialog. Returns `null` in any non-desktop runtime (browser, dev shell).
 */
function getDesktopSaveFile(): DesktopSaveFile | null {
  const runnerHost = (globalThis as { runnerHost?: unknown }).runnerHost;
  if (!isRecord(runnerHost)) return null;
  const fileDrops = runnerHost.fileDrops;
  if (!isRecord(fileDrops)) return null;
  const saveFile = fileDrops.saveFile;
  return isDesktopSaveFile(saveFile) ? saveFile : null;
}

/**
 * Derive the picker's accept-type hint from the blob's MIME type and the
 * suggested name's extension. Empty when either is unknown — the helper is
 * generic, so it must not hardcode any one format.
 */
function buildSaveFilePickerTypes(
  blob: Blob,
  suggestedName: string,
): ReadonlyArray<SaveFilePickerType> {
  const dot = suggestedName.lastIndexOf(".");
  const extension = dot >= 0 ? suggestedName.slice(dot) : "";
  if (blob.type.length === 0 || extension.length === 0) return [];
  return [{ description: blob.type, accept: { [blob.type]: [extension] } }];
}

/**
 * Persist a Blob to disk, picking the best mechanism for the current runtime:
 *   1. Traycer Desktop → native save dialog via the `runnerHost` IPC bridge.
 *   2. Browsers with the File System Access API → `showSaveFilePicker`.
 *   3. Everything else (and recoverable FSA write failures) → `<a download>`.
 * Returns the saved file name, or `null` when the user cancels the picker.
 *
 * Shared across the app — not Mermaid-specific — so any feature that needs a
 * "save this blob" affordance gets the desktop-sandbox-safe path for free.
 */
export async function saveBlobToDisk(
  blob: Blob,
  suggestedName: string,
): Promise<string | null> {
  const desktopSaveFile = getDesktopSaveFile();
  if (desktopSaveFile !== null) {
    return desktopSaveFile({
      name: suggestedName,
      type: blob.type,
      bytes: await blob.arrayBuffer(),
    });
  }

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: buildSaveFilePickerTypes(blob, suggestedName),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name;
    } catch (err) {
      // User dismissed the picker — a no-op; never fall through to a download.
      if (err instanceof DOMException && err.name === "AbortError") {
        return null;
      }
      // A non-cancel failure (locked file, transient I/O) must not lose the
      // file: fall through to the <a download> path so the browser still saves
      // it. Desktop never reaches here — getDesktopSaveFile() handled it above.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }
  return suggestedName;
}
