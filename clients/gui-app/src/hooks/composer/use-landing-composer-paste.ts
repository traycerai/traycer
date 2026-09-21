import { useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { PastedComposerImage } from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import {
  collectImages,
  prepareComposerImageFile,
  useComposerPasteEvents,
  IMAGE_MIME_PREFIX,
  MAX_IMAGE_SOURCE_BYTES,
  type ComposerImageConversionResult,
  type ComposerImageIngest,
  type ComposerPasteEditorHandle,
  type PathInsertionCommit,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import {
  createComposerImagePreparationSession,
  type ImagePreparationSession,
  type PreparedComposerImage,
} from "@/lib/composer/composer-image-preparation";
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
 * Landing-composer paste/drop ingest. Accepted files are stored
 * content-addressed and inserted as HASH-ONLY nodes, so the persisted landing
 * draft `content` never carries image base64. Bytes go to the per-runtime image
 * store (which also seeds a synchronous session object-URL for flash-free
 * render); the node carries only
 * `{ id, fileName, hash, mimeType, size, byHashEligible }`.
 *
 * Drag/drop/paste event handling, the `image/*` filter, the source ceiling and
 * preparation itself are reused from the shared base (`useComposerPasteEvents`
 * + `collectImages` + `prepareComposerImageFile`); only the ingest differs.
 *
 * The chat composer, the edit composer and the new-conversation modal are
 * hash-first too now, through `useComposerHashPaste` — the same model over
 * the same base, differing in whose budget an image charges against and in when
 * a pending node is re-entered (landing re-enters at mount; the chat family
 * sweeps every document change, because a node can arrive there long after the
 * editor mounted). Inline base64 now exists only at submit, through
 * `lib/drafts/draft-image-inlining.ts` and the rewrite in
 * `lib/composer/image-atoms.ts`, which is what a host without the draft-blob
 * bridge still ingests.
 *
 * Images are prepared SERIALLY before anything is reserved or stored, so a
 * multi-image paste holds one decoded bitmap at a time, and the reservation
 * and the node both carry the PREPARED size - the bytes that actually land in
 * the store - rather than the source file's. The session belongs to the HOOK's
 * mount rather than to this call, which is what makes a second drop landing
 * mid-preparation queue behind the first instead of decoding beside it; see the
 * note at its declaration for why it is not also shared with the mount's
 * structured-paste jobs.
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
  session: ImagePreparationSession,
): Promise<ComposerImageConversionResult> {
  const trackRejected = (): void => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "draft",
      blocker: "invalid_input",
    });
  };
  const accepted = collectImages(files, trackRejected);
  if (accepted.length === 0) return { attrs: [] };
  const prepared: PreparedComposerImage[] = [];
  for (const file of accepted) {
    signal.throwIfAborted();
    const image = await prepareComposerImageFile(
      session,
      file,
      signal,
      trackRejected,
    );
    if (image !== null) prepared.push(image);
  }
  if (prepared.length === 0) return { attrs: [] };
  // Reserve against this draft's roots (plus every other outstanding
  // reservation, landing paste or stash import) before storing bytes. A
  // capacity miss rejects only this attachment; GC never discards another
  // draft to make room. The hash isn't known until `putImage` hashes the
  // bytes below, so each candidate reserves anonymously (see
  // `landing-image-budget.ts`). The charge is the PREPARED length, which is
  // what `putImage` is about to store and what the node's `size` will report
  // back to the budget's steady-state accounting.
  const reservation = reserveLandingImageBudget(
    draftId,
    prepared.map((image) => ({ hash: null, bytes: image.byteLength })),
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
    prepared.map(async (image, candidateIndex) => {
      signal.throwIfAborted();
      const hash = await putImage(image.bytes);
      // These bytes are in the partition now, and whatever roots them charges
      // them from here on. Hand THIS candidate's slot over to the hash rather
      // than holding both until the slowest sibling finishes - that double
      // count refuses pastes that fit. The index matters: these writes run
      // concurrently, so "the first unnamed slot" would be whichever sibling is
      // slowest, and settling a large slot with a small item's hash makes the
      // difference vanish from the ledger.
      //
      // The index is over `prepared`, which is also what the reservation was
      // built from one block up, so the two index spaces are the same by
      // construction rather than by coincidence.
      reservation.settleStored(candidateIndex, hash);
      signal.throwIfAborted();
      return {
        id: uuidv4(),
        fileName: image.fileName,
        hash,
        mimeType: image.mimeType,
        size: image.byteLength > 0 ? image.byteLength : null,
        byHashEligible: image.byHashEligible,
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
  // THIS HOOK's session, one per mount, so the file-paste path serializes its
  // own decodes: a multi-file drop holds one bitmap at a time however many
  // files it carries.
  //
  // Not the mount's single session shared with the structured-paste jobs, which
  // is what an earlier shape had. That sharing is unreachable here: the ingest
  // hook is built FROM this hook's result (`landing-composer.tsx` passes
  // `paste.runPendingImageJob` into it), so a session cannot flow from one to
  // the other without inverting that edge. `useComposerPendingImageIngest`
  // therefore owns a second one. The cost is at most two concurrent
  // preparations per mount; what it does NOT cost is the unbounded case - N
  // structured-paste jobs launched in one tick all decoding at once - because
  // those all queue behind the ingest hook's single session.
  const preparationSession = useMemo(
    (): ImagePreparationSession => createComposerImagePreparationSession(),
    [],
  );
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
        return landingImageAttrsFromFiles(
          draftId,
          files,
          signal,
          preparationSession,
        );
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
    [disabled, draftId, preparationSession],
  );
  return useComposerPasteEvents(imageIngest, insertAttrs, filePaths, undefined);
}

// A base64 clipboard image whose decoded size would exceed the source ceiling
// is dropped WITHOUT decoding, so a malformed/oversized structured payload
// can't allocate far beyond the ceiling. base64 encodes 3 bytes per 4 chars,
// so `length * 3 / 4` is the decoded size (padding makes this a slight
// over-estimate, which only ever drops sooner).
const MAX_PASTED_IMAGE_B64_LENGTH =
  Math.ceil((MAX_IMAGE_SOURCE_BYTES * 4) / 3) + 4;

/**
 * Synchronously validate one structured-paste inline-base64 image and return its
 * bytes, or `null` if it must be rejected. Applies the exact same contract the
 * file pipeline does — encoded-length cap, `image/*` MIME, decode, the source
 * ceiling — but WITHOUT building a `File` or inserting, because the in-place
 * paste keeps the node in the document and only needs the raw bytes for the
 * background prepare + hash + `putImage` job. Preparation runs inside that job
 * (`startPendingImageIngest`), not here: this call is on the synchronous paste
 * path, which has to return a verdict per image before it can yield.
 */
export function decodeValidatedPastedImage(
  image: PastedComposerImage,
): Uint8Array<ArrayBuffer> | null {
  if (image.b64content.length > MAX_PASTED_IMAGE_B64_LENGTH) return null;
  if (!image.mimeType.startsWith(IMAGE_MIME_PREFIX)) return null;
  const bytes = base64ToBytes(image.b64content);
  if (bytes === null) return null;
  if (bytes.byteLength > MAX_IMAGE_SOURCE_BYTES) return null;
  return bytes;
}
