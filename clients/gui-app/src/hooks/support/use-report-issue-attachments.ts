import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  MAX_REPORT_LOG_ATTACHMENTS,
  REPORT_IMAGE_READ_TIMEOUT_MS,
  reportImageMediaTypeForMimeType,
  reportImagesExceedBudget,
} from "@traycer-clients/shared/support/image-attachment-guards";

/**
 * Same ingest rules as composer paste (image/*, 5 MiB, 15s) but a flat list of up to 3 `ArrayBuffer`s. Every rejection is attach-time, never a silent drop at submit.
 */

export interface ReportIssueAttachmentImage {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: ArrayBuffer;
  readonly size: number;
  readonly previewUrl: string;
}

export type ReportIssueAttachmentRejectionReason =
  | "count"
  | "type"
  | "size"
  | "budget"
  | "corrupt"
  | "read_failed";

export interface ReportIssueAttachmentRejection {
  readonly reason: ReportIssueAttachmentRejectionReason;
  readonly message: string;
}

export interface UseReportIssueAttachmentsResult {
  readonly images: ReadonlyArray<ReportIssueAttachmentImage>;
  readonly isIngesting: boolean;
  readonly rejection: ReportIssueAttachmentRejection | null;
  readonly canAddMore: boolean;
  readonly addFiles: (files: ReadonlyArray<File>) => void;
  readonly removeImage: (id: string) => void;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Failed"));
      },
    );
  });
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return withTimeout(
    file.arrayBuffer(),
    REPORT_IMAGE_READ_TIMEOUT_MS,
    "Timed out while reading image",
  );
}

/**
 * Decode with `createImageBitmap` so a truncated file with a valid header cannot attach. Close the bitmap immediately; the thumbnail uses the `File`.
 */
async function assertImageDecodes(file: File): Promise<void> {
  const bitmap = await withTimeout(
    createImageBitmap(file),
    REPORT_IMAGE_READ_TIMEOUT_MS,
    "Timed out while validating image",
  );
  bitmap.close();
}

function rejectionFor(
  reason: ReportIssueAttachmentRejectionReason,
  fileName: string,
): ReportIssueAttachmentRejection {
  switch (reason) {
    case "count":
      return {
        reason,
        message: `You can attach up to ${MAX_REPORT_IMAGES} screenshots.`,
      };
    case "type":
      return {
        reason,
        message: "Only PNG, JPEG, GIF, or WebP images can be attached.",
      };
    case "size":
      return {
        reason,
        message: `${fileName || "That image"} is over the 5 MB limit.`,
      };
    case "budget":
      return {
        reason,
        message:
          "Adding that screenshot would put the report over the size limit.",
      };
    case "corrupt":
      return {
        reason,
        message: `${fileName || "That image"} appears to be corrupted and can't be attached.`,
      };
    case "read_failed":
      return {
        reason,
        message: `Couldn't read ${fileName || "that image"}. Try again.`,
      };
  }
}

function totalImageBytes(
  images: ReadonlyArray<ReportIssueAttachmentImage>,
): number {
  return images.reduce((sum, image) => sum + image.size, 0);
}

interface IngestFileContext {
  readonly imagesRef: {
    readonly current: ReadonlyArray<ReportIssueAttachmentImage>;
  };
  readonly isActive: () => boolean;
  readonly commitImage: (image: ReportIssueAttachmentImage) => void;
  readonly setRejection: (rejection: ReportIssueAttachmentRejection) => void;
}

/** Returns `true` when the 3-image cap was hit (pre- or post-decode/read) and the calling batch should stop trying further files; `false` for every other outcome (committed, or skipped with its own per-file rejection), where the batch should still try the next candidate. */
async function ingestOneFile(
  file: File,
  ctx: IngestFileContext,
): Promise<boolean> {
  if (!ctx.isActive()) return true;
  if (ctx.imagesRef.current.length >= MAX_REPORT_IMAGES) {
    ctx.setRejection(rejectionFor("count", ""));
    return true;
  }
  const mediaType = reportImageMediaTypeForMimeType(file.type);
  if (mediaType === null) {
    ctx.setRejection(rejectionFor("type", file.name));
    return false;
  }
  if (file.size === 0 || file.size > MAX_REPORT_IMAGE_BYTES) {
    ctx.setRejection(rejectionFor("size", file.name));
    return false;
  }
  if (
    reportImagesExceedBudget(
      totalImageBytes(ctx.imagesRef.current) + file.size,
      MAX_REPORT_LOG_ATTACHMENTS,
    )
  ) {
    ctx.setRejection(rejectionFor("budget", file.name));
    return false;
  }
  try {
    await assertImageDecodes(file);
  } catch {
    ctx.setRejection(rejectionFor("corrupt", file.name));
    return false;
  }
  if (!ctx.isActive()) return true;
  let bytes: ArrayBuffer;
  try {
    bytes = await readFileAsArrayBuffer(file);
  } catch {
    ctx.setRejection(rejectionFor("read_failed", file.name));
    return false;
  }
  if (!ctx.isActive()) return true;
  // Re-check count synchronously immediately before commit, with no await between. Two loops can both pass the pre-await check, then race to commit.
  if (ctx.imagesRef.current.length >= MAX_REPORT_IMAGES) {
    ctx.setRejection(rejectionFor("count", ""));
    return true;
  }
  if (
    reportImagesExceedBudget(
      totalImageBytes(ctx.imagesRef.current) + bytes.byteLength,
      MAX_REPORT_LOG_ATTACHMENTS,
    )
  ) {
    ctx.setRejection(rejectionFor("budget", file.name));
    return false;
  }
  ctx.commitImage({
    id: crypto.randomUUID(),
    fileName: file.name || "screenshot.png",
    mimeType: mediaType,
    bytes,
    size: bytes.byteLength,
    previewUrl: URL.createObjectURL(file),
  });
  return false;
}

export function useReportIssueAttachments(): UseReportIssueAttachmentsResult {
  const [images, setImages] = useState<
    ReadonlyArray<ReportIssueAttachmentImage>
  >([]);
  const [isIngesting, setIsIngesting] = useState(false);
  const [rejection, setRejection] =
    useState<ReportIssueAttachmentRejection | null>(null);
  // Ingest runs one file at a time inside an async loop; a `setImages` call is not synchronously readable within that loop, so the count/budget checks for file N+1 read from this ref (kept in lockstep with `images` via `commitImage`/`removeImage` below) rather than a stale closure.
  const imagesRef = useRef<ReadonlyArray<ReportIssueAttachmentImage>>(images);
  const activeRef = useRef(true);
  // A second concurrent `addFiles` call (paste landing mid-drop, or two drops in quick succession) spawns its own `ingest()` loop with its own try/finally - a plain boolean `isIngesting` set independently by each loop would flip back to `false` the instant the FIRST loop to finish returns, even while a second loop is still mid-read and about to commit an image the dialog's submit snapshot would then silently miss.
  const pendingIngestCountRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      for (const image of imagesRef.current) {
        URL.revokeObjectURL(image.previewUrl);
      }
    };
  }, []);

  const commitImage = useCallback((image: ReportIssueAttachmentImage) => {
    imagesRef.current = [...imagesRef.current, image];
    setImages(imagesRef.current);
  }, []);

  const addFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      const candidates = files.filter((file) => file.type.startsWith("image/"));
      if (candidates.length === 0) {
        if (files.length > 0) {
          setRejection(rejectionFor("type", files[0]?.name ?? ""));
        }
        return;
      }
      setRejection(null);

      // Read through a function call rather than `activeRef.current` directly at each checkpoint below: `activeRef.current` can be mutated by the unmount cleanup effect while an `await` in this loop is in flight, but TypeScript's control-flow narrowing does not model that concurrent mutation - narrowing the property directly would make the compiler (wrongly) treat a later check as always the same value as an earlier one, which is exactly the unmount race this guards against.
      const isActive = (): boolean => activeRef.current;

      const ctx: IngestFileContext = {
        imagesRef,
        isActive,
        commitImage,
        setRejection,
      };

      async function ingest(): Promise<void> {
        pendingIngestCountRef.current += 1;
        setIsIngesting(true);
        try {
          for (const file of candidates) {
            const shouldStopBatch = await ingestOneFile(file, ctx);
            if (shouldStopBatch) return;
          }
        } finally {
          pendingIngestCountRef.current -= 1;
          if (isActive() && pendingIngestCountRef.current === 0) {
            setIsIngesting(false);
          }
        }
      }

      void ingest();
    },
    [commitImage],
  );

  const removeImage = useCallback((id: string) => {
    const target = imagesRef.current.find((image) => image.id === id);
    if (target !== undefined) URL.revokeObjectURL(target.previewUrl);
    imagesRef.current = imagesRef.current.filter((image) => image.id !== id);
    setImages(imagesRef.current);
    setRejection(null);
  }, []);

  return {
    images,
    isIngesting,
    rejection,
    canAddMore: images.length < MAX_REPORT_IMAGES,
    addFiles,
    removeImage,
  };
}
