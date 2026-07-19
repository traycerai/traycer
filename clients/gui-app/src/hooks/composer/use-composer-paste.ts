import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import { v4 as uuidv4 } from "uuid";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

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

export interface UseComposerPasteResult {
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  attachImageFiles: (files: ReadonlyArray<File>) => void;
  isDraggingFiles: boolean;
  isIngestingImages: boolean;
}

function dataTransferHasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Drag/drop/paste plumbing shared by every composer surface. The ingest itself
 * (base64 vs hash-only) is delegated to `onFiles`, which receives the raw file
 * list (image filtering + the 5MB cap belong to the ingest via `collectImages`).
 * Surfaces wrap this with their own ingest: `useComposerPasteAdapter` (base64)
 * for chat / new-conversation, `useLandingComposerPaste` (hash-only) for landing.
 */
export function useComposerPasteEvents(
  onFiles: (files: ReadonlyArray<File>, signal: AbortSignal) => Promise<void>,
): UseComposerPasteResult {
  const [dragDepth, setDragDepth] = useState(0);
  const [pendingImageCount, setPendingImageCount] = useState(0);
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

  const attachImageFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      setPendingImageCount((count) => count + 1);
      void onFiles(files, controller.signal).finally(() => {
        controllersRef.current.delete(controller);
        if (!activeRef.current) return;
        setPendingImageCount((count) => Math.max(0, count - 1));
      });
    },
    [onFiles],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const items = event.clipboardData.items;
      if (items.length === 0) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length === 0) return;
      event.preventDefault();
      attachImageFiles(files);
    },
    [attachImageFiles],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!dataTransferHasFiles(event)) return;
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
      if (!dataTransferHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragDepth(0);
      attachImageFiles(Array.from(event.dataTransfer.files));
    },
    [attachImageFiles],
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
  };
}

/**
 * Base64 paste adapter for chat / new-conversation: accepted files are read as
 * base64 (`filesToImageAttrs`) and inserted as inline `b64content` nodes. This
 * is the behavior every non-landing surface relies on — do NOT change it.
 */
export function useComposerPasteAdapter(
  insertAttrs: (attrs: ReadonlyArray<ImageAttachmentAttrs>) => number,
): UseComposerPasteResult {
  const onFiles = useCallback(
    (files: ReadonlyArray<File>, signal: AbortSignal) =>
      filesToImageAttrs(files, signal)
        .then((attrs) => {
          if (attrs.length > 0) {
            const acceptedCount = Math.min(
              attrs.length,
              Math.max(0, insertAttrs(attrs)),
            );
            attrs.slice(0, acceptedCount).forEach(() => {
              Analytics.getInstance().track(AnalyticsEvent.AttachmentAdded, {
                kind: "image",
                surface: "chat",
              });
            });
          }
        })
        .catch((error: unknown) => {
          Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
            kind: "image",
            surface: "chat",
            blocker: analyticsBlockerFromError(error),
          });
          if (signal.aborted) return;
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
        }),
    [insertAttrs],
  );
  return useComposerPasteEvents(onFiles);
}

export interface ComposerPasteEditorHandle {
  readonly isReady: () => boolean;
  readonly insertImageAttachments: (
    attrs: ReadonlyArray<ImageAttachmentAttrs>,
  ) => void;
  readonly focus: () => void;
}

export function useComposerPaste(editorRef: {
  readonly current: ComposerPasteEditorHandle | null;
}): UseComposerPasteResult {
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
  return useComposerPasteAdapter(insertAttrs);
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
