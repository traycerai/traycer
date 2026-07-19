import { useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import {
  collectImages,
  useComposerPasteEvents,
  type AttachmentInsertionCommit,
  type ComposerImageIngest,
  type ComposerPasteEditorHandle,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { putImage } from "@/lib/composer/landing-image-store";
import {
  releaseInFlightImageRoot,
  reserveLandingImageBudget,
  retainInFlightImageRoot,
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
  // Each task owns its own retain lease. Waiting for every task to settle on
  // failure is deliberate: a sibling can put+retain after another file has
  // rejected, and every such late lease must be released before this ingest
  // reports failure (the same ordering applies to abort/unmount).
  const results = await Promise.allSettled(
    accepted.map(async (file) => {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      const hash = await putImage(bytes);
      retainInFlightImageRoot(hash);
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
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        releaseInFlightImageRoot(result.value.hash);
      }
    });
    throw failure.reason;
  }
  return results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}

export function useLandingComposerPaste(
  editorRef: {
    readonly current: ComposerPasteEditorHandle | null;
  },
  fileDrops: IFileDropHost,
  mentionRoots: ReadonlyArray<string>,
): UseComposerPasteResult {
  const beginAttachmentInsertion =
    useCallback((): AttachmentInsertionCommit | null => {
      const handle = editorRef.current;
      if (handle === null || !handle.isReady()) return null;
      return handle.beginAttachmentInsertion();
    }, [editorRef]);
  const filePaths = useMemo(
    () => ({ fileDrops, mentionRoots, beginAttachmentInsertion }),
    [fileDrops, mentionRoots, beginAttachmentInsertion],
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
      onSettled: (accepted, converted) => {
        // Release the in-flight root retained in `landingImageAttrsFromFiles`
        // for every converted hash - by now either the node is inserted (a
        // live root via editor content, see `accepted`) or it's orphaned
        // (reclaimed by the reconcile scheduled just below). Both outcomes no
        // longer need the explicit retain.
        converted.forEach((attr) => {
          if (attr.hash !== undefined) releaseInFlightImageRoot(attr.hash);
        });
        if (accepted.length === 0) {
          // Stored bytes for `converted` are now orphaned - the editor
          // wasn't ready to accept them - so reclaim them the same way a
          // failed ingest does below (their session entries keep the bytes
          // safe until the reconcile runs).
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
        // A failed or aborted ingest (e.g. one image of a multi-image paste
        // failed to hash/store, or the composer unmounted mid-flight)
        // inserts nothing, but earlier images may already be stored - now
        // orphaned. Schedule a reconcile to reclaim them (their session
        // entries keep the bytes safe until it runs) regardless of cause;
        // only the user-facing failure toast is abort-specific.
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
