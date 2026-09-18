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
import { isHostStorableImageMimeType } from "@/lib/composer/host-storable-image-formats";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { PREPARED_IMAGE_SOURCE_CEILING } from "@/lib/composer/prompt-stash-image-preparation";
import {
  createComposerImagePreparationSession,
  prepareComposerImageBytesOrRefuse,
  showImageTooLargeToast,
  type ImagePreparationSession,
  type PreparedComposerImage,
} from "@/lib/composer/composer-image-preparation";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import {
  holdPendingIngestImageHash,
  mintPendingIngestHolderId,
  releasePendingIngestImageHashes,
} from "@/lib/composer/pending-ingest-image-roots";
import { putImage } from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import {
  LANDING_IMAGE_MAX_BYTES_PER_IMAGE,
  reserveLandingImageBudget,
} from "@/lib/composer/landing-image-budget";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";
import {
  classifyFileTransferDrag,
  collectFileTransferEntries,
  dataTransferHasUsableClipboardData,
  hasClaimableFileTransfer,
  type FileTransferDragOverlayVariant,
} from "@/lib/files/file-transfer-paths";
import {
  getBasename,
  relativizeToWorkspaceRoot,
} from "@/lib/path/cross-platform-path";

export const IMAGE_MIME_PREFIX = "image/";
/**
 * The only size a paste refuses outright, and it is a SOURCE bound: anything
 * under it is resized and re-encoded to fit rather than turned away.
 *
 * This replaces the old per-image ceiling at the FILTER. That ceiling has not
 * gone away — it moved to the OUTPUT (`PREPARED_IMAGE_MAX_BYTES`), which is
 * what preparation guarantees and what the budget then charges. Keeping the
 * old bound here as well would refuse, before any decode, exactly the images
 * preparation exists to make attachable.
 */
export const MAX_IMAGE_SOURCE_BYTES = PREPARED_IMAGE_SOURCE_CEILING;
export const IMAGE_READ_TIMEOUT_MS = 15_000;
/**
 * Bound on a single file/URL's `fileDrops` round trip. Without this, a
 * stalled host IPC call never settles `resolveFilePaths`'s `Promise.all`,
 * which permanently gates submit (`isResolvingFilePaths` never clears) and
 * keeps the path-insertion job pending indefinitely.
 */
export const FILE_PATH_RESOLUTION_TIMEOUT_MS = 20_000;

/**
 * Reject `promise` if it has not settled within `timeoutMs`, or as soon as
 * `signal` aborts - whichever comes first.
 *
 * The hash ingest replaced `readFileAsDataUrl`, and in doing so silently
 * dropped two guarantees that reader had: a 15-second deadline, and a rejection
 * that fires the MOMENT the signal aborts rather than whenever the underlying
 * promise gets round to settling. Without them a stalled `arrayBuffer()` or
 * `putImage()` leaves `pendingImageCount` positive forever - Send disabled, the
 * budget reservation charged, and cancelling or unmounting unable to settle it.
 *
 * The underlying promise is NOT cancellable, so a late completion still
 * happens; it simply arrives after this has rejected and its caller has already
 * cleaned up. That is why the caller must never insert or root on a late
 * completion - see the pending-ingest root hold, which is released on the
 * rejection path and so leaves late bytes to the ordinary sweep.
 */
export function withAbortableDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  describeTimeout: () => string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      run();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(new Error("Image ingest aborted"));
      });
    };
    const timer = window.setTimeout(() => {
      finish(() => {
        reject(new Error(describeTimeout()));
      });
    }, timeoutMs);
    if (signal.aborted) {
      // Observe `promise` even though its value is now worthless. It is ALREADY
      // RUNNING - it was constructed at the call site, before this function was
      // entered - so returning without attaching a handler leaves its rejection
      // with no owner, which surfaces as an unhandled rejection the user's
      // console reports and nothing catches. Every other exit observes it
      // through the `promise.then` below; this one has to do it explicitly.
      void promise.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      },
    );
  });
}

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

/**
 * A file's raw bytes, under upstream's own deadline+abort bound rather than a
 * second hand-rolled one.
 *
 * Bytes, not a data URL: preparation works on bytes, so reading base64 first
 * would make one extra full copy of the image and then throw it away. The two
 * paths that still need base64 encode it from the PREPARED bytes instead,
 * which is what the node has to carry anyway.
 */
function readFileBytes(file: File, signal: AbortSignal): Promise<ImageBytes> {
  return withAbortableDeadline(
    file.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    IMAGE_READ_TIMEOUT_MS,
    signal,
    () => `Reading ${file.name || "image"} timed out`,
  );
}

/**
 * `onOversized` lets each surface observe the rejection (which is user-visible
 * via the toast here) without the shared filter knowing surface names; it
 * receives no file details so nothing sensitive can leak into it.
 *
 * The only size refused here is the SOURCE ceiling, checked against
 * `File.size` so an enormous paste never reaches a decoder at all. Everything
 * under it is preparation's problem, and preparation is what decides whether
 * it can be made to fit.
 */
export function collectImages(
  files: ReadonlyArray<File>,
  onOversized: () => void,
): File[] {
  const accepted: File[] = [];
  for (const file of files) {
    if (!file.type.startsWith(IMAGE_MIME_PREFIX)) continue;
    if (file.size > MAX_IMAGE_SOURCE_BYTES) {
      showImageTooLargeToast(file.name);
      onOversized();
      continue;
    }
    accepted.push(file);
  }
  return accepted;
}

export interface PrepareComposerImageBytesArgs {
  readonly session: ImagePreparationSession;
  readonly bytes: ImageBytes;
  /** Names the file in the refusal toast, and rides onto the prepared image. */
  readonly fileName: string;
  readonly mimeType: string;
  /** The surface's own analytics hook; the toast is raised here. */
  readonly onRefused: () => void;
}

/**
 * Prepares one already-read image, reporting a refusal the way a paste does:
 * one toast naming the file, and `onRefused` for the surface's own analytics.
 * `null` means the image cannot be made to fit and must not be attached.
 */
export async function prepareComposerImageBytes(
  args: PrepareComposerImageBytesArgs,
): Promise<PreparedComposerImage | null> {
  const prepared = await prepareComposerImageBytesOrRefuse(
    args.session,
    args.bytes,
    args.fileName,
    args.mimeType,
  );
  if (prepared.kind === "prepared") return prepared.image;
  showImageTooLargeToast(args.fileName);
  args.onRefused();
  return null;
}

/** `prepareComposerImageBytes` for a File the surface has not read yet. */
export async function prepareComposerImageFile(
  session: ImagePreparationSession,
  file: File,
  signal: AbortSignal,
  onRefused: () => void,
): Promise<PreparedComposerImage | null> {
  const bytes = await readFileBytes(file, signal);
  return prepareComposerImageBytes({
    session,
    bytes,
    fileName: file.name || "image",
    mimeType: file.type || "image/png",
    onRefused,
  });
}

async function filesToImageAttrs(
  files: ReadonlyArray<File>,
  signal: AbortSignal,
  session: ImagePreparationSession,
): Promise<ComposerImageConversionResult> {
  // This base64 ingest serves only chat / new-conversation surfaces.
  const trackRejected = (): void => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "chat",
      blocker: "invalid_input",
    });
  };
  const accepted = collectImages(files, trackRejected);
  if (accepted.length === 0) return { attrs: [] };
  const attrs: ImageAttachmentAttrs[] = [];
  // Serial, and on the MOUNT's session: one decode/encode at a time, so a
  // multi-image paste peaks at one image's memory rather than the batch's, and
  // a second paste arriving mid-conversion queues behind this one instead of
  // decoding alongside it.
  for (const file of accepted) {
    signal.throwIfAborted();
    const prepared = await prepareComposerImageFile(
      session,
      file,
      signal,
      trackRejected,
    );
    if (prepared === null) continue;
    attrs.push({
      id: uuidv4(),
      fileName: prepared.fileName,
      b64content: bytesToBase64(prepared.bytes),
      mimeType: prepared.mimeType,
      // The PREPARED size and type, never the source's: this is what the node
      // carries, what the budget reads back, and what is actually sent.
      size: prepared.byteLength > 0 ? prepared.byteLength : null,
      byHashEligible: prepared.byHashEligible,
    } satisfies ImageAttachmentAttrs);
  }
  // No reserved capacity to hand off - this surface has no landing-style
  // budget, so there is nothing for `runImageIngest` to release.
  return { attrs };
}

/**
 * Result of converting raw files to image attachment attrs, before insertion.
 * `release` (when supplied) is capacity a surface reserved across the
 * conversion writes above (landing's hash-only ingest) - `runImageIngest`
 * below calls it exactly once, only AFTER `insertAttrs` has run (or thrown),
 * never earlier. A surface with no such reservation (chat / new-conversation,
 * whose base64 ingest owns no budget) simply omits it.
 */
export interface ComposerImageConversionResult<Attrs = ImageAttachmentAttrs> {
  readonly attrs: ReadonlyArray<Attrs>;
  readonly release?: () => void;
}

/**
 * Converts raw files to image attachment attrs (base64 vs hash-only differs
 * per surface) without inserting them. `onSettled` receives the attrs
 * that were actually accepted by the editor alongside every attr that was
 * successfully converted (accepted can be a strict subset, e.g. when the
 * editor isn't ready) - each surface's own bookkeeping (analytics, orphaned-
 * byte reconciliation) depends on that distinction.
 */
export interface ComposerImageIngest<Attrs = ImageAttachmentAttrs> {
  readonly convert: (
    files: ReadonlyArray<File>,
    signal: AbortSignal,
  ) => Promise<ComposerImageConversionResult<Attrs>>;
  readonly onSettled: (
    accepted: ReadonlyArray<Attrs>,
    converted: ReadonlyArray<Attrs>,
  ) => Promise<void> | void;
  readonly onRejected: (error: unknown, aborted: boolean) => void;
}

export interface ComposerImageInsertion<Attrs> {
  readonly insert: (attrs: ReadonlyArray<Attrs>) => number;
  readonly release: () => void;
}

export type ComposerImageInsertionFactory<Attrs> =
  () => ComposerImageInsertion<Attrs> | null;

async function runImageIngest<Attrs>(
  files: ReadonlyArray<File>,
  signal: AbortSignal,
  imageIngest: ComposerImageIngest<Attrs>,
  insertion: ComposerImageInsertion<Attrs>,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    const result = await imageIngest.convert(files, signal);
    release = result.release;
    const converted = result.attrs;
    if (converted.length === 0) return;
    const acceptedCount = Math.min(
      converted.length,
      Math.max(0, insertion.insert(converted)),
    );
    await imageIngest.onSettled(converted.slice(0, acceptedCount), converted);
  } catch (error) {
    imageIngest.onRejected(error, signal.aborted);
  } finally {
    // Fires after insertion decides the reserved bytes' fate (accepted,
    // not-inserted, or thrown) - never before, and never from inside
    // `convert` itself, so a concurrent admission check during the
    // conversion-to-insertion handoff still sees this reservation charged.
    release?.();
    insertion.release();
  }
}

export interface UseComposerPasteResult {
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  attachImageFiles: (files: ReadonlyArray<File>) => void;
  /**
   * Run a caller-provided async image job under the SAME pending accounting as
   * `attachImageFiles` (so it counts toward `isIngestingImages`/submit gating)
   * and abort signal (fired on unmount). Landing's in-place b64 paste uses this
   * for its per-image hash+store+rewrite jobs, which insert nothing themselves —
   * the node is already in the document.
   */
  runPendingImageJob: (job: (signal: AbortSignal) => Promise<void>) => void;
  isDraggingFiles: boolean;
  dragOverlayVariant: FileTransferDragOverlayVariant | null;
  isIngestingImages: boolean;
  /**
   * True while a paste/drop's non-image file(s) are still resolving to real
   * paths (async `fileDrops` round trip). Independent of `isIngestingImages`
   * - a folder/file-only paste never touches the image pipeline at all, so
   * surfaces that gate submit on attachment activity must check both.
   */
  isResolvingFilePaths: boolean;
}

interface ComposerDragState {
  readonly depth: number;
  readonly overlayVariant: FileTransferDragOverlayVariant | null;
}

const IDLE_COMPOSER_DRAG_STATE: ComposerDragState = {
  depth: 0,
  overlayVariant: null,
};

/**
 * Whether a composer surface should hold submission open while either ingest
 * pipeline can still land content.
 */
export function isAttachmentIngestPending(
  paste: Pick<
    UseComposerPasteResult,
    "isIngestingImages" | "isResolvingFilePaths"
  >,
): boolean {
  return paste.isIngestingImages || paste.isResolvingFilePaths;
}

/** Commits resolved paths at the position captured when the paste began. */
export type PathInsertionCommit = (paths: ReadonlyArray<string>) => boolean;

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
   * Starts a path-insertion job anchored to the caret now (called
   * synchronously from `onPaste`/`onDrop`, before any async resolution
   * begins), returning a one-shot commit to call once paths are ready - or
   * `null` if the editor isn't ready to start one at all. See
   * `ComposerPromptEditorHandle.beginPathInsertion` for the full contract.
   */
  readonly beginPathInsertion: () => PathInsertionCommit | null;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith(IMAGE_MIME_PREFIX);
}

function isNonImageFile(file: File): boolean {
  return !isImageFile(file);
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
  const [fileResults, urlResults] = await Promise.all([
    Promise.all(files.map((file) => resolveFileToPath(file, fileDrops))),
    Promise.all(
      fileUrlPaths.map((urlPath) => resolveUrlPathToPath(urlPath, fileDrops)),
    ),
  ]);
  const results = [...fileResults, ...urlResults];
  const resolvedPaths = results.flatMap((result) =>
    result.path === null ? [] : [result.path],
  );
  const failedNames = results
    .filter((result) => result.path === null)
    .map((result) => result.name);
  return { resolvedPaths, failedNames };
}

async function resolveAndInsertFilePaths(
  files: ReadonlyArray<File>,
  fileUrlPaths: ReadonlyArray<string>,
  filePaths: ComposerFilePathIngestArgs,
  commit: PathInsertionCommit,
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
  if (!commit(displayPaths)) return;
  showFilePathResolutionToast(resolvedPaths.length, failedNames);
}

async function resolveAndInsertNativeClipboardFilePaths(
  filePaths: ComposerFilePathIngestArgs,
  commit: PathInsertionCommit,
): Promise<void> {
  const resolvedPaths = await Promise.resolve()
    .then(() =>
      withResolutionTimeout(
        filePaths.fileDrops.readNativeClipboardFilePaths(),
        FILE_PATH_RESOLUTION_TIMEOUT_MS,
        () => [] as readonly string[],
      ),
    )
    .catch(() => [] as readonly string[]);
  const displayPaths = resolvedPaths.map((path) =>
    displayPathForInsertion(path, filePaths.mentionRoots),
  );
  commit(displayPaths);
}

/**
 * Drag/drop/paste plumbing shared by every composer surface. The image ingest
 * (base64 vs hash-only) is delegated to `imageIngest`/`insertAttrs`; image
 * filtering + the 5MB cap belong to the ingest via `collectImages`. Surfaces
 * wrap this with their own ingest: `useComposerPasteAdapter` (base64) for
 * chat / new-conversation, `useLandingComposerPaste` (hash-only) for landing.
 * Non-image file/URL entries resolve through `filePaths`, while images keep
 * their existing independent ingest behavior.
 */
export function useComposerPasteEvents<Attrs>(
  imageIngest: ComposerImageIngest<Attrs>,
  insertAttrs: (attrs: ReadonlyArray<Attrs>) => number,
  filePaths: ComposerFilePathIngestArgs,
  captureImageInsertion: ComposerImageInsertionFactory<Attrs> | undefined,
): UseComposerPasteResult {
  const [dragState, setDragState] = useState<ComposerDragState>(
    IDLE_COMPOSER_DRAG_STATE,
  );
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
      const insertion =
        captureImageInsertion?.() ??
        ({
          insert: insertAttrs,
          release: () => undefined,
        } satisfies ComposerImageInsertion<Attrs>);
      trackPendingImageJob((signal) =>
        runImageIngest(files, signal, imageIngest, insertion),
      );
    },
    [captureImageInsertion, imageIngest, insertAttrs, trackPendingImageJob],
  );

  const attachFilePaths = useCallback(
    (files: ReadonlyArray<File>, fileUrlPaths: ReadonlyArray<string>) => {
      if (files.length === 0 && fileUrlPaths.length === 0) return;
      const commit = filePaths.beginPathInsertion();
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

  const attachNativeClipboardFilePaths = useCallback(() => {
    const commit = filePaths.beginPathInsertion();
    if (commit === null) return;
    setPendingPathCount((count) => count + 1);
    void resolveAndInsertNativeClipboardFilePaths(filePaths, commit).finally(
      () => {
        if (!activeRef.current) return;
        setPendingPathCount((count) => Math.max(0, count - 1));
      },
    );
  }, [filePaths]);

  const dispatchFileTransfer = useCallback(
    (files: ReadonlyArray<File>, fileUrlPaths: ReadonlyArray<string>) => {
      const imageFiles = files.filter(isImageFile);
      const nonImageFiles = files.filter(isNonImageFile);
      if (imageFiles.length > 0) attachImageFiles(imageFiles);
      attachFilePaths(nonImageFiles, fileUrlPaths);
    },
    [attachFilePaths, attachImageFiles],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (hasClaimableFileTransfer(event.clipboardData)) {
        event.preventDefault();
        const { files, fileUrlPaths } = collectFileTransferEntries(
          event.clipboardData,
        );
        dispatchFileTransfer(files, fileUrlPaths);
        return;
      }
      if (dataTransferHasUsableClipboardData(event.clipboardData)) return;
      attachNativeClipboardFilePaths();
    },
    [attachNativeClipboardFilePaths, dispatchFileTransfer],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    const overlayVariant = classifyFileTransferDrag(event.dataTransfer);
    if (overlayVariant === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDragState((state) => {
      if (state.depth === 0 || state.overlayVariant === overlayVariant) {
        return state;
      }
      return { ...state, overlayVariant };
    });
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    const overlayVariant = classifyFileTransferDrag(event.dataTransfer);
    if (overlayVariant === null) return;
    event.preventDefault();
    event.stopPropagation();
    setDragState((state) => ({
      depth: state.depth + 1,
      overlayVariant,
    }));
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (classifyFileTransferDrag(event.dataTransfer) === null) return;
    event.preventDefault();
    event.stopPropagation();
    setDragState((state) => {
      const depth = Math.max(0, state.depth - 1);
      if (depth === state.depth) return state;
      return {
        depth,
        overlayVariant: depth === 0 ? null : state.overlayVariant,
      };
    });
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      // Drag-enter can only inspect the transfer's type names, so an ordinary
      // HTTPS URI is intentionally shown as potentially file-like until its
      // payload is readable here. A drop does not reliably emit dragleave,
      // therefore it must always clear the affordance before deciding whether
      // this hook owns the content.
      setDragState(IDLE_COMPOSER_DRAG_STATE);
      if (!hasClaimableFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const { files, fileUrlPaths } = collectFileTransferEntries(
        event.dataTransfer,
      );
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
    runPendingImageJob: trackPendingImageJob,
    isDraggingFiles: dragState.depth > 0,
    dragOverlayVariant: dragState.depth > 0 ? dragState.overlayVariant : null,
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
  // One session per mount: each `attachImageFiles` call is its own background
  // job and they do not await one another, so the session is what keeps two
  // pastes into the same composer from decoding at the same time.
  const preparationSession = useMemo(
    () => createComposerImagePreparationSession(),
    [],
  );
  const imageIngest = useMemo(
    (): ComposerImageIngest => ({
      convert: (files, signal) =>
        filesToImageAttrs(files, signal, preparationSession),
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
    [preparationSession],
  );
  return useComposerPasteEvents(imageIngest, insertAttrs, filePaths, undefined);
}

function hostStorableImage(file: File): boolean {
  return isHostStorableImageMimeType(file.type);
}

/**
 * The hash-only ingest for the CHAT surfaces: chat composer, new-conversation
 * modal and the inline message editor.
 *
 * `landingImageAttrsFromFiles`' job minus the landing-draft budget accounting -
 * capacity is still reserved against the shared partition cap (these bytes land
 * in the same store), but with no `draftId`, since these surfaces have no
 * landing draft to name in the budget toast.
 *
 * Order is preserved across the mixed case: a paste of [PNG, BMP] yields a
 * hash-only attr and an inline attr at their original positions, because every
 * accepted file maps to exactly one attr.
 *
 * A budget refusal drops only the files that needed storing. The inline ones
 * never wanted capacity - they are not going into the store - so failing them
 * for a sibling's rejection would be a refusal with no cause.
 */
async function hashImageAttrsFromFiles(
  files: ReadonlyArray<File>,
  signal: AbortSignal,
  session: ImagePreparationSession,
): Promise<ComposerImageConversionResult> {
  const trackRejected = (): void => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "chat",
      blocker: "invalid_input",
    });
  };
  const accepted = collectImages(files, trackRejected);
  if (accepted.length === 0) return { attrs: [] };
  const storable = accepted.filter(hostStorableImage);
  // Reserved BEFORE any bytes are written, against this partition's live roots
  // plus every other outstanding reservation, exactly as landing does. The hash
  // is unknown until `putImage` hashes the bytes, so each candidate reserves
  // anonymously.
  //
  // The charge is the SOURCE size capped at the per-image ceiling, because the
  // bytes this path can actually store are bounded by that ceiling and not by
  // the file: preparation runs below and every arm that reaches `putImage` -
  // the re-encode and the fallback alike - has already refused anything over
  // `PREPARED_IMAGE_MAX_BYTES`. Uncapped, a 30 MB photo reserved 30 MB of a
  // 64 MiB budget to store at most 3.75 MiB, and two of them refused the batch
  // outright as `rate_limit`. That was a live over-charge rather than a
  // conservative one: `MAX_IMAGE_SOURCE_BYTES` admits files far above the
  // ceiling, so source size stopped being an upper bound on what lands.
  //
  // This is the one reservation site that charges a source size at all - the
  // other three (`use-landing-composer-paste`, and both in
  // `use-composer-pending-image-ingest`) charge a prepared `byteLength`,
  // because they prepare before reserving. The order is kept here on purpose:
  // preparation is the expensive part, and reserving first is what stops N
  // concurrent batches from all decoding before any of them learns there is no
  // room. `settleStored` below replaces this estimate with the real charge the
  // moment the hash exists.
  const reservation =
    storable.length === 0
      ? null
      : reserveLandingImageBudget(
          null,
          storable.map((file) => ({
            hash: null,
            bytes: Math.min(
              file.size > 0 ? file.size : 0,
              LANDING_IMAGE_MAX_BYTES_PER_IMAGE,
            ),
          })),
        );
  if (storable.length > 0 && reservation === null) {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "chat",
      blocker: "rate_limit",
    });
    scheduleLandingImageReconcile();
  }
  // Which reservation slot each storable file took. The batch maps over
  // `accepted` while the reservation was built from `storable`, so the two
  // index spaces differ - and settling the wrong slot is worse than not
  // settling at all: it moves a large slot's charge onto a small item's hash.
  const reservationSlotByFile = new Map(
    storable.map((file, index) => [file, index] as const),
  );
  // One holder per BATCH: every hash this conversion produces is released
  // together, once the insertion decision has been made for all of them.
  const holderId = mintPendingIngestHolderId("composer-hash-ingest");

  const settled = await Promise.allSettled(
    accepted.map(async (file): Promise<ImageAttachmentAttrs | null> => {
      signal.throwIfAborted();
      if (hostStorableImage(file)) {
        // The null check IS the admission check - `reservation` is null exactly
        // when the budget refused this batch - and writing it this way narrows
        // the handle for the settlement below.
        if (reservation === null) return null;
        // PREPARED before the store, so the hash addresses bytes that already
        // satisfy the output policy. Preparation runs on this mount's session,
        // so the decodes across this batch queue even though the reads and
        // writes around them stay parallel.
        //
        // The read inside it is bounded AND abort-responsive, as is the store
        // wait below. `throwIfAborted` after the fact is not enough: it only
        // runs once the promise settles, so a stall held the send gate open
        // forever and no cancellation could settle it.
        const prepared = await prepareComposerImageFile(
          session,
          file,
          signal,
          trackRejected,
        );
        // Refused outright: it cannot be made to fit, and the toast has
        // already named it. Its reservation slot is left unsettled and the
        // batch handle releases it with the rest.
        if (prepared === null) return null;
        const bytes = prepared.bytes;
        // Checked BEFORE `putImage` is called, not after it settles. The
        // argument to `withAbortableDeadline` is evaluated eagerly, so a
        // cancellation landing in the gap between the read finishing and this
        // line would otherwise still start a store write - work for a batch
        // that is already abandoned, landing bytes nothing will reference.
        signal.throwIfAborted();
        // Hoisted so the WRITE can be observed independently of the WAIT. The
        // deadline below ends this batch's wait; it cannot cancel an IndexedDB
        // write already issued, so a stalled `putImage` that later succeeds
        // seeds the session cache and the store with bytes no node references.
        // The timeout path schedules a reconcile, but that sweep can run
        // BEFORE the late write lands - and nothing scheduled another, so the
        // orphan sat there until an unrelated reconcile happened by.
        //
        // Scheduling on every landing rather than only the late ones: the
        // sweep is debounced and root-aware, so an on-time write (already
        // rooted by `holdPendingIngestImageHash` by the time it runs) costs a
        // coalesced no-op, and a rejection is nothing to reconcile.
        const storing = putImage(bytes);
        void storing.then(
          () => {
            scheduleLandingImageReconcile();
          },
          () => undefined,
        );
        const hash = await withAbortableDeadline(
          storing,
          IMAGE_READ_TIMEOUT_MS,
          signal,
          () => `Storing ${file.name || "image"} timed out`,
        );
        // Rooted the INSTANT the hash exists, and held until the insertion
        // decision. A slow sibling can otherwise keep this batch waiting long
        // enough for two GC sweeps to release the session entry and then delete
        // the persisted bytes - after which the batch inserts a hash whose
        // bytes are gone.
        holdPendingIngestImageHash(holderId, hash);
        // And the charge moves with it. These bytes are in the partition and
        // rooted by the hold above, so the root sum charges them from here;
        // leaving the anonymous slot standing counted them twice for as long
        // as the slowest sibling in this batch took, which refused pastes that
        // fit.
        const reservationSlot = reservationSlotByFile.get(file) ?? null;
        if (reservationSlot !== null) {
          reservation.settleStored(reservationSlot, hash);
        }
        return {
          id: uuidv4(),
          fileName: prepared.fileName,
          hash,
          mimeType: prepared.mimeType,
          size: prepared.byteLength > 0 ? prepared.byteLength : null,
          byHashEligible: prepared.byHashEligible,
        };
      }
      // The format fallback: today's inline conversion, for this file only.
      // Still PREPARED - the ceiling is about the bytes that travel, not about
      // which channel they travel on - but it stays inline, and preparation's
      // own verdict on eligibility is what says so.
      const preparedInline = await prepareComposerImageFile(
        session,
        file,
        signal,
        trackRejected,
      );
      if (preparedInline === null) return null;
      return {
        id: uuidv4(),
        fileName: preparedInline.fileName,
        b64content: bytesToBase64(preparedInline.bytes),
        mimeType: preparedInline.mimeType,
        size: preparedInline.byteLength > 0 ? preparedInline.byteLength : null,
        byHashEligible: preparedInline.byHashEligible,
      };
    }),
  );

  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected !== undefined) {
    // Every started read/write has settled by now - `allSettled`, not `all` -
    // so releasing here cannot strand a slower sibling `putImage` landing bytes
    // nothing will ever reference. The hash hold goes too: nothing is being
    // inserted, so those bytes are exactly what the sweep should reclaim.
    reservation?.release();
    releasePendingIngestImageHashes(holderId);
    scheduleLandingImageReconcile();
    throw rejected.reason;
  }

  const attrs: ImageAttachmentAttrs[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value !== null) {
      attrs.push(result.value);
    }
  }
  // `release` runs only AFTER `runImageIngest` has decided the attrs' fate, so
  // the hash hold spans the whole conversion-to-insertion handoff and hands
  // custody to the document's own root with no gap.
  return {
    attrs,
    release: () => {
      reservation?.release();
      releasePendingIngestImageHashes(holderId);
    },
  };
}

/**
 * Hash-only paste adapter for the three chat surfaces. A sibling of
 * {@link useComposerPasteAdapter}, which stays exactly as it is - other callers
 * depend on its inline behaviour and its own comment forbids changing it.
 */
export function useComposerHashPasteAdapter(
  insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number,
  filePaths: ComposerFilePathIngestArgs,
): UseComposerPasteResult {
  // One session per mount, for the reason the base64 adapter has one.
  const preparationSession = useMemo(
    () => createComposerImagePreparationSession(),
    [],
  );
  const imageIngest = useMemo(
    (): ComposerImageIngest => ({
      // No `disabled` gate, unlike `useLandingComposerPaste`: none of the three
      // chat surfaces suppresses ingest today, and adding a parameter that is
      // `false` at every call site would be a seam with nothing behind it. Add
      // one when a surface actually needs to refuse a mid-submit paste.
      convert: (files, signal) =>
        hashImageAttrsFromFiles(files, signal, preparationSession),
      onSettled: (accepted) => {
        if (accepted.length === 0) {
          // Converted but not inserted (the editor went away): any stored bytes
          // have no live node, so let the ordinary sweep reclaim them.
          scheduleLandingImageReconcile();
          return;
        }
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
        if (!aborted) {
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
        }
        // A failed or aborted conversion can leave stored bytes with no node.
        scheduleLandingImageReconcile();
      },
    }),
    [preparationSession],
  );
  return useComposerPasteEvents(imageIngest, insertAttrs, filePaths, undefined);
}

export interface ComposerPasteEditorHandle {
  readonly isReady: () => boolean;
  readonly insertImageAttachments: (
    attrs: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  readonly beginPathInsertion: () => PathInsertionCommit | null;
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
  const beginPathInsertion = useCallback((): PathInsertionCommit | null => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return null;
    return handle.beginPathInsertion();
  }, [editorRef]);
  const filePaths = useMemo(
    () => ({ fileDrops, mentionRoots, beginPathInsertion }),
    [fileDrops, mentionRoots, beginPathInsertion],
  );
  return useComposerPasteAdapter(insertAttrs, filePaths);
}

/**
 * {@link useComposerPaste}'s hash-only twin, for the three chat surfaces. Same
 * editor handle, same file-path ingest, same events - only the image channel
 * differs, which is the whole point of the `ComposerImageIngest` seam.
 */
export function useComposerHashPaste(
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
  const beginPathInsertion = useCallback((): PathInsertionCommit | null => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return null;
    return handle.beginPathInsertion();
  }, [editorRef]);
  const filePaths = useMemo(
    () => ({ fileDrops, mentionRoots, beginPathInsertion }),
    [fileDrops, mentionRoots, beginPathInsertion],
  );
  return useComposerHashPasteAdapter(insertAttrs, filePaths);
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

export interface InsertPathSpansCommandInput {
  readonly paths: ReadonlyArray<string>;
  readonly position: number;
}

/**
 * Inserts resolved paths in one history group at a mapped caret position.
 * Each path is its own inline-code span, separated by plain spaces, followed
 * by a plain trailing space so continued typing resumes outside the code mark.
 */
export function insertPathSpansCommand(
  editor: Editor,
  input: InsertPathSpansCommandInput,
): void {
  const { paths, position } = input;
  if (paths.length === 0) return;
  let chain = editor
    .chain()
    .command(({ tr }) => {
      closeHistory(tr);
      return true;
    })
    .setTextSelection(position);
  chain = chain.insertContent(pathSpansContent(paths)).unsetMark("code");
  chain.run();
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
