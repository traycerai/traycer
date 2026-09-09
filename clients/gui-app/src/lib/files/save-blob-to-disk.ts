import type {
  IFileSaveHost,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";

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
 * A file `saveBlobToDisk` wrote. `name` is what the user settled on (display
 * copy); `path` is the absolute location, known only where the runtime reports
 * it back - Traycer Desktop's native dialog does, while the browser File
 * System Access picker, `<a download>` and the phone's share sheet never do,
 * so `path` is `null` there and no "open it" affordance is possible.
 */
export type SavedFile = SavedFileLocation;

/**
 * Whether {@link openSavedFile} can act. Both halves are required: the shell
 * has to own a re-open route AND the save has to have reported a path, which
 * is the same pair of facts `IFileSaveHost` keeps together.
 */
export function canOpenSavedFile(
  saved: SavedFile,
  fileSave: IFileSaveHost | null,
): boolean {
  const open = fileSave?.openSavedFile ?? null;
  return saved.path !== null && open !== null;
}

/**
 * Open a file {@link saveBlobToDisk} wrote, with the OS default application.
 * Rejects when the runtime cannot open files or the OS refuses (file moved,
 * no handler app) so the caller can toast the failure.
 */
export async function openSavedFile(
  saved: SavedFile,
  fileSave: IFileSaveHost | null,
): Promise<void> {
  const open = fileSave?.openSavedFile ?? null;
  if (saved.path === null || open === null) {
    throw new Error(`Cannot open ${saved.name} from this app`);
  }
  await open(saved.path);
}

/**
 * Whether this shell keeps "share it" and "download it" apart, i.e. whether
 * {@link saveBlobToDisk} would reach an OS chooser rather than commit the file
 * itself. Read off the capability rather than off any notion of which shell is
 * running: a shell owns a chooser-free download precisely when its `saveFile`
 * is not one already.
 */
export function hasSeparateDownloadRoute(
  fileSave: IFileSaveHost | null,
): boolean {
  return fileSave?.saveRoute === "share";
}

/**
 * Whether a "Download" control can be honoured at all.
 *
 * True with no shell (the browser downloads), true where the shell owns a
 * chooser-free write, and true where its own `saveFile` IS the download. FALSE
 * only where the shell hands everything to a chooser and has no direct write -
 * Android 10, whose shared-storage route does not exist. Offering Download
 * there would route it into the share sheet, which is the very mislabelling
 * the split was built to remove.
 */
export function canDownloadToDevice(fileSave: IFileSaveHost | null): boolean {
  if (fileSave === null) return true;
  return fileSave.downloadFile !== null || fileSave.saveRoute === "download";
}

/**
 * Persist a Blob the way a "Download" control promises: straight into the
 * device's storage, with no chooser in between, on the shells that own such a
 * route. Everywhere else this IS {@link saveBlobToDisk} - a desktop save dialog
 * and a browser's download both already commit the file - so callers get the
 * one honest download route for their runtime without asking which runtime it
 * is.
 *
 * `null` only ever comes from the delegated path (a dismissed picker); a direct
 * write has nothing to dismiss and either lands or throws.
 */
export async function downloadBlobToDevice(
  blob: Blob,
  suggestedName: string,
  fileSave: IFileSaveHost | null,
): Promise<SavedFile | null> {
  const download = fileSave?.downloadFile ?? null;
  if (download === null) {
    // Never silently fall through to a chooser: on a shell whose `saveFile` is
    // a share sheet and which owns no direct write, delegating here is exactly
    // how a "Download" ends up opening the sheet. Callers gate on
    // `canDownloadToDevice`, so reaching this is a bug worth surfacing.
    if (!canDownloadToDevice(fileSave)) {
      throw new Error("This device has no download destination.");
    }
    return saveBlobToDisk(blob, suggestedName, fileSave);
  }
  return download({
    name: suggestedName,
    type: blob.type,
    bytes: await blob.arrayBuffer(),
  });
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
 * Persist a Blob, picking the best mechanism for the current runtime:
 *   1. A shell with a native save capability (`IRunnerHost.fileSave`) →
 *      Traycer Desktop's save dialog, the phone's share sheet.
 *   2. Browsers with the File System Access API → `showSaveFilePicker`.
 *   3. Everything else (and recoverable FSA write failures) → `<a download>`.
 * Returns the saved file (name always; path where the mechanism reports one),
 * or `null` when the user dismissed the picker.
 *
 * The native leg is FIRST and unconditional, not a fallback for a failed
 * browser attempt: a shell that has one has it precisely because the browser
 * routes do not work there. Electron's sandboxed renderer cannot use
 * `createWritable()`, and a WKWebView has no picker and ignores `<a download>`
 * outright - which is why an export on a phone used to resolve successfully
 * having done nothing at all.
 *
 * Shared across the app — not Mermaid-specific — so any feature that needs a
 * "save this blob" affordance gets the shell-appropriate path for free.
 */
export async function saveBlobToDisk(
  blob: Blob,
  suggestedName: string,
  fileSave: IFileSaveHost | null,
): Promise<SavedFile | null> {
  if (fileSave !== null) {
    return fileSave.saveFile({
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
      return { name: handle.name, path: null };
    } catch (err) {
      // User dismissed the picker — a no-op; never fall through to a download.
      if (err instanceof DOMException && err.name === "AbortError") {
        return null;
      }
      // A non-cancel failure (locked file, transient I/O) must not lose the
      // file: fall through to the <a download> path so the browser still saves
      // it. A shell with `fileSave` never reaches here — it returned above.
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
