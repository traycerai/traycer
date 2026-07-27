import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

export interface FileTransferEntries {
  readonly files: readonly File[];
  readonly fileUrlPaths: readonly string[];
}

export type FileTransferDragOverlayVariant = "images" | "paths" | "mixed";

export interface FileTransferDragItem {
  readonly kind: string;
  readonly type: string;
}

export interface FileTransferDragMetadata {
  readonly types: ArrayLike<string>;
  readonly items: ArrayLike<FileTransferDragItem | null | undefined>;
}

export interface FileTransferClipboardMetadata extends FileTransferDragMetadata {
  readonly files: ArrayLike<File>;
  getData(type: string): string;
}

interface FileTransferDataReader {
  getData(type: string): string;
}

const USABLE_CLIPBOARD_TEXT_FLAVORS = [
  "text/uri-list",
  "public.file-url",
  "text/html",
  "text/plain",
  "application/x-traycer-composer+json",
  "web application/x-traycer-composer+json",
] as const;

/**
 * True when `dataTransfer` carries a file-like payload: real `File` items, or
 * a URI-only flavor a source without a `File` object still exposes (macOS
 * `public.file-url`, the standard `text/uri-list`). Shared by every
 * paste/drop surface (terminal, composer) so URI-only clipboards get the same
 * detection as a real Finder drag.
 */
export function dataTransferHasFiles(
  dataTransfer: FileTransferDragMetadata,
): boolean {
  const types = Array.from(dataTransfer.types);
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("public.file-url") ||
    fileTransferDragItems(dataTransfer).some((item) => item.kind === "file")
  );
}

/**
 * Classifies a file-like drag from metadata the browser exposes before drop.
 * This must not inspect file contents (`getAsFile`/`getData`), which are not
 * reliably readable during dragover. A URI-only transfer remains a path
 * candidate while its URI content is unavailable.
 */
export function classifyFileTransferDrag(
  dataTransfer: FileTransferDragMetadata,
): FileTransferDragOverlayVariant | null {
  if (!dataTransferHasFiles(dataTransfer)) return null;
  const fileItems = fileTransferDragItems(dataTransfer).filter(
    (item) => item.kind === "file",
  );
  if (fileItems.length === 0) return "paths";
  const hasImages = fileItems.some((item) => item.type.startsWith("image/"));
  const hasPaths = fileItems.some((item) => !item.type.startsWith("image/"));
  if (hasImages && hasPaths) return "mixed";
  return hasImages ? "images" : "paths";
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
 * Native clipboard fallback is deliberately narrower than file-transfer
 * ownership: any ordinary text, rich content, URI, or File item leaves the
 * browser paste path untouched. This is only true for Chromium's empty DOM
 * clipboard snapshot of native-only VS Code explorer copies.
 */
export function dataTransferHasUsableClipboardData(
  dataTransfer: FileTransferClipboardMetadata,
): boolean {
  return (
    Array.from(dataTransfer.files).length > 0 ||
    fileTransferDragItems(dataTransfer).some((item) => item.kind === "file") ||
    USABLE_CLIPBOARD_TEXT_FLAVORS.some(
      (flavor) => readDataTransferData(dataTransfer, flavor).length > 0,
    )
  );
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
 * fallback for sources that expose no `File` object. The host preserves stable
 * paths and copies only known ephemeral sources (notably macOS screenshot
 * thumbnails) into an app-managed temporary location. Real Finder files can
 * carry a duplicate URI list; favor their original path. Returns `null` when
 * `dataTransfer` carries no file-like payload at all.
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
  const durableUrlPaths =
    fileUrlPaths.length === 0
      ? Promise.resolve([] as readonly string[])
      : fileDrops.copyDroppedFilePaths(fileUrlPaths);
  return Promise.all([resolvedFilePaths, durableUrlPaths]).then(
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
  dataTransfer: FileTransferDataReader,
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

function fileTransferDragItems(
  dataTransfer: FileTransferDragMetadata,
): readonly FileTransferDragItem[] {
  return Array.from({ length: dataTransfer.items.length }, (_value, index) => {
    return dataTransfer.items[index];
  }).filter(isFileTransferDragItem);
}

function isFileTransferDragItem(
  value: FileTransferDragItem | null | undefined,
): value is FileTransferDragItem {
  return value !== null && value !== undefined;
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
