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
  type ComposerImageIngest,
  type ComposerPasteEditorHandle,
  type PathInsertionCommit,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  reserveLandingImageBudget,
  scheduleLandingImageReconcile,
} from "@/lib/composer/landing-image-gc";
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
 */
async function landingImageAttrsFromFiles(
  files: ReadonlyArray<File>,
  signal: AbortSignal,
): Promise<ImageAttachmentAttrs[]> {
  const accepted = collectImages(files, () => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "draft",
      blocker: "invalid_input",
    });
  });
  if (accepted.length === 0) return [];
  // Make room (evict oldest inactive drafts) before storing bytes; a paste that
  // can't fit even after eviction is blocked here (toast shown by the budget).
  const incomingBytes = accepted.reduce(
    (sum, file) => sum + (file.size > 0 ? file.size : 0),
    0,
  );
  if (!reserveLandingImageBudget(incomingBytes)) {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "draft",
      blocker: "rate_limit",
    });
    return [];
  }
  return Promise.all(
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
}

export function useLandingComposerPaste(
  editorRef: {
    readonly current: ComposerPasteEditorHandle | null;
  },
  fileDrops: IFileDropHost,
  mentionRoots: ReadonlyArray<string>,
): UseComposerPasteResult {
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
      convert: landingImageAttrsFromFiles,
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
    [],
  );
  return useComposerPasteEvents(imageIngest, insertAttrs, filePaths);
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
