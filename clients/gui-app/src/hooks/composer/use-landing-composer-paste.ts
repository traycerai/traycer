import { useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { PastedComposerImage } from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import {
  collectImages,
  useComposerPasteEvents,
  IMAGE_MIME_PREFIX,
  MAX_IMAGE_BYTES,
  type ComposerImageConversionResult,
  type ComposerImageIngest,
  type ComposerPasteEditorHandle,
  type PathInsertionCommit,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { putImage } from "@/lib/composer/landing-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import { reserveLandingImageBudget } from "@/lib/composer/landing-image-budget";
import { base64ToBytes } from "@/lib/composer/image-base64";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

/**
 * Landing-composer paste/drop ingest. Unlike the shared base64 adapter
 * (`useComposerPasteAdapter`), accepted files are stored content-addressed and
 * inserted as HASH-ONLY nodes, so the persisted landing draft `content` never
 * carries image base64. Bytes go to the per-runtime image store (which also
 * seeds a synchronous session object-URL for flash-free render); the node
 * carries only `{ id, fileName, hash, mimeType, size }`.
 *
 * Drag/drop/paste event handling and the `image/*` + 5MB cap are reused from the
 * shared core (`useComposerPasteEvents` + `collectImages`); only the ingest
 * differs. Chat / new-conversation keep using `useComposerPaste` (base64).
 *
 * The returned reservation (when present) is deliberately NOT released here:
 * `runImageIngest` releases it only after `insertAttrs` has run, so a
 * concurrent admission check during the conversion-to-insertion handoff still
 * sees this batch's bytes charged. On a write failure, every started
 * read/write is awaited (`Promise.allSettled`, not `Promise.all`) before this
 * function releases and re-throws - a `Promise.all`-style short-circuit would
 * release while a slower sibling `putImage` is still landing bytes nothing
 * will ever reference.
 */
async function landingImageAttrsFromFiles(
  draftId: string | null,
  files: ReadonlyArray<File>,
  signal: AbortSignal,
): Promise<ComposerImageConversionResult> {
  const accepted = collectImages(files, () => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "draft",
      blocker: "invalid_input",
    });
  });
  if (accepted.length === 0) return { attrs: [] };
  // Reserve against this draft's roots (plus every other outstanding
  // reservation, landing paste or stash import) before storing bytes. A
  // capacity miss rejects only this attachment; GC never discards another
  // draft to make room. The hash isn't known until `putImage` hashes the
  // bytes below, so each candidate reserves anonymously (see
  // `landing-image-budget.ts`).
  const reservation = reserveLandingImageBudget(
    draftId,
    accepted.map((file) => ({
      hash: null,
      bytes: file.size > 0 ? file.size : 0,
    })),
  );
  if (reservation === null) {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "draft",
      blocker: "rate_limit",
    });
    scheduleLandingImageReconcile();
    return { attrs: [] };
  }

  const settled = await Promise.allSettled(
    accepted.map(async (file) => {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      const hash = await putImage(bytes);
      signal.throwIfAborted();
      return {
        id: uuidv4(),
        fileName: file.name || "image",
        hash,
        mimeType: file.type || "image/png",
        size: file.size > 0 ? file.size : null,
      } satisfies ImageAttachmentAttrs;
    }),
  );

  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected !== undefined) {
    // Every started read/write above has now settled - only then release, so
    // a slower sibling write can never land after this reservation is gone.
    reservation.release();
    throw rejected.reason;
  }

  const attrs: ImageAttachmentAttrs[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") attrs.push(result.value);
  }
  return { attrs, release: () => reservation.release() };
}

export function useLandingComposerPaste(params: {
  readonly editorRef: {
    readonly current: ComposerPasteEditorHandle | null;
  };
  readonly draftId: string | null;
  readonly disabled: boolean;
  readonly fileDrops: IFileDropHost;
  readonly mentionRoots: ReadonlyArray<string>;
}): UseComposerPasteResult {
  const { editorRef, draftId, disabled, fileDrops, mentionRoots } = params;
  const beginPathInsertion = useCallback((): PathInsertionCommit | null => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return null;
    return handle.beginPathInsertion();
  }, [editorRef]);
  const filePaths = useMemo(
    () => ({ fileDrops, mentionRoots, beginPathInsertion }),
    [fileDrops, mentionRoots, beginPathInsertion],
  );
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
  const imageIngest = useMemo(
    (): ComposerImageIngest => ({
      convert: (files, signal) => {
        // Disabled (e.g. mid-submit) skips ingest entirely - no hashing,
        // storing, or budget reservation - the same as a no-op paste.
        if (disabled) return Promise.resolve({ attrs: [] });
        return landingImageAttrsFromFiles(draftId, files, signal);
      },
      onSettled: (accepted) => {
        if (accepted.length === 0) {
          // The editor was unavailable after conversion, so this image has no
          // live node and can be reclaimed by the normal sweep.
          scheduleLandingImageReconcile();
          return;
        }
        accepted.forEach(() => {
          Analytics.getInstance().track(AnalyticsEvent.AttachmentAdded, {
            kind: "image",
            surface: "draft",
          });
        });
      },
      onRejected: (error, aborted) => {
        Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
          kind: "image",
          surface: "draft",
          blocker: analyticsBlockerFromError(error),
        });
        // A failed or aborted conversion can leave stored bytes without a
        // node, so schedule the normal orphan sweep in either case.
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
        scheduleLandingImageReconcile();
      },
    }),
    [disabled, draftId],
  );
  return useComposerPasteEvents(imageIngest, insertAttrs, filePaths, undefined);
}

// A base64 clipboard image whose decoded size would exceed the per-image cap is
// dropped WITHOUT decoding, so a malformed/oversized structured payload can't
// allocate far beyond the cap. base64 encodes 3 bytes per 4 chars, so
// `length * 3 / 4` is the decoded size (padding makes this a slight
// over-estimate, which only ever drops sooner).
const MAX_PASTED_IMAGE_B64_LENGTH = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4;

/**
 * Synchronously validate one structured-paste inline-base64 image and return its
 * bytes, or `null` if it must be rejected. Applies the exact same contract the
 * file pipeline does — encoded-length cap, `image/*` MIME, decode, 5 MB — but
 * WITHOUT building a `File` or inserting, because the in-place paste keeps the
 * node in the document and only needs the raw bytes for the background
 * hash + `putImage` job.
 */
export function decodeValidatedPastedImage(
  image: PastedComposerImage,
): Uint8Array<ArrayBuffer> | null {
  if (image.b64content.length > MAX_PASTED_IMAGE_B64_LENGTH) return null;
  if (!image.mimeType.startsWith(IMAGE_MIME_PREFIX)) return null;
  const bytes = base64ToBytes(image.b64content);
  if (bytes === null) return null;
  if (bytes.byteLength > MAX_IMAGE_BYTES) return null;
  return bytes;
}
