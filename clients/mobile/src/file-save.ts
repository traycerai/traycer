import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type {
  FileSaveRequest,
  IFileSaveHost,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Where staged exports live inside the app's cache container. A subdirectory,
 * not the cache root, so the files this shell offers to the OS are separable
 * from anything else Capacitor stages there.
 */
const EXPORT_DIRECTORY = "traycer-exports";

/**
 * `btoa` reads a binary string, and a binary string is built by spreading
 * bytes through `String.fromCharCode`. Spreading a whole export at once
 * exceeds the argument limit and throws for exactly the large files this path
 * exists to save, so the bytes are walked in fixed slices.
 */
const BASE64_CHUNK_BYTES = 0x8000;

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...view.subarray(offset, offset + BASE64_CHUNK_BYTES),
    );
  }
  return btoa(binary);
}

/**
 * The suggested name reduced to a single path segment. Callers compose names
 * from user content (an image's alt text, an epic's title), so a separator in
 * one would otherwise choose a directory - and an empty result would write to
 * the export directory itself.
 */
function toFileName(suggested: string): string {
  const leaf = suggested.split(/[\\/]/).at(-1) ?? "";
  const trimmed = leaf.replace(/^\.+/, "").trim();
  return trimmed.length === 0 ? "traycer-export" : trimmed;
}

/**
 * The plugin rejects a dismissed sheet rather than resolving it, and the
 * rejection carries prose rather than a code. Matching the wording is a guess,
 * but the alternative - reporting every rejection as a failure - tells a user
 * who deliberately backed out of the share sheet that something went wrong.
 */
function isShareDismissal(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("cancel");
}

/**
 * The phone's `IRunnerHost.fileSave`.
 *
 * A WKWebView honours none of the browser save routes - there is no File
 * System Access API, and `<a download>` navigates instead of saving - so
 * every export on this shell was a silent no-op until the bytes took a native
 * path. That path is two plugins: the file is written into the app's cache
 * container, then offered to the OS share sheet, which is where a phone user
 * chooses "Save to Files", a photo library, or another app entirely.
 *
 * The consequence for the contract is `path: null`. The sheet reports which
 * ACTIVITY the user picked, never where that activity put the bytes, so this
 * shell cannot re-open what it saved and `openSavedFile` is `null`.
 *
 * The staged copy is deliberately left in place. The sheet resolves when it is
 * dismissed, which on Android is before the receiving app has necessarily
 * finished reading the content URI, so deleting on that edge would race a
 * still-pending read; the cache container is space the OS reclaims on its own
 * terms, which is what it is for.
 */
export class MobileFileSave implements IFileSaveHost {
  /**
   * `null`: no activity in the sheet reports a destination back, so there is
   * never a path to re-open.
   */
  readonly openSavedFile = null;

  async saveFile(request: FileSaveRequest): Promise<SavedFileLocation | null> {
    const name = toFileName(request.name);
    const written = await Filesystem.writeFile({
      path: `${EXPORT_DIRECTORY}/${name}`,
      data: toBase64(request.bytes),
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      await Share.share({ title: name, files: [written.uri] });
    } catch (error) {
      if (isShareDismissal(error)) {
        return null;
      }
      throw error;
    }
    return { name, path: null };
  }
}
