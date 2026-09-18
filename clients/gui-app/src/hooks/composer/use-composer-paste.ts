/**
 * THE SHARED BASE every composer surface's paste/drop ingest is built on — not
 * an ingest of its own.
 *
 * What lives here is the part that is the same everywhere: the DOM event
 * plumbing (`useComposerPasteEvents`), the drag-state machine and its overlay
 * variants, the abortable job bookkeeping behind `isIngestingImages` /
 * `isResolvingFilePaths`, the `image/*` filter and source ceiling
 * (`collectImages`), preparation itself (`prepareComposerImageFile` /
 * `prepareComposerImageBytes`), and the non-image file/URL path resolution.
 *
 * What does NOT live here is the decision every surface makes differently:
 * what an accepted image BECOMES. Both surfaces that make that decision are
 * hash-first and neither is here:
 *
 * - `useComposerHashFirstPaste` — the chat composer, the edit composer and the
 *   new-conversation modal. Files are stored content-addressed before a node
 *   exists; inline base64 arriving in a paste becomes a pending node a
 *   background job flips to a hash in place.
 * - `useLandingComposerPaste` — the landing composer, same model with its own
 *   draft-scoped budget owner and mount-time re-entry.
 *
 * There used to be a third, `useComposerPasteAdapter` (and its `useComposerPaste`
 * convenience wrapper), which inserted inline `b64content` nodes for chat and
 * the new-conversation modal. Those surfaces went hash-first, it lost its last
 * caller, and it was deleted — its base64 node shape is the thing this change
 * set out to remove from drafts and `localStorage`. Do not reintroduce a base64
 * ingest here; the inline form now exists only at submit, in
 * `lib/composer/composer-image-inlining.ts`.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { PREPARED_IMAGE_SOURCE_CEILING } from "@/lib/composer/prompt-stash-image-preparation";
import {
  prepareComposerImageBytesOrRefuse,
  showImageTooLargeToast,
  type ImagePreparationSession,
  type PreparedComposerImage,
} from "@/lib/composer/composer-image-preparation";
import type { ImageBytes } from "@/lib/attachments/image-bytes";
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
 * The only size a paste refuses outright. The old 5 MiB refusal moved from the
 * source to the OUTPUT (`PREPARED_IMAGE_MAX_BYTES`): anything under this
 * ceiling is now resized and re-encoded to fit rather than turned away.
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
 * Reads a file's raw bytes under the same stall bound the FileReader path
 * carried: a host/OS read that never settles must not gate submit forever.
 * Raw bytes rather than a data URL because preparation works on bytes, and a
 * base64 round trip before it would be one more full copy of the image.
 */
function readFileBytes(file: File, signal: AbortSignal): Promise<ImageBytes> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      fail(new Error("Image read was cancelled"));
    };
    const timeout = window.setTimeout(() => {
      fail(new Error("Timed out while reading image"));
    }, IMAGE_READ_TIMEOUT_MS);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    file.arrayBuffer().then(
      (buffer) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new Uint8Array(buffer));
      },
      (error: unknown) => {
        fail(
          error instanceof Error ? error : new Error("Failed to read image"),
        );
      },
    );
  });
}

/**
 * `onOversized` lets each surface observe the source-ceiling rejection (which
 * is user-visible via the toast here) without the shared filter knowing
 * surface names; it receives no file details so nothing sensitive can leak
 * into it.
 *
 * The only size this refuses is the 50 MiB SOURCE ceiling, checked against
 * `File.size` so a 60 MB paste never reaches a decoder. Everything under it is
 * preparation's problem: resized to 2000 px and re-encoded under the output
 * ceiling, or refused there with the same copy.
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

/**
 * Reads and prepares ONE file under the universal policy, or returns `null`
 * after toasting when it cannot be made to fit.
 *
 * Aborts propagate: the read rejects and `runImageIngest`'s `onRejected` sees
 * `signal.aborted`, which is what suppresses the toast for a torn-down surface.
 */
export async function prepareComposerImageFile(
  session: ImagePreparationSession,
  file: File,
  signal: AbortSignal,
  onRefused: () => void,
): Promise<PreparedComposerImage | null> {
  const bytes = await readFileBytes(file, signal);
  signal.throwIfAborted();
  return prepareComposerImageBytes(
    session,
    bytes,
    file.name.length > 0 ? file.name : "image",
    file.type.length > 0 ? file.type : "image/png",
    onRefused,
  );
}

/**
 * `prepareComposerImageFile` without the read, for a surface that already
 * holds the bytes (a structured clipboard paste's inline base64). Same policy,
 * same fallback, and this is where the refusal becomes a toast.
 */
export async function prepareComposerImageBytes(
  session: ImagePreparationSession,
  bytes: ImageBytes,
  fileName: string,
  mimeType: string,
  onRefused: () => void,
): Promise<PreparedComposerImage | null> {
  const prepared = await prepareComposerImageBytesOrRefuse(
    session,
    bytes,
    fileName,
    mimeType,
  );
  if (prepared.kind === "prepared") return prepared.image;
  showImageTooLargeToast(fileName);
  onRefused();
  return null;
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
 * Drag/drop/paste plumbing shared by every composer surface. What an accepted
 * image BECOMES is delegated to `imageIngest`/`insertAttrs`; image filtering +
 * the source ceiling belong to the ingest via `collectImages`, and every ingest
 * prepares (≤ 2000 px, ≤ 3.75 MiB) before it builds. Both surfaces that wrap
 * this are hash-only — `useComposerHashFirstPaste` for the chat composer, the
 * edit composer and the new-conversation modal, `useLandingComposerPaste` for
 * landing — and they differ only in whose budget an image charges against and
 * how a pending node is re-entered. Non-image file/URL entries resolve through
 * `filePaths`, while images keep their existing independent ingest behavior.
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

export interface ComposerPasteEditorHandle {
  readonly isReady: () => boolean;
  readonly insertImageAttachments: (
    attrs: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  readonly beginPathInsertion: () => PathInsertionCommit | null;
  readonly focus: () => void;
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
