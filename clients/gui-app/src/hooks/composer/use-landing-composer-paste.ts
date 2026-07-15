import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import {
  collectImages,
  useComposerPasteEvents,
  type ComposerPasteEditorHandle,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  reserveLandingImageBudget,
  scheduleLandingImageReconcile,
} from "@/lib/composer/landing-image-gc";
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
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await putImage(bytes);
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

export function useLandingComposerPaste(editorRef: {
  readonly current: ComposerPasteEditorHandle | null;
}): UseComposerPasteResult {
  const onFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      void landingImageAttrsFromFiles(files)
        .then((attrs) => {
          if (attrs.length === 0) return;
          const handle = editorRef.current;
          if (handle === null || !handle.isReady()) {
            // Stored bytes for these images are now orphaned - the same
            // situation as a failed ingest below - so reclaim them the same
            // way (their session entries keep the bytes safe until it runs).
            scheduleLandingImageReconcile();
            return;
          }
          handle.insertImageAttachments(attrs);
          handle.focus();
          attrs.forEach(() => {
            Analytics.getInstance().track(AnalyticsEvent.AttachmentAdded, {
              kind: "image",
              surface: "draft",
            });
          });
        })
        .catch((error: unknown) => {
          Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
            kind: "image",
            surface: "draft",
            blocker: analyticsBlockerFromError(error),
          });
          // A failed ingest (e.g. one image of a multi-image paste failed to hash
          // or store) inserts nothing, but earlier images may already be stored —
          // now orphaned. Surface the failure and schedule a reconcile to reclaim
          // them (their session entries keep the bytes safe until it runs).
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
          scheduleLandingImageReconcile();
        });
    },
    [editorRef],
  );
  return useComposerPasteEvents(onFiles);
}
