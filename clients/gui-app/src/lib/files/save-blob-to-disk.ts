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

/**
 * A file `saveBlobToDisk` wrote. `name` is what the user settled on in the
 * picker (display copy); `path` is the absolute location, known only where
 * the runtime reports it back - Traycer Desktop's native dialog does, the
 * browser File System Access picker and `<a download>` never do, so `path`
 * is `null` there and no "open it" affordance is possible.
 */
export interface SavedFile {
  readonly name: string;
  readonly path: string | null;
}

interface DesktopSaveFileInput {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

type DesktopSaveFile = (input: DesktopSaveFileInput) => Promise<unknown>;
type DesktopOpenSavedFile = (path: string) => Promise<void>;

interface DesktopFileBridge {
  readonly saveFile: DesktopSaveFile;
  readonly openSavedFile: DesktopOpenSavedFile | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDesktopSaveFile(value: unknown): value is DesktopSaveFile {
  return typeof value === "function";
}

function isDesktopOpenSavedFile(value: unknown): value is DesktopOpenSavedFile {
  return typeof value === "function";
}

/**
 * Traycer Desktop exposes a native save bridge under
 * `runnerHost.fileDrops.saveFile`. The sandboxed Electron renderer cannot use
 * the File System Access API's `createWritable()` (it throws `NotAllowedError`),
 * so the bytes are handed to the main process, which writes them after a native
 * save dialog. `openSavedFile` sits beside it and re-opens a path `saveFile`
 * returned. Returns `null` in any non-desktop runtime (browser, dev shell).
 */
function getDesktopFileBridge(): DesktopFileBridge | null {
  const runnerHost = (globalThis as { runnerHost?: unknown }).runnerHost;
  if (!isRecord(runnerHost)) return null;
  const fileDrops = runnerHost.fileDrops;
  if (!isRecord(fileDrops)) return null;
  const saveFile = fileDrops.saveFile;
  if (!isDesktopSaveFile(saveFile)) return null;
  const openSavedFile = fileDrops.openSavedFile;
  return {
    saveFile,
    openSavedFile: isDesktopOpenSavedFile(openSavedFile) ? openSavedFile : null,
  };
}

/**
 * The desktop bridge answers `{ name, path }` once the bytes are written and
 * `null` when the user cancels the dialog. The bridge is duck-typed from a
 * global, so its answer is validated rather than trusted.
 */
function parseDesktopSaveResult(value: unknown): SavedFile | null {
  if (value === null) return null;
  if (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.path === "string"
  ) {
    return { name: value.name, path: value.path };
  }
  throw new Error("Desktop save bridge returned an unexpected result");
}

/**
 * Whether {@link openSavedFile} can act in this runtime. Only Traycer Desktop
 * can re-open a saved file - it is the one runtime that learns the path.
 */
export function canOpenSavedFile(saved: SavedFile): boolean {
  const open = getDesktopFileBridge()?.openSavedFile ?? null;
  return saved.path !== null && open !== null;
}

/**
 * Open a file {@link saveBlobToDisk} wrote, with the OS default application.
 * Rejects when the runtime cannot open files or the OS refuses (file moved,
 * no handler app) so the caller can toast the failure.
 */
export async function openSavedFile(saved: SavedFile): Promise<void> {
  const open = getDesktopFileBridge()?.openSavedFile ?? null;
  if (saved.path === null || open === null) {
    throw new Error(`Cannot open ${saved.name} from this app`);
  }
  await open(saved.path);
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
 * Returns the saved file (name always; path on desktop only), or `null` when
 * the user cancels the picker.
 *
 * Shared across the app — not Mermaid-specific — so any feature that needs a
 * "save this blob" affordance gets the desktop-sandbox-safe path for free.
 */
export async function saveBlobToDisk(
  blob: Blob,
  suggestedName: string,
): Promise<SavedFile | null> {
  const desktop = getDesktopFileBridge();
  if (desktop !== null) {
    return parseDesktopSaveResult(
      await desktop.saveFile({
        name: suggestedName,
        type: blob.type,
        bytes: await blob.arrayBuffer(),
      }),
    );
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
      return { name: handle.name, path: null };
    } catch (err) {
      // User dismissed the picker — a no-op; never fall through to a download.
      if (err instanceof DOMException && err.name === "AbortError") {
        return null;
      }
      // A non-cancel failure (locked file, transient I/O) must not lose the
      // file: fall through to the <a download> path so the browser still saves
      // it. Desktop never reaches here — getDesktopFileBridge() handled it above.
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
  return { name: suggestedName, path: null };
}
