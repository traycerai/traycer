import { lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The ONE resolver of the Traycer data root - the directory every
 * Traycer-managed path (CLI, host, Desktop, credentials, models, the provider
 * homes Traycer owns) descends from. Node-only, so it lives under the
 * `@traycer/protocol/config` subpath and is never re-exported from a
 * browser-safe entry point.
 *
 * Selection is a persisted record, never an environment variable:
 *
 *   <home>/.traycer-bootstrap/location.json
 *     {"version":1,"generation":1,"root":"D:\\TraycerData","migrationId":null}
 *
 * The bootstrap directory is FIXED at the OS user home and is outside the
 * relocatable tree. No record means the historical default, `<home>/.traycer`,
 * exactly. A record that is present but unreadable, malformed, invalid, or that
 * names a root that is not an existing directory is an ERROR: there is no
 * fallback to the default root, because booting the default would mint a
 * second identity beside the user's real data. Nothing here creates a
 * directory.
 *
 * `TRAYCER_DATA_DIR` is setup-only input (`data-root-setup-input.ts`) and is
 * deliberately never read here: runtime selection is the record alone.
 *
 * Every path consumer must call {@link traycerDataRoot} at use time, never
 * cache it in a module-scope constant, so the record is read before any path
 * is derived and an import alone never throws.
 */

export const DEFAULT_DATA_ROOT_DIRNAME = ".traycer";
export const DATA_BOOTSTRAP_DIRNAME = ".traycer-bootstrap";
export const DATA_LOCATION_RECORD_FILENAME = "location.json";

export const dataLocationRecordSchema = lazySchema(() =>
  z.strictObject({
    version: z.literal(1),
    generation: z.number().int().positive(),
    root: z.string().min(1),
    migrationId: z.string().min(1).nullable(),
  }),
);
export type DataLocationRecord = z.infer<typeof dataLocationRecordSchema>;

export type DataRootErrorCode =
  | "record-unreadable"
  | "record-malformed"
  | "root-invalid"
  | "root-unavailable";

/**
 * A data-root resolution failure. The message carries no path: the record
 * path and the selected root contain the account's user name and the root is
 * private (design: root paths stay out of analytics and INFO+ logs). Both are
 * carried as fields for diagnostics the user asks for.
 */
export class DataRootError extends Error {
  readonly code: DataRootErrorCode;
  readonly recordPath: string;
  readonly root: string | null;

  constructor(
    code: DataRootErrorCode,
    message: string,
    recordPath: string,
    root: string | null,
  ) {
    super(message);
    this.name = "DataRootError";
    this.code = code;
    this.recordPath = recordPath;
    this.root = root;
  }
}

export type DataRootResolution =
  | {
      readonly kind: "default";
      readonly root: string;
      readonly bootstrapDir: string;
    }
  | {
      readonly kind: "configured";
      readonly root: string;
      readonly bootstrapDir: string;
      readonly record: DataLocationRecord;
    };

export type DataRootPlatform = "win32" | "posix";

export function dataRootPlatformOf(
  platform: NodeJS.Platform,
): DataRootPlatform {
  return platform === "win32" ? "win32" : "posix";
}

/**
 * `<home>/.traycer-bootstrap` - fixed, never relocated.
 *
 * These home-derived paths use Node's own `path.join`, exactly like every
 * consumer that joins onto the root, never an API picked from
 * `process.platform`: the two agree on a real machine, but a suite that
 * reassigns `process.platform` to drive Windows code would otherwise get a
 * root spelled with the other separator than the rest of its paths.
 */
export function dataBootstrapDir(homeDir: string): string {
  return join(homeDir, DATA_BOOTSTRAP_DIRNAME);
}

export function dataLocationRecordPath(homeDir: string): string {
  return join(dataBootstrapDir(homeDir), DATA_LOCATION_RECORD_FILENAME);
}

/** `<home>/.traycer` - the root when no location record exists. */
export function defaultDataRoot(homeDir: string): string {
  return join(homeDir, DEFAULT_DATA_ROOT_DIRNAME);
}

export type DataRootSelectionCheck =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: string };

// Windows names a device, not a file, for these base names whatever the
// extension (`NUL.txt` is still NUL). The superscript digits 1-3 are written
// as escapes: the host bundles this module, and its SEA build refuses
// non-ASCII bytes in a bundle.
const WINDOWS_DEVICE_NAMES =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(?:\..*)?$/i;
const WINDOWS_ILLEGAL_SEGMENT_CHARACTERS = /[<>:"|?*]/;

/**
 * Validates a proposed data root and returns its single normalized spelling.
 *
 * Refuses: empty or whitespace-padded values, control characters, relative
 * paths, Windows drive-relative (`C:foo`) and drive-less rooted (`\foo`)
 * paths, device namespaces (`\\?\`, `\\.\`), UNC/network shares, Windows
 * device names and aliased segment spellings (trailing dot/space), and a
 * filesystem root itself (a root must be a dedicated directory). Spaces and
 * Unicode inside segments are legal and preserved.
 */
export function validateDataRootSelection(
  value: string,
  platform: DataRootPlatform,
): DataRootSelectionCheck {
  if (value.length === 0) return refuse("the path is empty");
  if (value.trim() !== value) {
    return refuse("the path must not begin or end with whitespace");
  }
  if (hasControlCharacter(value)) {
    return refuse("the path contains control characters");
  }
  if (platform === "win32") return validateWin32Root(value);
  if (!value.startsWith("/")) return refuse("the path must be absolute");
  if (value.startsWith("//")) {
    return refuse("network and namespace paths are not supported");
  }
  const root = stripTrailingSeparator(posix.normalize(value), posix);
  if (root === "/") return refuse("the path must not be a filesystem root");
  return { ok: true, root };
}

function validateWin32Root(value: string): DataRootSelectionCheck {
  if (/^[\\/]{2}/.test(value)) {
    return refuse(
      "network shares and device paths (\\\\server\\share, \\\\?\\, \\\\.\\) are not supported",
    );
  }
  if (!/^[A-Za-z]:[\\/]/.test(value)) {
    return refuse(
      /^[A-Za-z]:/.test(value)
        ? "the path is drive-relative; put a separator after the drive letter"
        : "the path must be absolute and start with a drive letter",
    );
  }
  const normalized = stripTrailingSeparator(win32.normalize(value), win32);
  if (normalized.length <= 3)
    return refuse("the path must not be a drive root");
  for (const segment of normalized.slice(3).split("\\")) {
    if (WINDOWS_ILLEGAL_SEGMENT_CHARACTERS.test(segment)) {
      return refuse(
        `the folder name '${segment}' contains a reserved character`,
      );
    }
    if (/[. ]$/.test(segment)) {
      return refuse(
        `the folder name '${segment}' ends with a dot or space, which Windows does not preserve`,
      );
    }
    if (WINDOWS_DEVICE_NAMES.test(segment)) {
      return refuse(`the folder name '${segment}' is a Windows device name`);
    }
  }
  // Drive letters compare case-insensitively; keep one spelling for keys.
  return {
    ok: true,
    root: normalized.charAt(0).toUpperCase() + normalized.slice(1),
  };
}

/**
 * Whether two absolute paths are equal or one contains the other, on
 * path-segment boundaries. Windows compares case-insensitively (its default
 * volumes do); POSIX compares exactly. Lexical only: a caller deciding a
 * filesystem boundary also compares real paths.
 */
export function dataRootPathsOverlap(
  a: string,
  b: string,
  platform: DataRootPlatform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const left = comparable(pathApi.resolve(a), platform);
  const right = comparable(pathApi.resolve(b), platform);
  if (left === right) return true;
  return (
    right.startsWith(withTrailingSeparator(left, pathApi)) ||
    left.startsWith(withTrailingSeparator(right, pathApi))
  );
}

/**
 * Pure resolution for one home directory. Reads the location record
 * synchronously (paths are derived synchronously everywhere) and creates
 * nothing.
 */
export function resolveDataRoot(
  homeDir: string,
  platform: DataRootPlatform,
): DataRootResolution {
  const bootstrapDir = dataBootstrapDir(homeDir);
  const recordPath = dataLocationRecordPath(homeDir);
  // Absence is decided WITHOUT following links: reading through a dangling
  // `location.json` link or `.traycer-bootstrap` junction also answers
  // ENOENT, and treating that as "no selection" would boot the default root
  // beside the user's real data. Only a genuinely absent directory or record
  // selects the default; any other present-but-unusable entry is an error.
  const presence = inspectRecordPresence(bootstrapDir, recordPath);
  if (presence === "absent") {
    return { kind: "default", root: defaultDataRoot(homeDir), bootstrapDir };
  }
  if (presence !== "file") {
    throw new DataRootError(
      "record-unreadable",
      `Traycer's data location record (~/${DATA_BOOTSTRAP_DIRNAME}/${DATA_LOCATION_RECORD_FILENAME}) or its folder is ${presence}. Restore a real folder and file; Traycer will not fall back to its default data folder.`,
      recordPath,
      null,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(recordPath, "utf8");
  } catch (error) {
    throw new DataRootError(
      "record-unreadable",
      `Traycer cannot read its data location record (~/${DATA_BOOTSTRAP_DIRNAME}/${DATA_LOCATION_RECORD_FILENAME}: ${errorCode(error) ?? "unknown error"}). Restore access to it; Traycer will not fall back to its default data folder.`,
      recordPath,
      null,
    );
  }
  let record: DataLocationRecord;
  try {
    record = dataLocationRecordSchema.parse(JSON.parse(raw));
  } catch {
    throw new DataRootError(
      "record-malformed",
      `Traycer's data location record (~/${DATA_BOOTSTRAP_DIRNAME}/${DATA_LOCATION_RECORD_FILENAME}) is malformed or from a newer version. Traycer will not replace it or fall back to its default data folder.`,
      recordPath,
      null,
    );
  }
  const check = validateDataRootSelection(record.root, platform);
  if (!check.ok || check.root !== record.root) {
    throw new DataRootError(
      "root-invalid",
      `Traycer's data location record names an invalid data folder${check.ok ? " (not in normalized form)" : `: ${check.reason}`}.`,
      recordPath,
      record.root,
    );
  }
  if (dataRootPathsOverlap(record.root, bootstrapDir, platform)) {
    throw new DataRootError(
      "root-invalid",
      `Traycer's data location record names a data folder that overlaps ~/${DATA_BOOTSTRAP_DIRNAME}.`,
      recordPath,
      record.root,
    );
  }
  let isDirectory: boolean;
  try {
    isDirectory = statSync(record.root).isDirectory();
  } catch (error) {
    throw new DataRootError(
      "root-unavailable",
      `Traycer's selected data folder is unavailable (${errorCode(error) ?? "unknown error"}). Reconnect its drive or restore access; Traycer will not start from another folder.`,
      recordPath,
      record.root,
    );
  }
  if (!isDirectory) {
    throw new DataRootError(
      "root-unavailable",
      "Traycer's selected data folder is not a directory.",
      recordPath,
      record.root,
    );
  }
  return { kind: "configured", root: record.root, bootstrapDir, record };
}

// Keyed by the OS home so a process resolves once (its home never changes),
// while test suites that point HOME at a fresh temp directory still get that
// directory's own answer. A failure is never cached.
let cachedResolution: {
  readonly homeDir: string;
  readonly resolution: DataRootResolution;
} | null = null;

/**
 * This process's data-root resolution, made at first use. A later change to
 * the location record takes effect only after a restart. Throws
 * {@link DataRootError} instead of ever returning a fallback.
 */
export function currentDataRootResolution(): DataRootResolution {
  const homeDir = homedir();
  if (cachedResolution !== null && cachedResolution.homeDir === homeDir) {
    return cachedResolution.resolution;
  }
  const resolution = resolveDataRoot(
    homeDir,
    dataRootPlatformOf(process.platform),
  );
  cachedResolution = { homeDir, resolution };
  return resolution;
}

/** The Traycer data root: `<home>/.traycer` unless a location record selects another. */
export function traycerDataRoot(): string {
  return currentDataRootResolution().root;
}

type RecordPresence =
  | "absent"
  | "file"
  | "a link or junction"
  | "not a regular file or folder";

function inspectRecordPresence(
  bootstrapDir: string,
  recordPath: string,
): RecordPresence {
  const dir = lstatOrNull(bootstrapDir);
  if (dir === null) return "absent";
  if (dir.isSymbolicLink()) return "a link or junction";
  if (!dir.isDirectory()) return "not a regular file or folder";
  const record = lstatOrNull(recordPath);
  if (record === null) return "absent";
  if (record.isSymbolicLink()) return "a link or junction";
  if (!record.isFile()) return "not a regular file or folder";
  return "file";
}

// A non-ENOENT failure (EACCES, ENOTDIR on a corrupted profile) propagates as
// an unreadable record rather than reading as absence.
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new DataRootError(
      "record-unreadable",
      `Traycer cannot inspect its data location record (${errorCode(error) ?? "unknown error"}). Restore access to ~/${DATA_BOOTSTRAP_DIRNAME}; Traycer will not fall back to its default data folder.`,
      path,
      null,
    );
  }
}

function refuse(reason: string): DataRootSelectionCheck {
  return { ok: false, reason };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function stripTrailingSeparator(value: string, pathApi: typeof win32): string {
  const rootLength = pathApi.parse(value).root.length;
  let result = value;
  while (
    result.length > rootLength &&
    (result.endsWith("/") || (pathApi === win32 && result.endsWith("\\")))
  ) {
    result = result.slice(0, -1);
  }
  return result;
}

function withTrailingSeparator(value: string, pathApi: typeof win32): string {
  return value.endsWith(pathApi.sep) ? value : value + pathApi.sep;
}

function comparable(value: string, platform: DataRootPlatform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
