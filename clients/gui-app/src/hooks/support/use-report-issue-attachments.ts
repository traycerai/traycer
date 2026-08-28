import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  REPORT_IMAGE_READ_TIMEOUT_MS,
  reportImageMediaTypeForMimeType,
  reportImagesExceedBudget,
} from "@traycer-clients/shared/support/image-attachment-guards";

/**
 * Renderer-side ingest for the report-issue dialog's attachment target
 * (ticket 08 / tech-plan T5). Reuses the composer's ingest RULES (image/*
 * only, 5 MiB per image, 15s read timeout - see `use-composer-paste.ts`) but
 * not its hook: that hook inserts into a tiptap editor document, while this
 * one holds a flat list of up to 3 images for a thumbnail strip with
 * per-item remove, read as raw `ArrayBuffer` (never base64 - the bytes cross
 * IPC as a byte array).
 *
 * Every rejection here is a UI-visible, attach-time decision (count, type,
 * per-image size, running-total budget) - never a silent drop at submit
 * time (ticket 08 guardrail G5).
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
 * ADV-I4: the MIME allowlist and (main-side) magic-byte check only inspect a
 * file's header, so a truncated file with a valid header - a real screenshot
 * cut off mid-write, a partial drag payload - sails through both and reaches
 * triage as a corrupt attachment the user believed was sent whole. Actually
 * decoding the image is the only check that catches this; `createImageBitmap`
 * decodes every format the MIME allowlist admits and rejects on a truncated
 * or otherwise malformed body. The bitmap itself is never used for anything
 * but this decodability proof - the thumbnail strip renders straight from
 * the `File` via its own object URL - so it is closed immediately to free
 * the decoded pixels rather than held onto.
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

/**
 * Validates and ingests exactly one candidate file, in isolation from the
 * batch loop that calls it (kept as its own function so the loop itself -
 * `ingest()` below - stays under the repo's cyclomatic-complexity budget).
 * Returns `true` when the 3-image cap was hit (pre- or post-decode/read) and
 * the calling batch should stop trying further files; `false` for every
 * other outcome (committed, or skipped with its own per-file rejection),
 * where the batch should still try the next candidate.
 */
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
    reportImagesExceedBudget(totalImageBytes(ctx.imagesRef.current) + file.size)
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
  // Re-checked synchronously here, immediately before the commit below with
  // no `await` in between: a concurrent `addFiles` batch (paste landing
  // mid-drop) can only have advanced past its own await and mutated
  // `imagesRef.current` on some EARLIER microtask turn, never during this
  // synchronous stretch, so this recheck-then-commit pair is atomic with
  // respect to every other ingest loop. Closes the TOCTOU window the
  // pre-await checks above leave open: two loops can both pass the
  // pre-await count check against the same prior count, then both resolve
  // their reads and race to commit - only the recheck here, not the
  // pre-await one, can see the OTHER loop's commit and back off.
  if (ctx.imagesRef.current.length >= MAX_REPORT_IMAGES) {
    ctx.setRejection(rejectionFor("count", ""));
    return true;
  }
  if (
    reportImagesExceedBudget(
      totalImageBytes(ctx.imagesRef.current) + bytes.byteLength,
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
  // Ingest runs one file at a time inside an async loop; a `setImages` call
  // is not synchronously readable within that loop, so the count/budget
  // checks for file N+1 read from this ref (kept in lockstep with `images`
  // via `commitImage`/`removeImage` below) rather than a stale closure.
  const imagesRef = useRef<ReadonlyArray<ReportIssueAttachmentImage>>(images);
  const activeRef = useRef(true);
  // A second concurrent `addFiles` call (paste landing mid-drop, or two
  // drops in quick succession) spawns its own `ingest()` loop with its own
  // try/finally - a plain boolean `isIngesting` set independently by each
  // loop would flip back to `false` the instant the FIRST loop to finish
  // returns, even while a second loop is still mid-read and about to commit
  // an image the dialog's submit snapshot would then silently miss. Count
  // concurrently-active loops instead: `isIngesting` is true from the first
  // loop's start until the LAST one settles.
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

      // Read through a function call rather than `activeRef.current` directly
      // at each checkpoint below: `activeRef.current` can be mutated by the
      // unmount cleanup effect while an `await` in this loop is in flight, but
      // TypeScript's control-flow narrowing does not model that concurrent
      // mutation - narrowing the property directly would make the compiler
      // (wrongly) treat a later check as always the same value as an earlier
      // one, which is exactly the unmount race this guards against.
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
