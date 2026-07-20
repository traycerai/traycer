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
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
 * per surface) without inserting them. `onSettled` receives the attrs
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
export function useComposerPasteEvents(
  imageIngest: ComposerImageIngest,
  insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number,
  filePaths: ComposerFilePathIngestArgs,
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
      trackPendingImageJob((signal) =>
        runImageIngest(files, signal, imageIngest, insertAttrs),
      );
    },
    [imageIngest, insertAttrs, trackPendingImageJob],
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
