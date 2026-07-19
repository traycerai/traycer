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
} from "@/lib/files/file-transfer-paths";
import {
  getBasename,
  relativizeToWorkspaceRoot,
} from "@/lib/path/cross-platform-path";

export const IMAGE_MIME_PREFIX = "image/";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_READ_TIMEOUT_MS = 15_000;

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
   * Starts a path-insertion job anchored to the caret *now* (called
   * synchronously from `onPaste`/`onDrop`, before path resolution begins),
   * returning a one-shot commit to call once paths resolve - or `null` if
   * the editor isn't ready to start one at all. See
   * `ComposerPromptEditorHandle.beginPathInsertion` for the full contract.
   */
  readonly beginPathInsertion: () =>
    ((paths: ReadonlyArray<string>) => boolean) | null;
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
    const resolved = await fileDrops.resolveDroppedFilePaths([file]);
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
    const resolved = await fileDrops.copyDroppedFilePaths([urlPath]);
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
  const results = await Promise.all([
    ...files.map((file) => resolveFileToPath(file, fileDrops)),
    ...fileUrlPaths.map((urlPath) => resolveUrlPathToPath(urlPath, fileDrops)),
  ]);
  // Not deduped: `files` and `fileUrlPaths` are mutually exclusive inputs
  // (see the `files.length === 0 ? ...` gates in `useComposerPasteEvents`),
  // so this never sees the same source resolved through two clipboard
  // flavors - and decision 18 ("every resolved path inserts, no count cap")
  // means two genuinely distinct pasted items that happen to resolve to the
  // same path both still insert.
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
  commit: (paths: ReadonlyArray<string>) => boolean,
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

/**
 * Coordinates a MIXED paste (image files alongside non-image files/paths in
 * the same clipboard/drop) as one grouped edit: both conversions run
 * concurrently, but neither inserts until BOTH have settled, and the two
 * resulting transactions (images, then paths) dispatch back-to-back in the
 * same tick. Dispatching independently - each inserting as soon as its own
 * async work finished - risks landing far enough apart in time that
 * ProseMirror's history plugin (`newGroupDelay`, 500ms by default) starts a
 * new undo group for the second one, so a single Undo only reverts part of
 * the paste.
 */
interface MixedIngestInput {
  readonly files: ReadonlyArray<File>;
  readonly nonImageFiles: ReadonlyArray<File>;
  readonly fileUrlPaths: ReadonlyArray<string>;
  readonly signal: AbortSignal;
}

interface MixedIngestContext {
  readonly imageIngest: ComposerImageIngest;
  readonly insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number;
  readonly filePaths: ComposerFilePathIngestArgs;
  readonly commit: (paths: ReadonlyArray<string>) => boolean;
}

async function runMixedIngest(
  input: MixedIngestInput,
  ctx: MixedIngestContext,
): Promise<void> {
  const { files, nonImageFiles, fileUrlPaths, signal } = input;
  const { imageIngest, insertAttrs, filePaths, commit } = ctx;
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
    resolveFilePaths(nonImageFiles, fileUrlPaths, filePaths.fileDrops),
  ]);

  // Images first, then paths - back-to-back, synchronously, no `await`
  // between them, so ProseMirror dispatches both transactions in the same
  // tick regardless of which of the two async jobs above took longer.
  let accepted: ReadonlyArray<ImageAttachmentAttrs> = [];
  let converted: ReadonlyArray<ImageAttachmentAttrs> = [];
  if (imageResult.ok) {
    converted = imageResult.converted;
    if (converted.length > 0) {
      const acceptedCount = Math.min(
        converted.length,
        Math.max(0, insertAttrs(converted)),
      );
      accepted = converted.slice(0, acceptedCount);
    }
  }
  const displayPaths = pathResult.resolvedPaths.map((path) =>
    displayPathForInsertion(path, filePaths.mentionRoots),
  );
  const live = commit(displayPaths);

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
      // resolution below starts - see `beginPathInsertion`'s contract.
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

  const attachMixed = useCallback(
    (
      files: ReadonlyArray<File>,
      nonImageFiles: ReadonlyArray<File>,
      fileUrlPaths: ReadonlyArray<string>,
    ) => {
      const commit = filePaths.beginPathInsertion();
      if (commit === null) {
        // No live editor to anchor the path job to at all - fall back to the
        // independent image path rather than dropping the images too.
        attachImageFiles(files);
        return;
      }
      trackPendingImageJob((signal) =>
        runMixedIngest(
          { files, nonImageFiles, fileUrlPaths, signal },
          { imageIngest, insertAttrs, filePaths, commit },
        ),
      );
    },
    [
      attachImageFiles,
      filePaths,
      imageIngest,
      insertAttrs,
      trackPendingImageJob,
    ],
  );

  const dispatchFileTransfer = useCallback(
    (files: ReadonlyArray<File>, fileUrlPaths: ReadonlyArray<string>) => {
      const hasImageFiles = files.some((file) => !isNonImageFile(file));
      const nonImageFiles = files.filter(isNonImageFile);
      const hasPaths = nonImageFiles.length > 0 || fileUrlPaths.length > 0;
      if (hasImageFiles && hasPaths) {
        attachMixed(files, nonImageFiles, fileUrlPaths);
        return;
      }
      if (files.length > 0) attachImageFiles(files);
      attachFilePaths(nonImageFiles, fileUrlPaths);
    },
    [attachFilePaths, attachImageFiles, attachMixed],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!dataTransferHasFiles(event.clipboardData)) return;
      event.preventDefault();
      const files = collectDroppedFiles(event.clipboardData);
      const fileUrlPaths =
        files.length === 0
          ? collectDroppedFileUrlPaths(event.clipboardData)
          : [];
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
      if (!dataTransferHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragDepth(0);
      const files = collectDroppedFiles(event.dataTransfer);
      const fileUrlPaths =
        files.length === 0
          ? collectDroppedFileUrlPaths(event.dataTransfer)
          : [];
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
  readonly beginPathInsertion: () =>
    ((paths: ReadonlyArray<string>) => boolean) | null;
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
  const beginPathInsertion = useCallback(():
    ((paths: ReadonlyArray<string>) => boolean) | null => {
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

/**
 * Inserts each resolved path as its own inline-code span, space-separated on
 * one line, followed by a trailing PLAIN space so the caret lands past the
 * code mark - continued typing resumes as prose rather than extending the
 * last path. `unsetMark` clears the code mark from stored marks as a second,
 * explicit guarantee alongside the plain trailing character. `insertPos` is
 * an explicit document position (rather than "wherever the selection
 * currently is") because paths resolve asynchronously - by the time this
 * runs, the caret the user pasted at may have moved. Callers map a position
 * captured at paste/drop time forward through any intervening transactions
 * (see `ComposerPromptEditorHandle.beginPathInsertion`) before calling this.
 */
export function insertPathSpansCommand(
  editor: Editor,
  paths: ReadonlyArray<string>,
  insertPos: number,
): void {
  if (paths.length === 0) return;
  const content = paths.flatMap((path, index) => {
    const span = { type: "text", text: path, marks: [{ type: "code" }] };
    return index === 0 ? [span] : [{ type: "text", text: " " }, span];
  });
  content.push({ type: "text", text: " " });
  editor.chain().insertContentAt(insertPos, content).unsetMark("code").run();
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
