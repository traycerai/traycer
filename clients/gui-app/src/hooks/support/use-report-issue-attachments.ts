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
  "count" | "type" | "size" | "budget" | "read_failed";

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

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out while reading image"));
    }, REPORT_IMAGE_READ_TIMEOUT_MS);
    file.arrayBuffer().then(
      (buffer) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(buffer);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(
          error instanceof Error ? error : new Error("Failed to read image"),
        );
      },
    );
  });
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
    case "read_failed":
      return {
        reason,
        message: `Couldn't read ${fileName || "that image"}. Try again.`,
      };
  }
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
      if (candidates.length === 0) return;
      setRejection(null);

      // Read through a function call rather than `activeRef.current` directly
      // at each checkpoint below: `activeRef.current` can be mutated by the
      // unmount cleanup effect while an `await` in this loop is in flight, but
      // TypeScript's control-flow narrowing does not model that concurrent
      // mutation - narrowing the property directly would make the compiler
      // (wrongly) treat a later check as always the same value as an earlier
      // one, which is exactly the unmount race this guards against.
      const isActive = (): boolean => activeRef.current;

      async function ingest(): Promise<void> {
        setIsIngesting(true);
        try {
          for (const file of candidates) {
            if (!isActive()) return;
            if (imagesRef.current.length >= MAX_REPORT_IMAGES) {
              setRejection(rejectionFor("count", ""));
              return;
            }
            const mediaType = reportImageMediaTypeForMimeType(file.type);
            if (mediaType === null) {
              setRejection(rejectionFor("type", file.name));
              continue;
            }
            if (file.size === 0 || file.size > MAX_REPORT_IMAGE_BYTES) {
              setRejection(rejectionFor("size", file.name));
              continue;
            }
            const existingTotal = imagesRef.current.reduce(
              (sum, image) => sum + image.size,
              0,
            );
            if (reportImagesExceedBudget(existingTotal + file.size)) {
              setRejection(rejectionFor("budget", file.name));
              continue;
            }
            let bytes: ArrayBuffer;
            try {
              bytes = await readFileAsArrayBuffer(file);
            } catch {
              setRejection(rejectionFor("read_failed", file.name));
              continue;
            }
            if (!isActive()) return;
            commitImage({
              id: crypto.randomUUID(),
              fileName: file.name || "screenshot.png",
              mimeType: mediaType,
              bytes,
              size: bytes.byteLength,
              previewUrl: URL.createObjectURL(file),
            });
          }
        } finally {
          if (isActive()) setIsIngesting(false);
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
