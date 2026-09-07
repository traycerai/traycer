import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type {
  FileSaveRequest,
  IFileSaveHost,
  SavedFileLocation,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * Where staged exports live inside the app's cache container.
 * A subdirectory, not the cache root, so the files this shell offers to the OS are separable from anything else Capacitor stages there.
 */
const EXPORT_DIRECTORY = "traycer-exports";

/**
 * Where a direct download lands, inside the platform's documents directory: a folder of the app's own so a phone's Documents root does not accumulate loose Traycer files among everything else that writes there.
 */
const DOWNLOAD_DIRECTORY = "Traycer";

/** How many numbered variants of a taken name are tried before falling back to the launch stamp. */
const MAX_NUMBERED_DOWNLOAD_ATTEMPTS = 20;

const stagingStamp = Date.now().toString(36);
let stagedRequests = 0;

function stagingPath(name: string): string {
  stagedRequests += 1;
  return `${EXPORT_DIRECTORY}/${stagingStamp}-${stagedRequests}/${name}`;
}

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
 * What a single path component may occupy.
 * The filesystems under both native shells bound a component in bytes, not characters, and reject the write outright past it - so this is the phone's limit to enforce, at the point where a name becomes a path.
 */
const MAX_FILE_NAME_BYTES = 255;

const utf8 = new TextEncoder();

function utf8Length(value: string): number {
  return utf8.encode(value).length;
}

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
 * Extensions for the media types this seam actually carries: images from the chat lightbox and the Mermaid / usage exports, and the artifact export's own formats.
 * Deliberately a lookup rather than a guess - a name is only given an extension when the type names one unambiguously.
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

function withDerivedExtension(name: string, mediaType: string): string {
  if (name.includes(".")) return name;
  const extension = EXTENSION_BY_MEDIA_TYPE.get(baseMediaType(mediaType));
  return extension === undefined ? name : `${name}.${extension}`;
}

/** The type without its parameters, lowercased. */
function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Characters Android's shared storage rejects in a file name.
 * Fat-derived volumes fail the write outright rather than landing under a mangled name.
 */
const INVALID_FILE_NAME_CHARACTERS = /[:*?"<>|\u0000-\u001f]/g;

function toFileName(suggested: string, mediaType: string): string {
  const leaf = (suggested.split(/[\\/]/).at(-1) ?? "").replace(
    INVALID_FILE_NAME_CHARACTERS,
    "-",
  );
  // Trim before stripping leading dots, or whitespace hides them and the name becomes "." / "..".
  // The second trim catches what removing the dots exposes.
  const trimmed = leaf.trim().replace(/^\.+/, "").trim();
  const named = trimmed.length === 0 ? "traycer-export" : trimmed;
  // Extension first, byte bound second: the bound is what has to hold, and it
  // preserves whatever extension the name ends up with.
  return boundFileNameBytes(withDerivedExtension(named, mediaType));
}

/** Place `insert` between stem and extension inside the byte bound; the stem gives way, never the insert, or a name already at the limit would overwrite. */
function withNameInsert(name: string, insert: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const insertBytes = utf8Length(insert);
  const extension = dot > 0 ? name.slice(dot) : "";
  const keptExtension =
    insertBytes + utf8Length(extension) <= MAX_FILE_NAME_BYTES ? extension : "";
  const budget = Math.max(
    0,
    MAX_FILE_NAME_BYTES - insertBytes - utf8Length(keptExtension),
  );
  return `${truncateToBytes(stem, budget)}${insert}${keptExtension}`;
}

/**
 * The plugin's own code for "there is no file there", identical on both native
 * shells (`FilesystemErrors.doesNotExist` / `FilesystemError.fileNotFound`).
 * It arrives on the JS error because the plugin rejects with a code beside its
 * message.
 */
const FILE_NOT_FOUND_CODE = "OS-PLUG-FILE-0008";

function isFileNotFound(error: unknown): boolean {
  if (!(typeof error === "object" && error !== null)) return false;
  const code: unknown = Reflect.get(error, "code");
  if (code === FILE_NOT_FOUND_CODE) return true;
  // Both shells spell absence the same way in prose. Read as a fallback only,
  // for a rejection that reaches here without the plugin's code on it.
  const message: unknown = Reflect.get(error, "message");
  return typeof message === "string" && message.includes("does not exist");
}

/** Only a confirmed not-found is free; any other stat failure is taken, so a write never replaces a file that was there. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Documents });
    return true;
  } catch (error) {
    return !isFileNotFound(error);
  }
}

/** In-process claims for paths whose write has not finished, so two close-together downloads cannot race the same candidate. */
const claimedDownloadPaths = new Set<string>();

/** Serialise search-and-claim; the set is empty while stats are in flight, so concurrent probes would both see the candidate free. */
let downloadClaimQueue: Promise<unknown> = Promise.resolve();

function claimDownloadPath(name: string): Promise<string> {
  // Settled either way: a rejected predecessor must not wedge the queue.
  const next = downloadClaimQueue.then(
    () => searchForFreeDownloadPath(name),
    () => searchForFreeDownloadPath(name),
  );
  downloadClaimQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Whether `path` is spoken for, by a file already on disk or by a download
 * still writing one.
 */
async function downloadPathIsTaken(path: string): Promise<boolean> {
  return claimedDownloadPaths.has(path) || (await fileExists(path));
}

/** Claim the first free path; the caller must release it once the write settles. Numbered variants, then the launch stamp, so a download never silently replaces an earlier one. */
async function searchForFreeDownloadPath(name: string): Promise<string> {
  const claim = (path: string): string => {
    claimedDownloadPaths.add(path);
    return path;
  };
  const candidate = `${DOWNLOAD_DIRECTORY}/${name}`;
  if (!(await downloadPathIsTaken(candidate))) return claim(candidate);
  for (let n = 2; n <= MAX_NUMBERED_DOWNLOAD_ATTEMPTS; n++) {
    const numbered = `${DOWNLOAD_DIRECTORY}/${withNameInsert(name, ` (${String(n)})`)}`;
    if (!(await downloadPathIsTaken(numbered))) return claim(numbered);
  }
  stagedRequests += 1;
  return claim(
    `${DOWNLOAD_DIRECTORY}/${withNameInsert(name, `-${stagingStamp}-${String(stagedRequests)}`)}`,
  );
}

function releaseDownloadPath(path: string): void {
  claimedDownloadPaths.delete(path);
}

/** API 29 has no route into shared Documents (scoped storage without the later relaxation); do not offer a direct download there. */
const ANDROID_SCOPED_STORAGE_GAP_SDK = 29;

/** Bound the OS version probe; this runs on the app mount path, so a hung plugin call must not block first render. */
const DEVICE_PROBE_TIMEOUT_MS = 2_000;

/** Unknown answers true: a false negative hides Download on every modern Android, while a false positive costs one API level a toast beside a working Share. */
export async function supportsDirectDownload(): Promise<boolean> {
  if (Capacitor.getPlatform() !== "android") return true;
  try {
    const info = await Promise.race([
      Device.getInfo(),
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, DEVICE_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (info === null) return true;
    // Absent on a device that reports no SDK version - unknown, so `true`.
    return info.androidSDKVersion !== ANDROID_SCOPED_STORAGE_GAP_SDK;
  } catch {
    return true;
  }
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
 * Phone `IFileSaveHost`. Share sheet reports `path: null` (activity, not destination); direct download reports the write path.
 * `openSavedFile` is null - this shell has no plugin that opens a file with the OS default app.
 */
export class MobileFileSave implements IFileSaveHost {
  /**
   * `null`: this shell has no route that opens a file with the OS default
   * application, whether or not it knows where the file is.
   */
  readonly openSavedFile = null;

  /**
   * The share sheet is what `saveFile` reaches, on every platform and every OS
   * version - unlike { downloadFile}, which one Android level cannot
   * honour at all.
   */
  readonly saveRoute = "share" as const;

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
   * Chooser-free write into the platform documents directory.
   * Reports a path; `openSavedFile` is still null, so the path is a location record, not a route back.
   */
  readonly downloadFile:
    | ((request: FileSaveRequest) => Promise<SavedFileLocation>)
    | null;

  /**
   * @param directDownloads whether this device has a documents destination
   *   this shell may write to - {@link supportsDirectDownload} answers it.
   *   `false` makes {@link downloadFile} `null`, which is what stops a surface
   *   offering a Download it could only ever fail: the capability is absent
   *   rather than present-and-broken, and Share is unaffected.
   */
  constructor(directDownloads: boolean) {
    this.downloadFile = directDownloads
      ? (request) => this.writeDownload(request)
      : null;
  }

  private async writeDownload(
    request: FileSaveRequest,
  ): Promise<SavedFileLocation> {
    const name = toFileName(request.name, request.type);
    const path = await claimDownloadPath(name);
    try {
      const written = await Filesystem.writeFile({
        path,
        data: toBase64(request.bytes),
        directory: Directory.Documents,
        recursive: true,
      });
      // The name the user ends up with is the one that was free, which a
      // collision may have numbered - the confirmation has to say that one.
      return { name: path.split("/").at(-1) ?? name, path: written.uri };
    } finally {
      // Released on failure too: a write that never landed leaves the path
      // genuinely free, and holding it would push the retry onto a number.
      releaseDownloadPath(path);
    }
  }
}
