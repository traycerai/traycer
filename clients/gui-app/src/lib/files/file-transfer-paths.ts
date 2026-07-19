import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

export interface FileTransferEntries {
  readonly files: readonly File[];
  readonly fileUrlPaths: readonly string[];
}

/**
 * True when `dataTransfer` carries a file-like payload: real `File` items, or
 * a URI-only flavor a source without a `File` object still exposes (macOS
 * `public.file-url`, the standard `text/uri-list`). Shared by every
 * paste/drop surface (terminal, composer) so URI-only clipboards get the same
 * detection as a real Finder drag.
 */
export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("public.file-url") ||
    dataTransferItems(dataTransfer).some((item) => item.kind === "file")
  );
}

export function collectDroppedFiles(
  dataTransfer: DataTransfer,
): readonly File[] {
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files;
  return dataTransferItems(dataTransfer).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

/**
 * True when `dataTransfer` carries a payload an owner should actually claim:
 * real `File` items, or at least one URI entry that PARSES to a genuine
 * `file://` path. Unlike `dataTransferHasFiles` (a type-name-only check,
 * safe during `dragover`/`dragenter` where content isn't readable), this
 * reads actual clipboard/drop content via `getData` - only call it from
 * `paste`/`drop` handlers. A `text/uri-list` carrying just `https://` (or
 * another non-file scheme - an ordinary link paste) must NOT be claimed:
 * `text/uri-list` commonly accompanies an ordinary link paste (e.g. copying
 * a URL from a browser), and claiming on the type name alone - regardless of
 * what it actually contains - silently swallows that paste.
 */
export function hasClaimableFileTransfer(dataTransfer: DataTransfer): boolean {
  const { files, fileUrlPaths } = collectFileTransferEntries(dataTransfer);
  return files.length > 0 || fileUrlPaths.length > 0;
}

/**
 * Returns the file-like payload a surface should process. A real `File` is
 * authoritative: Finder and VS Code often include a duplicate URI flavor,
 * while URI paths are only needed for sources that expose no File object.
 */
export function collectFileTransferEntries(
  dataTransfer: DataTransfer,
): FileTransferEntries {
  const files = collectDroppedFiles(dataTransfer);
  return {
    files,
    fileUrlPaths:
      files.length === 0 ? collectDroppedFileUrlPaths(dataTransfer) : [],
  };
}

/**
 * Resolves every file-like entry in `dataTransfer` to a durable on-disk path,
 * merging real `File` objects (via `fileDrops.resolveDroppedFilePaths`) with
 * URI-only entries (via `fileDrops.copyDroppedFilePaths`). File URLs are a
 * fallback for sources that expose no `File` object - notably macOS
 * screenshot thumbnails. Their backing file can disappear after either a drag
 * or paste, so copy it into an app-managed temporary location before
 * insertion. Real Finder files can carry a duplicate URI list; favor their
 * original path rather than a copied one. Returns `null` when `dataTransfer`
 * carries no file-like payload at all.
 */
export function resolveFileTransferPaths(
  dataTransfer: DataTransfer,
  fileDrops: IFileDropHost,
): Promise<readonly string[]> | null {
  const { files, fileUrlPaths } = collectFileTransferEntries(dataTransfer);
  if (files.length === 0 && fileUrlPaths.length === 0) return null;
  const resolvedFilePaths =
    files.length === 0
      ? Promise.resolve([] as readonly string[])
      : fileDrops.resolveDroppedFilePaths(files);
  const stableUrlPaths =
    fileUrlPaths.length === 0
      ? Promise.resolve([] as readonly string[])
      : fileDrops.copyDroppedFilePaths(fileUrlPaths);
  return Promise.all([resolvedFilePaths, stableUrlPaths]).then(
    ([paths, urlPaths]) => [...paths, ...urlPaths],
  );
}

export function collectDroppedFileUrlPaths(
  dataTransfer: DataTransfer,
): readonly string[] {
  const uriList = readDataTransferData(dataTransfer, "text/uri-list");
  const publicFileUrl = readDataTransferData(dataTransfer, "public.file-url");
  return uniquePaths(
    [...parseFileUriList(uriList), fileUriToPath(publicFileUrl)].filter(
      isNonNullString,
    ),
  );
}

function readDataTransferData(
  dataTransfer: DataTransfer,
  type: string,
): string {
  try {
    return dataTransfer.getData(type);
  } catch {
    return "";
  }
}

function dataTransferItems(
  dataTransfer: DataTransfer,
): readonly DataTransferItem[] {
  const indexedItems = Array.from(dataTransfer.items).filter(
    isDataTransferItem,
  );
  if (indexedItems.length === dataTransfer.items.length) return indexedItems;
  return Array.from({ length: dataTransfer.items.length }, (_value, index) => {
    return dataTransfer.items[index];
  }).filter(isDataTransferItem);
}

function isDataTransferItem(
  value: DataTransferItem | null | undefined,
): value is DataTransferItem {
  return value !== null && value !== undefined;
}

function parseFileUriList(value: string): readonly string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(fileUriToPath)
    .filter(isNonNullString);
}

function fileUriToPath(value: string): string | null {
  if (!value.startsWith("file://")) return null;
  const withoutScheme = value.slice("file://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex === -1) return null;
  const host = withoutScheme.slice(0, slashIndex);
  const rawPath = withoutScheme.slice(slashIndex);
  const path = decodeFileUriPath(rawPath);
  if (path === null) return null;
  if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1);
  if (host.length === 0 || host === "localhost") return path;
  return `//${host}${path}`;
}

function decodeFileUriPath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isNonNullString(value: string | null): value is string {
  return value !== null;
}

export function uniquePaths(paths: readonly string[]): readonly string[] {
  return Array.from(new Set(paths.filter((path) => path.length > 0)));
}
