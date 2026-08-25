import type {
  WorkspaceBrowseFolderEntryV11,
  WorkspaceBrowseFoldersResponseV11,
} from "@traycer/protocol/host/workspace/unary-schemas";

export interface ParsedBrowseInput {
  /** False when the field holds something that is not a browsable path yet. */
  readonly valid: boolean;
  /** RPC path of the directory segment; null = the host's home. */
  readonly directoryPath: string | null;
  /** Live filter: the segment after the last separator. */
  readonly filter: string;
}

const INVALID_INPUT: ParsedBrowseInput = {
  valid: false,
  directoryPath: null,
  filter: "",
};

const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    WINDOWS_DRIVE_ROOT.test(path) ||
    WINDOWS_UNC_ROOT.test(path)
  );
}

/** Length of the root that navigation may never chop into. */
function rootLengthOf(path: string): number {
  const unc = WINDOWS_UNC_ROOT.exec(path);
  if (unc !== null) return unc[0].length;
  if (WINDOWS_DRIVE_ROOT.test(path)) return 3;
  return 1;
}

/** A backslash is a separator only after the path is known to be Windows. */
function lastSeparatorIndex(path: string): number {
  if (path.startsWith("/") && !WINDOWS_UNC_ROOT.test(path)) {
    return path.lastIndexOf("/");
  }
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** Preserve the separator the host-native path already uses. */
export function separatorOf(path: string): string {
  if (path.startsWith("/")) return "/";
  return path.includes("\\") ? "\\" : "/";
}

export function withTrailingSeparator(path: string): string {
  const separator = separatorOf(path);
  return path.endsWith(separator) ? path : path + separator;
}

function isTildeOnly(raw: string): boolean {
  return raw === "~" || raw === "~/" || raw === "~\\";
}

export function startsWithTilde(path: string): boolean {
  return path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * Split host-native field text into the directory to browse and its live
 * filter. Both POSIX and Windows forms are accepted because parsing happens on
 * the client while resolution happens on the selected host.
 */
export function parseBrowseInput(
  rawInput: string | null,
  homePath: string | null,
): ParsedBrowseInput {
  if (rawInput === null) {
    return { valid: true, directoryPath: null, filter: "" };
  }
  // Trailing whitespace is a valid filename character; leading whitespace is
  // never part of an absolute path and remains forgiving input normalization.
  const raw = rawInput.trimStart();
  const collapsed = raw.trimEnd();
  if (collapsed === "" || isTildeOnly(collapsed)) {
    return { valid: true, directoryPath: null, filter: "" };
  }
  let path = raw;
  if (startsWithTilde(path)) {
    if (homePath === null) {
      return { valid: true, directoryPath: null, filter: "" };
    }
    path = homePath + path.slice(1);
  }
  if (!isAbsolutePath(path)) return INVALID_INPUT;
  const lastSlash = lastSeparatorIndex(path);
  const rootLength = rootLengthOf(path);
  if (lastSlash < rootLength) {
    return {
      valid: true,
      directoryPath: path.slice(0, rootLength),
      filter: path.slice(rootLength),
    };
  }
  return {
    valid: true,
    directoryPath: path.slice(0, lastSlash),
    filter: path.slice(lastSlash + 1),
  };
}

function parentOf(path: string): string {
  const rootLength = rootLengthOf(path);
  const index = lastSeparatorIndex(path);
  return index < rootLength ? path.slice(0, rootLength) : path.slice(0, index);
}

export function readShownInput(
  rawInput: string | null,
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
  homePath: string | null,
): string {
  if (rawInput !== null) return rawInput;
  if (data !== undefined) return withTrailingSeparator(data.directoryPath);
  return homePath === null ? "" : withTrailingSeparator(homePath);
}

/** Fall back to lexical navigation when the host cannot list the directory. */
export function readUpPath(
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
  parsed: ParsedBrowseInput,
): string | null {
  if (data !== undefined) return data.parentPath;
  if (parsed.valid && parsed.directoryPath !== null) {
    return parentOf(parsed.directoryPath);
  }
  return null;
}

export function filterEntries(
  entries: ReadonlyArray<WorkspaceBrowseFolderEntryV11> | undefined,
  filter: string,
  showHiddenFolders: boolean,
): ReadonlyArray<WorkspaceBrowseFolderEntryV11> {
  if (entries === undefined) return [];
  const showHidden = showHiddenFolders || filter.startsWith(".");
  const folded = filter.toLowerCase();
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(folded) &&
      (showHidden || !entry.hidden),
  );
}

/** The exact absolute path Add submits, with tilde expanded. */
export function readAddTarget(
  rawInput: string | null,
  homePath: string | null,
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
): string | null {
  if (rawInput === null) return data?.directoryPath ?? homePath;
  const raw = rawInput.trimStart();
  const collapsed = raw.trimEnd();
  if (collapsed === "") return null;
  if (isTildeOnly(collapsed)) return homePath ?? data?.directoryPath ?? null;
  let path = raw;
  if (startsWithTilde(path)) {
    if (homePath === null) return null;
    path = homePath + path.slice(1);
  }
  if (!isAbsolutePath(path)) return null;
  const rootLength = rootLengthOf(path);
  const separator = separatorOf(path);
  while (path.length > rootLength && path.endsWith(separator)) {
    path = path.slice(0, -1);
  }
  return path;
}

export function shouldCreateDirectory(
  rawInput: string | null,
  parsed: ParsedBrowseInput,
  data: WorkspaceBrowseFoldersResponseV11 | undefined,
  listingError: Error | null,
): boolean {
  if (
    rawInput === null ||
    !parsed.valid ||
    parsed.filter === "" ||
    parsed.filter === "." ||
    parsed.filter === ".." ||
    data === undefined ||
    listingError !== null
  ) {
    return false;
  }
  return !data.entries.some((entry) => entry.name === parsed.filter);
}
