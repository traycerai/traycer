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
 * Where a DIRECT download lands, inside the platform's documents directory: a
 * folder of the app's own so a phone's Documents root does not accumulate
 * loose Traycer files among everything else that writes there.
 */
const DOWNLOAD_DIRECTORY = "Traycer";

/**
 * How many numbered variants of a taken name are tried before falling back to
 * the launch stamp. Two downloads of the same usage window in one session is
 * the case worth handling; a user with twenty is better served by a name that
 * is merely unique than by twenty more round trips to the filesystem.
 */
const MAX_NUMBERED_DOWNLOAD_ATTEMPTS = 20;

/**
 * Each request stages into its OWN directory under that root, keeping the
 * user-facing basename intact.
 *
 * One shared folder would give two exports of the same suggested name the same
 * path - and the share sheet resolves when it is DISMISSED, which on Android
 * can precede the receiving app finishing its read of the granted URI. A
 * second `mermaid-diagram.png` would then overwrite bytes a first recipient is
 * still consuming. This is the same late-read fact that makes deleting the
 * staged file unsafe; reusing its path is the other half of it.
 *
 * The stamp is what makes that hold across launches: a counter alone restarts
 * at zero, so a fresh launch would reuse the first directory of the previous
 * one, which an earlier recipient may still hold a URI into.
 */
const stagingStamp = Date.now().toString(36);
let stagedRequests = 0;

function stagingPath(name: string): string {
  stagedRequests += 1;
  return `${EXPORT_DIRECTORY}/${stagingStamp}-${stagedRequests}/${name}`;
}

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
 * What a single path component may occupy. The filesystems under both native
 * shells bound a component in BYTES, not characters, and reject the write
 * outright past it - so this is the phone's limit to enforce, at the point
 * where a name becomes a path.
 */
const MAX_FILE_NAME_BYTES = 255;

const utf8 = new TextEncoder();

function utf8Length(value: string): number {
  return utf8.encode(value).length;
}

/**
 * The longest prefix of `value` that encodes within `budget` bytes, cut on a
 * character boundary - iterating the string yields whole code points, so a
 * multi-byte character is dropped entirely rather than severed into mojibake.
 */
function truncateToBytes(value: string, budget: number): string {
  let used = 0;
  let kept = "";
  for (const character of value) {
    const size = utf8Length(character);
    if (used + size > budget) break;
    used += size;
    kept += character;
  }
  return kept;
}

/**
 * A name bounded by ENCODED length, keeping its extension.
 *
 * Callers bound their suggestions by code point (artifact export allows 120),
 * which says nothing about bytes: 120 CJK characters is 360 bytes and 120
 * emoji is 480, so a legitimate title can exceed the component limit and make
 * the write reject before the share sheet is ever reached. The extension is
 * preserved across the cut because it is what the receiving app dispatches on
 * - a truncated stem is a cosmetic loss, a lost extension is a file the OS no
 * longer knows how to open.
 */
function boundFileNameBytes(name: string): string {
  if (utf8Length(name) <= MAX_FILE_NAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const extensionBytes = utf8Length(extension);
  // An extension that cannot itself fit is not one worth preserving.
  if (extensionBytes >= MAX_FILE_NAME_BYTES) {
    return truncateToBytes(name, MAX_FILE_NAME_BYTES);
  }
  const stem = truncateToBytes(
    dot > 0 ? name.slice(0, dot) : name,
    MAX_FILE_NAME_BYTES - extensionBytes,
  );
  return stem.length === 0
    ? truncateToBytes(name, MAX_FILE_NAME_BYTES)
    : `${stem}${extension}`;
}

/**
 * Extensions for the media types this seam actually carries: images from the
 * chat lightbox and the Mermaid / usage exports, and the artifact export's own
 * formats. Deliberately a lookup rather than a guess - a name is only given an
 * extension when the type names one unambiguously.
 */
const EXTENSION_BY_MEDIA_TYPE = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["text/markdown", "md"],
  ["application/pdf", "pdf"],
  ["application/zip", "zip"],
]);

/**
 * The name with an extension derived from the blob's own type, when it has
 * none of its own and the type names one.
 *
 * The share sheet is handed a file URI and nothing else, so the OS infers the
 * type from the path - an extensionless file reads as generic data, which
 * costs the user the image-specific destinations ("Save Image") and can leave
 * the receiving app unable to open what it was given. Extensionless names do
 * reach here: `imageFileName` returns a source URL's last path segment
 * verbatim, and an attachment URL ending in an id has no extension to keep.
 */
function withDerivedExtension(name: string, mediaType: string): string {
  if (name.includes(".")) return name;
  const extension = EXTENSION_BY_MEDIA_TYPE.get(baseMediaType(mediaType));
  return extension === undefined ? name : `${name}.${extension}`;
}

/**
 * The type without its parameters, lowercased.
 *
 * A `Blob` carries the full media type it was given, parameters and all, so a
 * response served as `image/svg+xml; charset=utf-8` reaches here with the
 * charset attached - and an exact-key lookup would miss a type it otherwise
 * recognises, leaving the file extensionless for the very reason the lookup
 * exists to prevent.
 */
function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The suggested name reduced to a single path segment. Callers compose names
 * from user content (an image's alt text, an epic's title), so a separator in
 * one would otherwise choose a directory - and an empty result would write to
 * the export directory itself.
 */
function toFileName(suggested: string, mediaType: string): string {
  const leaf = suggested.split(/[\\/]/).at(-1) ?? "";
  // Trimmed BEFORE the leading dots are stripped, or surrounding whitespace
  // hides them from the strip: `" . "` would survive as `"."` and `" .. "` as
  // `".."`, naming the staging directory itself or its parent rather than a
  // file in it. The second trim catches what removing the dots exposes.
  const trimmed = leaf.trim().replace(/^\.+/, "").trim();
  const named = trimmed.length === 0 ? "traycer-export" : trimmed;
  // Extension first, byte bound second: the bound is what has to hold, and it
  // preserves whatever extension the name ends up with.
  return boundFileNameBytes(withDerivedExtension(named, mediaType));
}

/**
 * A name with `insert` placed between its stem and its extension, re-bounded
 * afterwards - the insert is what makes an otherwise-taken name free, and a
 * name only has to fit once it is final.
 */
function withNameInsert(name: string, insert: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return boundFileNameBytes(`${name}${insert}`);
  return boundFileNameBytes(`${name.slice(0, dot)}${insert}${name.slice(dot)}`);
}

/**
 * Whether something already occupies `path` in the documents directory. The
 * plugin REJECTS a stat of a missing file rather than reporting absence, so a
 * rejection is the "no" - and any other failure (an unreadable directory)
 * reads as "no" too, which is the safe answer: the caller only uses this to
 * pick a free name, and guessing "taken" would push a perfectly good download
 * onto a numbered name for no reason.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Documents });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first free path for `name` in the download directory.
 *
 * A download must not silently replace an earlier one - two exports of the
 * same usage window suggest the same name, and overwriting the first would
 * lose a file the user believes they still have. Numbered variants mirror what
 * a desktop browser does with the same collision; past
 * {@link MAX_NUMBERED_DOWNLOAD_ATTEMPTS} the launch stamp takes over, which is
 * unique by construction and so always terminates.
 */
async function freeDownloadPath(name: string): Promise<string> {
  const candidate = `${DOWNLOAD_DIRECTORY}/${name}`;
  if (!(await fileExists(candidate))) return candidate;
  for (let n = 2; n <= MAX_NUMBERED_DOWNLOAD_ATTEMPTS; n++) {
    const numbered = `${DOWNLOAD_DIRECTORY}/${withNameInsert(name, ` (${String(n)})`)}`;
    if (!(await fileExists(numbered))) return numbered;
  }
  stagedRequests += 1;
  return `${DOWNLOAD_DIRECTORY}/${withNameInsert(name, `-${stagingStamp}-${String(stagedRequests)}`)}`;
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
 * path. This shell owns TWO such paths, and the difference between them is
 * the whole reason `IFileSaveHost` names them separately:
 *
 * - {@link MobileFileSave.saveFile} stages the file in the app's cache
 *   container and offers it to the OS share sheet, where a phone user chooses
 *   "Save to Files", a photo library, or another app entirely. Where the bytes
 *   end up is that app's decision.
 * - {@link MobileFileSave.downloadFile} writes them into the platform's
 *   documents directory and stops. Nothing is offered and nothing is chosen.
 *
 * The sheet reports which ACTIVITY the user picked, never where that activity
 * put the bytes, so `saveFile` reports `path: null`; the direct write knows
 * exactly where it wrote and says so. `openSavedFile` is `null` either way -
 * this shell carries no plugin that hands a file to the OS default app, so
 * knowing the path is not the same as having a route back to it.
 *
 * The staged copy is deliberately left in place, and each request gets its own
 * directory (see {@link stagingPath}). The sheet resolves when it is dismissed,
 * which on Android is before the receiving app has necessarily finished reading
 * the content URI, so neither deleting on that edge nor reusing the path would
 * be safe; the cache container is space the OS reclaims on its own terms, which
 * is what it is for.
 */
export class MobileFileSave implements IFileSaveHost {
  /**
   * `null`: this shell has no route that opens a file with the OS default
   * application, whether or not it knows where the file is.
   */
  readonly openSavedFile = null;

  async saveFile(request: FileSaveRequest): Promise<SavedFileLocation | null> {
    const name = toFileName(request.name, request.type);
    const written = await Filesystem.writeFile({
      path: stagingPath(name),
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

  /**
   * The phone's chooser-free download: the bytes are written into the
   * platform's documents directory and nothing else happens - no sheet, no
   * second app, and no decision left to the user after the tap.
   *
   * What "documents" means is the platform's answer, not this file's. On
   * Android it is the shared Documents folder, which every file manager lists
   * and other apps can read; on iOS it is the app's own documents container,
   * which the Files app shows under "On My iPhone → Traycer" because the two
   * `Info.plist` sharing keys are set. Neither needs a plugin this shell does
   * not already carry, and both put a real, persistent file somewhere the user
   * can go and find it - which is the whole of what a download promises.
   *
   * Unlike {@link saveFile} this reports a path: the write itself says where
   * the bytes went. `openSavedFile` is still `null`, so nothing offers to
   * re-open it - the path is the honest record of the location, not a route
   * back to it.
   */
  async downloadFile(request: FileSaveRequest): Promise<SavedFileLocation> {
    const name = toFileName(request.name, request.type);
    const path = await freeDownloadPath(name);
    const written = await Filesystem.writeFile({
      path,
      data: toBase64(request.bytes),
      directory: Directory.Documents,
      recursive: true,
    });
    // The name the user ends up with is the one that was free, which a
    // collision may have numbered - the confirmation has to say that one.
    return { name: path.split("/").at(-1) ?? name, path: written.uri };
  }
}
