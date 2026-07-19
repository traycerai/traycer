import { useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import {
  collectImages,
  useComposerPasteEvents,
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
