import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { v4 as uuidv4 } from "uuid";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";
import {
  collectDroppedFileUrlPaths,
  collectDroppedFiles,
  dataTransferHasFiles,
  hasClaimableFileTransfer,
} from "@/lib/files/file-transfer-paths";
import {
  getBasename,
  isWindowsLikePath,
  pathComparisonKey,
  relativizeToWorkspaceRoot,
} from "@/lib/path/cross-platform-path";

export const IMAGE_MIME_PREFIX = "image/";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_READ_TIMEOUT_MS = 15_000;
/**
 * Bound on a single file/URL's `fileDrops` round trip. Without this, a
 * stalled host IPC call never settles `resolveFilePaths`'s `Promise.all`,
 * which permanently gates submit (`isResolvingFilePaths` never clears) and
 * leaks the caret-tracking transaction listener registered by
 * `beginAttachmentInsertion` for the mounted editor's lifetime.
 */
export const FILE_PATH_RESOLUTION_TIMEOUT_MS = 20_000;

/**
 * Races `promise` against a timer, resolving to `onTimeout()` if the timer
 * fires first. Never rejects - a stalled or failing resolution both fall
 * back to the same "not resolved" outcome the caller already handles.
 */
function withResolutionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

function readFileAsDataUrl(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reader.onerror = null;
      reader.onload = null;
      reader.onabort = null;
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      reader.abort();
      fail(new Error("Image read was cancelled"));
    };
    const timeout = window.setTimeout(() => {
      reader.abort();
      fail(new Error("Timed out while reading image"));
    }, IMAGE_READ_TIMEOUT_MS);
    reader.onerror = () => {
      fail(reader.error ?? new Error("Failed to read image"));
    };
    reader.onabort = () => {
      fail(new Error("Image read was cancelled"));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        fail(new Error("Image reader returned non-string result"));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(file);
  });
}

/**
 * `onOversized` lets each surface observe the 5MB rejection (which is
 * user-visible via the toast here) without the shared filter knowing surface
 * names; it receives no file details so nothing sensitive can leak into it.
 */
export function collectImages(
  files: ReadonlyArray<File>,
  onOversized: () => void,
): File[] {
  const accepted: File[] = [];
  for (const file of files) {
    if (!file.type.startsWith(IMAGE_MIME_PREFIX)) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      reportableErrorToast(
        "Image too large",
        {
          description: `${file.name || "Image"} exceeds the 5MB limit.`,
        },
        {
          title: "Image exceeded the size limit",
          message: null,
          code: null,
          source: "Chat composer",
        },
      );
      onOversized();
      continue;
    }
    accepted.push(file);
  }
  return accepted;
}

async function filesToImageAttrs(
  files: ReadonlyArray<File>,
  signal: AbortSignal,
): Promise<ImageAttachmentAttrs[]> {
  // This base64 ingest serves only chat / new-conversation surfaces.
  const accepted = collectImages(files, () => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "chat",
      blocker: "invalid_input",
    });
  });
  if (accepted.length === 0) return [];
  const results = await Promise.all(
    accepted.map(async (file) => {
      const dataUrl = await readFileAsDataUrl(file, signal);
      return {
        id: uuidv4(),
        fileName: file.name || "image",
        b64content: base64PayloadFromDataUrl(dataUrl),
        mimeType: file.type || "image/png",
        size: file.size > 0 ? file.size : null,
      } satisfies ImageAttachmentAttrs;
    }),
  );
  return results;
}

function base64PayloadFromDataUrl(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex < 0 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

/**
 * Converts raw files to image attachment attrs (base64 vs hash-only differs
 * per surface) without inserting them - insertion is coordinated centrally
 * by `useComposerPasteEvents` so a mixed image+path paste can land both as
 * one grouped edit (see `runMixedIngest`). `onSettled` receives the attrs
 * that were actually accepted by the editor alongside every attr that was
 * successfully converted (accepted can be a strict subset, e.g. when the
 * editor isn't ready) - each surface's own bookkeeping (analytics, orphaned-
 * byte reconciliation) depends on that distinction.
 */
export interface ComposerImageIngest {
  readonly convert: (
    files: ReadonlyArray<File>,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<ImageAttachmentAttrs>>;
  readonly onSettled: (
    accepted: ReadonlyArray<ImageAttachmentAttrs>,
    converted: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  readonly onRejected: (error: unknown, aborted: boolean) => void;
}

async function runImageIngest(
  files: ReadonlyArray<File>,
  signal: AbortSignal,
  imageIngest: ComposerImageIngest,
  insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number,
): Promise<void> {
  try {
    const converted = await imageIngest.convert(files, signal);
    if (converted.length === 0) return;
    const acceptedCount = Math.min(
      converted.length,
      Math.max(0, insertAttrs(converted)),
    );
    imageIngest.onSettled(converted.slice(0, acceptedCount), converted);
  } catch (error) {
    imageIngest.onRejected(error, signal.aborted);
  }
}

export interface UseComposerPasteResult {
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  attachImageFiles: (files: ReadonlyArray<File>) => void;
  isDraggingFiles: boolean;
  isIngestingImages: boolean;
  /**
   * True while a paste/drop's non-image file(s) are still resolving to real
   * paths (async `fileDrops` round trip). Independent of `isIngestingImages`
   * - a folder/file-only paste never touches the image pipeline at all, so
   * surfaces that gate submit on attachment activity must check both.
   */
  isResolvingFilePaths: boolean;
}

/**
 * Whether a composer surface should hold submission open - either pipeline
 * (image ingest or file-path resolution) can still land content, either as
 * two independent pastes or as one mixed paste coordinated by
 * `runMixedIngest`.
 */
export function isAttachmentIngestPending(
  paste: Pick<
    UseComposerPasteResult,
    "isIngestingImages" | "isResolvingFilePaths"
  >,
): boolean {
  return paste.isIngestingImages || paste.isResolvingFilePaths;
}

/**
 * What a single attachment-insertion commit lands: image attrs, path spans,
 * or both (a mixed paste). Bundled into one input so a mixed paste's images
 * and paths ALWAYS land through the SAME commit - one captured editor/
 * bookmark, one transaction, one undo group. See
 * `ComposerPromptEditorHandle.beginAttachmentInsertion` for the full
 * contract.
 */
export interface AttachmentInsertionInput {
  readonly attrs: ReadonlyArray<ImageAttachmentAttrs>;
  readonly paths: ReadonlyArray<string>;
}

export type AttachmentInsertionCommit = (
  input: AttachmentInsertionInput,
) => boolean;

/**
 * Non-image paste/drop ingest: resolves every non-image file (and any
 * URI-only clipboard/drop entry) to a real path and inserts each as its own
 * inline-code span. Runner-host-dependent (`fileDrops`) and relativization-
 * dependent (`mentionRoots`) - threaded in explicitly by each surface rather
 * than read from context here, so this stays trivially testable without a
 * `<RunnerHostProvider>`.
 */
export interface ComposerFilePathIngestArgs {
  readonly fileDrops: IFileDropHost;
  readonly mentionRoots: ReadonlyArray<string>;
  /**
   * Starts an attachment-insertion job anchored to the caret *now* (called
   * synchronously from `onPaste`/`onDrop`, before any async resolution
   * begins), returning a one-shot commit to call once the image attrs and/or
   * paths are ready - or `null` if the editor isn't ready to start one at
   * all. See `ComposerPromptEditorHandle.beginAttachmentInsertion` for the
   * full contract.
   */
  readonly beginAttachmentInsertion: () => AttachmentInsertionCommit | null;
}

function isNonImageFile(file: File): boolean {
  return !file.type.startsWith(IMAGE_MIME_PREFIX);
}

interface FilePathResolution {
  readonly name: string;
  readonly path: string | null;
}

function resolutionFromPaths(
  name: string,
  resolved: readonly string[],
): FilePathResolution {
  const path = resolved.at(0);
  return { name, path: path !== undefined && path.length > 0 ? path : null };
}

/**
 * Resolves one file/URL entry at a time (rather than a single batched call)
 * so a failure on one item never sinks the rest, and so the failure can be
 * attributed back to its source name for the partial-failure toast -
 * `IFileDropHost`'s batched result carries no such correlation.
 */
async function resolveFileToPath(
  file: File,
  fileDrops: IFileDropHost,
): Promise<FilePathResolution> {
  const name = file.name.length > 0 ? file.name : "file";
  try {
    const resolved = await withResolutionTimeout(
      fileDrops.resolveDroppedFilePaths([file]),
      FILE_PATH_RESOLUTION_TIMEOUT_MS,
      () => [] as readonly string[],
    );
    return resolutionFromPaths(name, resolved);
  } catch {
    return { name, path: null };
  }
}

async function resolveUrlPathToPath(
  urlPath: string,
  fileDrops: IFileDropHost,
): Promise<FilePathResolution> {
  const basename = getBasename(urlPath);
  const name = basename.length > 0 ? basename : urlPath;
  try {
    const resolved = await withResolutionTimeout(
      fileDrops.copyDroppedFilePaths([urlPath]),
      FILE_PATH_RESOLUTION_TIMEOUT_MS,
      () => [] as readonly string[],
    );
    return resolutionFromPaths(name, resolved);
  } catch {
    return { name, path: null };
  }
}

function displayPathForInsertion(
  path: string,
  mentionRoots: ReadonlyArray<string>,
): string {
  return relativizeToWorkspaceRoot(mentionRoots, path) ?? path;
}

function showFilePathResolutionToast(
  resolvedCount: number,
  failedNames: ReadonlyArray<string>,
): void {
  if (failedNames.length === 0) return;
  if (resolvedCount === 0) {
    reportableErrorToast(
      "Couldn't resolve file path",
      {
        description: "This surface can't read a real file path from the paste.",
      },
      {
        title: "Could not resolve file path",
        message: null,
        code: null,
        source: "Chat composer",
      },
    );
    return;
  }
  const plural = failedNames.length === 1 ? "file" : "files";
  reportableErrorToast(
    `Couldn't add ${failedNames.length} ${plural}`,
    { description: failedNames.join(", ") },
    {
      title: "Could not resolve file path",
      message: null,
      code: null,
      source: "Chat composer",
    },
  );
}

interface ResolvedFilePaths {
  readonly resolvedPaths: ReadonlyArray<string>;
  readonly failedNames: ReadonlyArray<string>;
}

async function resolveFilePaths(
  files: ReadonlyArray<File>,
  fileUrlPaths: ReadonlyArray<string>,
  fileDrops: IFileDropHost,
): Promise<ResolvedFilePaths> {
  // Resolve image Files only when a URI source is present to correlate. A
  // normal image-only or mixed image+document paste keeps the existing image
  // ingest's host-call footprint; their non-image inputs are the only paths
  // that can be inserted.
  const filesRequiringResolution =
    fileUrlPaths.length === 0 ? files.filter(isNonImageFile) : files;
  const fileResults = await Promise.all(
    filesRequiringResolution.map((file) =>
      resolveFileToPath(file, fileDrops),
    ),
  );
  // A Finder transfer can carry a real File alongside its file:// source. The
  // URI path is copied to a newly named temp file, so comparing *resolved*
  // outputs would not identify the pair. Compare source paths before copying
  // instead, including image Files: an image File + URI alias must keep the
  // existing image-only behavior. If the File could not resolve, leave the
  // URI eligible as the durability fallback.
  const fileSourcePaths = fileResults.flatMap((result) =>
    result.path === null ? [] : [result.path],
  );
  const uriPathsToMaterialize = fileUrlPaths.filter(
    (urlPath) =>
      !fileSourcePaths.some((filePath) =>
        pathsHaveSameSourceIdentity(filePath, urlPath),
      ),
  );
  const urlResults = await Promise.all(
    uriPathsToMaterialize.map((urlPath) =>
      resolveUrlPathToPath(urlPath, fileDrops),
    ),
  );
  const results = [
    ...fileResults.filter((_, index) => {
      const file = filesRequiringResolution.at(index);
      return file !== undefined && isNonImageFile(file);
    }),
    ...urlResults,
  ];
  const resolvedPaths = results.flatMap((result) =>
    result.path === null ? [] : [result.path],
  );
  const failedNames = results
    .filter((result) => result.path === null)
    .map((result) => result.name);
  return { resolvedPaths, failedNames };
}

function pathsHaveSameSourceIdentity(left: string, right: string): boolean {
  const caseInsensitive =
    isWindowsLikePath(left) || isWindowsLikePath(right);
  return (
    pathComparisonKey(left, caseInsensitive) ===
    pathComparisonKey(right, caseInsensitive)
  );
}

async function resolveAndInsertFilePaths(
  files: ReadonlyArray<File>,
  fileUrlPaths: ReadonlyArray<string>,
  filePaths: ComposerFilePathIngestArgs,
  commit: AttachmentInsertionCommit,
): Promise<void> {
  const { resolvedPaths, failedNames } = await resolveFilePaths(
    files,
    fileUrlPaths,
    filePaths.fileDrops,
  );
  const displayPaths = resolvedPaths.map((path) =>
    displayPathForInsertion(path, filePaths.mentionRoots),
  );
  // `commit` returns `false` when the editor was torn down (unmounted or
  // replaced) while this resolution was in flight - skip both the insertion
  // it already skipped internally and the toast, since there's no longer a
  // composer surface for either to land on.
  if (!commit({ attrs: [], paths: displayPaths })) return;
  showFilePathResolutionToast(resolvedPaths.length, failedNames);
}

/**
 * Coordinates a MIXED paste (image files alongside non-image files/paths in
 * the same clipboard/drop) as one grouped edit: both conversions run
 * concurrently, and neither lands until BOTH have settled, at which point
 * image attrs and path spans are handed to ONE `commit` call together - the
 * SAME captured editor/bookmark, ONE ProseMirror transaction. Committing
 * independently (a separate image-insertion call against "whatever the
 * editor ref currently points at" and a separate path commit against the
 * captured bookmark) risks landing far enough apart in time that ProseMirror's
 * history plugin (`newGroupDelay`, 500ms by default) starts a new undo group
 * for the second one - so a single Undo only reverts part of the paste - and
 * risks a torn-down/replaced editor accepting one half but not the other.
 */
interface MixedIngestInput {
  readonly files: ReadonlyArray<File>;
  readonly fileUrlPaths: ReadonlyArray<string>;
  readonly signal: AbortSignal;
}

interface MixedIngestContext {
  readonly imageIngest: ComposerImageIngest;
  readonly filePaths: ComposerFilePathIngestArgs;
  readonly commit: AttachmentInsertionCommit;
}

async function runMixedIngest(
  input: MixedIngestInput,
  ctx: MixedIngestContext,
): Promise<void> {
  const { files, fileUrlPaths, signal } = input;
  const { imageIngest, filePaths, commit } = ctx;
  const [imageResult, pathResult] = await Promise.all([
    imageIngest.convert(files, signal).then(
      (
        converted,
      ): {
        readonly ok: true;
        readonly converted: ReadonlyArray<ImageAttachmentAttrs>;
      } => ({
        ok: true,
        converted,
      }),
      (error: unknown): { readonly ok: false; readonly error: unknown } => ({
        ok: false,
        error,
      }),
    ),
    resolveFilePaths(files, fileUrlPaths, filePaths.fileDrops),
  ]);

  const converted: ReadonlyArray<ImageAttachmentAttrs> = imageResult.ok
    ? imageResult.converted
    : [];
  const displayPaths = pathResult.resolvedPaths.map((path) =>
    displayPathForInsertion(path, filePaths.mentionRoots),
  );
  // Nothing to commit (e.g. every file was oversized/unresolvable) - `live`
  // stays true so the caller's bookkeeping proceeds as normal, matching
  // `commit`'s own "nothing to insert" no-op contract.
  const live =
    converted.length === 0 && displayPaths.length === 0
      ? true
      : commit({ attrs: converted, paths: displayPaths });
  const accepted = live ? converted : [];

  if (converted.length > 0) imageIngest.onSettled(accepted, converted);
  if (!imageResult.ok)
    imageIngest.onRejected(imageResult.error, signal.aborted);
  if (!live) return;
  showFilePathResolutionToast(
    pathResult.resolvedPaths.length,
    pathResult.failedNames,
  );
}

/**
 * Drag/drop/paste plumbing shared by every composer surface. The image ingest
 * (base64 vs hash-only) is delegated to `imageIngest`/`insertAttrs`; image
 * filtering + the 5MB cap belong to the ingest via `collectImages`. Surfaces
 * wrap this with their own ingest: `useComposerPasteAdapter` (base64) for
 * chat / new-conversation, `useLandingComposerPaste` (hash-only) for landing.
 * Non-image file/URL entries always resolve through `filePaths`, identically
 * across every surface (see `resolveAndInsertFilePaths`). A paste/drop that
 * carries BOTH kinds routes through `runMixedIngest` instead of the two
 * independent paths below, so they land as one grouped edit.
 */
export function useComposerPasteEvents(
  imageIngest: ComposerImageIngest,
  insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number,
  filePaths: ComposerFilePathIngestArgs,
): UseComposerPasteResult {
  const [dragDepth, setDragDepth] = useState(0);
  const [pendingImageCount, setPendingImageCount] = useState(0);
  const [pendingPathCount, setPendingPathCount] = useState(0);
  const activeRef = useRef(true);
  const controllersRef = useRef(new Set<AbortController>());

  useEffect(() => {
    activeRef.current = true;
    const controllers = controllersRef.current;
    return () => {
      activeRef.current = false;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  const trackPendingImageJob = useCallback(
    (job: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      setPendingImageCount((count) => count + 1);
      void job(controller.signal).finally(() => {
        controllersRef.current.delete(controller);
        if (!activeRef.current) return;
        setPendingImageCount((count) => Math.max(0, count - 1));
      });
    },
    [],
  );

  const attachImageFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      trackPendingImageJob((signal) =>
        runImageIngest(files, signal, imageIngest, insertAttrs),
      );
    },
    [imageIngest, insertAttrs, trackPendingImageJob],
  );

  const attachFilePaths = useCallback(
    (files: ReadonlyArray<File>, fileUrlPaths: ReadonlyArray<string>) => {
      if (files.length === 0 && fileUrlPaths.length === 0) return;
      // Anchors the job to the caret *now*, synchronously, before the async
      // resolution below starts - see `beginAttachmentInsertion`'s contract.
      const commit = filePaths.beginAttachmentInsertion();
      if (commit === null) return;
      setPendingPathCount((count) => count + 1);
      void resolveAndInsertFilePaths(
        files,
        fileUrlPaths,
        filePaths,
        commit,
      ).finally(() => {
        if (!activeRef.current) return;
        setPendingPathCount((count) => Math.max(0, count - 1));
      });
    },
    [filePaths],
  );

  const attachMixed = useCallback(
    (
      files: ReadonlyArray<File>,
      fileUrlPaths: ReadonlyArray<string>,
    ) => {
      const commit = filePaths.beginAttachmentInsertion();
      if (commit === null) {
        // No live editor to anchor the job to at all - fall back to the
        // independent image path rather than dropping the images too.
        attachImageFiles(files);
        return;
      }
      trackPendingImageJob((signal) =>
        runMixedIngest(
          { files, fileUrlPaths, signal },
          { imageIngest, filePaths, commit },
        ),
      );
    },
    [attachImageFiles, filePaths, imageIngest, trackPendingImageJob],
  );

  const dispatchFileTransfer = useCallback(
    (files: ReadonlyArray<File>, fileUrlPaths: ReadonlyArray<string>) => {
      const hasImageFiles = files.some((file) => !isNonImageFile(file));
      const nonImageFiles = files.filter(isNonImageFile);
      const hasPaths = nonImageFiles.length > 0 || fileUrlPaths.length > 0;
      if (hasImageFiles && hasPaths) {
        attachMixed(files, fileUrlPaths);
        return;
      }
      if (files.length > 0) attachImageFiles(files);
      attachFilePaths(nonImageFiles, fileUrlPaths);
    },
    [attachFilePaths, attachImageFiles, attachMixed],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!hasClaimableFileTransfer(event.clipboardData)) return;
      event.preventDefault();
      const files = collectDroppedFiles(event.clipboardData);
      // Collected as a UNION with `files` (not gated on `files.length === 0`)
      // - a DataTransfer can carry a real File alongside a text/uri-list/
      // public.file-url entry for the SAME source, or additional distinct
      // URI entries alongside a File for a different one. Cross-flavor
      // aliases of the same source are suppressed after resolution, once
      // both sides' resolved paths are known (see `resolveFilePaths`).
      const fileUrlPaths = collectDroppedFileUrlPaths(event.clipboardData);
      dispatchFileTransfer(files, fileUrlPaths);
    },
    [dispatchFileTransfer],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragDepth((depth) => depth + 1);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragDepth((depth) => Math.max(0, depth - 1));
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      // Drag-enter can only inspect the transfer's type names, so an ordinary
      // HTTPS URI is intentionally shown as potentially file-like until its
      // payload is readable here. A drop does not reliably emit dragleave,
      // therefore it must always clear the affordance before deciding whether
      // this hook owns the content.
      setDragDepth(0);
      if (!hasClaimableFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = collectDroppedFiles(event.dataTransfer);
      // Union with `files` - see the matching comment in `onPaste`.
      const fileUrlPaths = collectDroppedFileUrlPaths(event.dataTransfer);
      dispatchFileTransfer(files, fileUrlPaths);
    },
    [dispatchFileTransfer],
  );

  return {
    onPaste,
    onDrop,
    onDragOver,
    onDragEnter,
    onDragLeave,
    attachImageFiles,
    isDraggingFiles: dragDepth > 0,
    isIngestingImages: pendingImageCount > 0,
    isResolvingFilePaths: pendingPathCount > 0,
  };
}

/**
 * Base64 paste adapter for chat / new-conversation: accepted files are read as
 * base64 (`filesToImageAttrs`) and inserted as inline `b64content` nodes. This
 * is the behavior every non-landing surface relies on — do NOT change it.
 */
export function useComposerPasteAdapter(
  insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number,
  filePaths: ComposerFilePathIngestArgs,
): UseComposerPasteResult {
  const imageIngest = useMemo(
    (): ComposerImageIngest => ({
      convert: filesToImageAttrs,
      onSettled: (accepted) => {
        accepted.forEach(() => {
          Analytics.getInstance().track(AnalyticsEvent.AttachmentAdded, {
            kind: "image",
            surface: "chat",
          });
        });
      },
      onRejected: (error, aborted) => {
        Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
          kind: "image",
          surface: "chat",
          blocker: analyticsBlockerFromError(error),
        });
        if (aborted) return;
        reportableErrorToast(
          "Couldn't attach the image.",
          {
            description: "Please try adding it again.",
          },
          {
            title: "Could not attach image",
            message: null,
            code: null,
            source: "Chat composer",
          },
        );
      },
    }),
    [],
  );
  return useComposerPasteEvents(imageIngest, insertAttrs, filePaths);
}

export interface ComposerPasteEditorHandle {
  readonly isReady: () => boolean;
  readonly insertImageAttachments: (
    attrs: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  readonly beginAttachmentInsertion: () => AttachmentInsertionCommit | null;
  readonly focus: () => void;
}

export function useComposerPaste(
  editorRef: {
    readonly current: ComposerPasteEditorHandle | null;
  },
  fileDrops: IFileDropHost,
  mentionRoots: ReadonlyArray<string>,
): UseComposerPasteResult {
  const insertAttrs = useCallback(
    (attrs: ReadonlyArray<ImageAttachmentAttrs>): number => {
      const handle = editorRef.current;
      if (handle === null || !handle.isReady()) return 0;
      handle.insertImageAttachments(attrs);
      handle.focus();
      return attrs.length;
    },
    [editorRef],
  );
  const beginAttachmentInsertion =
    useCallback((): AttachmentInsertionCommit | null => {
      const handle = editorRef.current;
      if (handle === null || !handle.isReady()) return null;
      return handle.beginAttachmentInsertion();
    }, [editorRef]);
  const filePaths = useMemo(
    () => ({ fileDrops, mentionRoots, beginAttachmentInsertion }),
    [fileDrops, mentionRoots, beginAttachmentInsertion],
  );
  return useComposerPasteAdapter(insertAttrs, filePaths);
}

export function insertImageAttachmentsCommand(
  editor: Editor,
  attrs: ReadonlyArray<ImageAttachmentAttrs>,
  stabilizeCaretBoundary: boolean,
): void {
  if (attrs.length === 0) return;
  let chain = editor.chain();
  for (const attr of attrs) {
    chain = chain.insertImageAttachment(attr);
  }
  chain.run();
  if (stabilizeCaretBoundary) {
    stabilizeTerminalImageAttachmentCaret(editor);
  }
}

/**
 * Transaction meta key tagging an attachment-insertion commit's own
 * transaction with the sequence number `beginAttachmentInsertion` assigned
 * it. Sibling jobs anchored at the same caret read this back (see
 * `mapAttachmentAnchor` in `composer-prompt-editor.tsx`) to decide, per
 * observed transaction, whether their own tracked anchor should advance past
 * it (an earlier-sequenced sibling's content) or stay pinned before it
 * (everything else) - what makes concurrent same-caret jobs render in paste
 * order regardless of resolution order.
 */
export const ATTACHMENT_JOB_SEQUENCE_META = "composerAttachmentJobSequence";

function pathSpansContent(paths: ReadonlyArray<string>): Array<{
  readonly type: string;
  readonly text: string;
  readonly marks?: ReadonlyArray<{ readonly type: string }>;
}> {
  const content = paths.flatMap((path, index) => {
    const span = { type: "text", text: path, marks: [{ type: "code" }] };
    return index === 0 ? [span] : [{ type: "text", text: " " }, span];
  });
  content.push({ type: "text", text: " " });
  return content;
}

export interface InsertAttachmentsCommandInput {
  readonly attrs: ReadonlyArray<ImageAttachmentAttrs>;
  readonly paths: ReadonlyArray<string>;
  readonly range: { readonly from: number; readonly to: number };
  readonly sequence: number;
  readonly stabilizeCaretBoundary: boolean;
}

/**
 * Inserts image attrs and/or resolved paths as ONE ProseMirror transaction
 * (one undo group), at an explicit `range` (rather than "wherever the
 * selection currently is") because both resolve asynchronously - by the time
 * this runs, the caret/selection the user pasted at may have moved. Callers
 * map a range captured at paste/drop time forward through any intervening
 * transactions (see `ComposerPromptEditorHandle.beginAttachmentInsertion`)
 * before calling this. A non-collapsed range is replaced first, matching
 * normal paste-over-selection semantics. Images land before paths (this
 * ordering is an accepted product decision, not itself under test); each
 * path is its own inline-code span, space-separated, with a trailing PLAIN
 * space so the caret lands past the code mark - continued typing resumes as
 * prose rather than extending the last path. `unsetMark` clears the code
 * mark from stored marks as a second, explicit guarantee alongside the plain
 * trailing character.
 */
export function insertAttachmentsCommand(
  editor: Editor,
  input: InsertAttachmentsCommandInput,
): void {
  const { attrs, paths, range, sequence, stabilizeCaretBoundary } = input;
  if (attrs.length === 0 && paths.length === 0) return;
  // History's 500ms grouping would otherwise fold this deferred commit into
  // typing that landed at the same caret while resolution was pending. Close
  // both boundaries: this transaction starts a fresh group, and the no-op
  // transaction below prevents immediately-following typing from joining it.
  let chain = editor.chain().command(({ tr }) => {
    closeHistory(tr);
    return true;
  }).setTextSelection(range);
  if (range.from !== range.to) chain = chain.deleteSelection();
  for (const attr of attrs) {
    chain = chain.insertImageAttachment(attr);
  }
  if (paths.length > 0) {
    chain = chain.insertContent(pathSpansContent(paths)).unsetMark("code");
  }
  chain
    .command(({ tr }) => {
      tr.setMeta(ATTACHMENT_JOB_SEQUENCE_META, sequence);
      return true;
    })
    .run();
  if (attrs.length > 0 && paths.length === 0 && stabilizeCaretBoundary) {
    stabilizeTerminalImageAttachmentCaret(editor);
  }
  editor.view.dispatch(closeHistory(editor.state.tr));
}

function stabilizeTerminalImageAttachmentCaret(editor: Editor): void {
  const { selection } = editor.state;
  if (!selection.empty) return;
  const { $from } = selection;
  if (!$from.parent.inlineContent) return;
  const nodeBefore = $from.nodeBefore;
  if (nodeBefore?.type.name !== "imageAttachment") return;
  if ($from.nodeAfter !== null) return;

  const boundaryPos = selection.from;
  editor
    .chain()
    .insertContent({ type: "text", text: " " })
    .setTextSelection(boundaryPos)
    .run();
}
