import { useCallback, useMemo, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import type { IFileDropHost } from "@traycer-clients/shared/platform/runner-host";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ImageAttachmentAttrs } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "@/components/chat/composer/editor/extensions/chat-paste-handler";
import {
  collectImages,
  prepareComposerImageFile,
  useComposerPasteEvents,
  type ComposerImageConversionResult,
  type ComposerImageIngest,
  type ComposerPasteEditorHandle,
  type PathInsertionCommit,
  type UseComposerPasteResult,
} from "@/hooks/composer/use-composer-paste";
import { decodeValidatedPastedImage } from "@/hooks/composer/use-landing-composer-paste";
import {
  createComposerImagePreparationSession,
  showImageTooLargeToast,
  type ImagePreparationSession,
  type PreparedComposerImage,
} from "@/lib/composer/composer-image-preparation";
import {
  runPendingImageIngest,
  type PendingImageIngestEditor,
} from "@/lib/composer/composer-pending-image-ingest";
import { putImage } from "@/lib/composer/composer-image-store";
import { scheduleLandingImageReconcile } from "@/lib/composer/landing-image-gc";
import {
  reserveLandingImageBudget,
  type LandingImageBudgetReservation,
} from "@/lib/composer/landing-image-budget";
import {
  collectImageAtoms,
  type ComposerImageAtom,
} from "@/lib/composer/image-atoms";
import { containsBase64ImageNodes } from "@/lib/composer/strip-base64-image-nodes";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

/**
 * Hash-first paste/drop ingest for the CHAT-family composers: the in-epic chat
 * composer, the edit composer and the new-conversation modal.
 *
 * These three used to insert inline `b64content` nodes verbatim, which is what
 * put multi-megabyte base64 in `localStorage` and in every debounced
 * `drafts.upsert` body. They now do what the landing composer does: prepared
 * bytes go to the window's composer image store and the node carries only a
 * `hash`, so nothing persisted is ever base64 and the draft mirror uploads the
 * bytes once, by hash, off the send path.
 *
 * Three ways an image arrives, and all three end at the same place:
 *
 * 1. **A file** (paste, drop, the attach button) — prepared and stored BEFORE
 *    any node exists, so the node is hash-only from birth.
 * 2. **Inline base64 in a structured or HTML paste** (copying an image out of
 *    another composer) — the node is inserted immediately, still carrying its
 *    b64 so it paints at once, and a background job flips it to a hash in
 *    place. In memory the b64 node survives until hashed; the serialization
 *    seams are what strip it.
 * 3. **An inline node inserted by something else entirely** — today the
 *    cross-host browser-tab preview, whose screenshot the mention extension
 *    appends asynchronously with no access to this hook. {@link
 *    ComposerHashFirstPasteResult.notePossiblePendingImages} is the catch-all:
 *    the surface hands it every document change, and any pending node with no
 *    job running gets one. This is deliberately stronger than the landing
 *    composer's mount-only re-entry, because on chat the editor can gain a b64
 *    node long after it mounted, and a node no job ever claims would be stripped
 *    from every persist until the next remount.
 */
export interface ComposerHashFirstEditorHandle
  extends ComposerPasteEditorHandle, PendingImageIngestEditor {
  readonly getJSON: () => JsonContent;
}

export interface ComposerHashFirstPasteResult extends UseComposerPasteResult {
  /**
   * Validates a paste's inline-base64 images synchronously and starts their
   * in-place ingest jobs, returning a verdict per image. Passed straight to
   * `ComposerPromptEditor`'s `ingestPastedComposerImages`.
   */
  readonly ingestPastedComposerImages: (
    images: ReadonlyArray<PastedComposerImage>,
  ) => ReadonlyArray<PastedComposerImageOutcome>;
  /**
   * Hand this every document change (and the editor-ready signal). It is a
   * cheap short-circuiting walk when there is nothing pending, which is every
   * keystroke of every draft that is not mid-paste.
   */
  readonly notePossiblePendingImages: (content: JsonContent) => void;
  /**
   * The same sweep, reading the document off the editor. For the editor-ready
   * signal, where the surface has no content value in hand and a restored draft
   * may already hold pending nodes.
   */
  readonly reingestPendingImages: () => void;
}

/**
 * Files → hash-only attrs. Images are prepared SERIALLY before anything is
 * reserved or stored, so a multi-image paste holds one decoded bitmap at a time,
 * and both the reservation and the node carry the PREPARED size — the bytes that
 * actually land in the store — rather than the source file's.
 *
 * The returned reservation is deliberately NOT released here: `runImageIngest`
 * releases it only after `insertAttrs` has run, so a concurrent admission check
 * during the conversion-to-insertion handoff still sees this batch's bytes
 * charged. On a write failure every started read/write is awaited
 * (`Promise.allSettled`, not `Promise.all`) before releasing and re-throwing — a
 * short-circuit would release while a slower sibling `putImage` is still landing
 * bytes nothing will ever reference.
 */
async function hashFirstImageAttrsFromFiles(
  budgetOwnerId: string | null,
  files: ReadonlyArray<File>,
  signal: AbortSignal,
  session: ImagePreparationSession,
): Promise<ComposerImageConversionResult> {
  const trackRejected = (): void => {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "chat",
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
  // The hash isn't known until `putImage` hashes the bytes below, so each
  // candidate reserves anonymously; the charge is the PREPARED length, which is
  // what the store is about to hold.
  //
  // The reservation covers the gap between admitting the bytes and the node
  // existing; the node's own `size` is what the budget charges afterwards, once
  // `release()` runs. That hand-off is only real because the surfaces this hook
  // serves now contribute their documents to `referencedImageBytes` (the
  // content sources in `draft-mirror-coordinator` and `chat-session-store`).
  // It was NOT true when this comment first claimed it: the steady-state sum
  // read landing drafts alone, so a chat, modal or edit composer released each
  // reservation into an accounting that had never heard of it and the next
  // paste was admitted against zero prior usage - eighteen sequential 3.75 MiB
  // images fit inside a 64 MiB window budget, one at a time.
  const reservation = reserveLandingImageBudget(
    budgetOwnerId,
    prepared.map((image) => ({ hash: null, bytes: image.byteLength })),
  );
  if (reservation === null) {
    Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
      kind: "image",
      surface: "chat",
      blocker: "rate_limit",
    });
    scheduleLandingImageReconcile();
    return { attrs: [] };
  }

  const settled = await Promise.allSettled(
    prepared.map(async (image) => {
      signal.throwIfAborted();
      const hash = await putImage(image.bytes);
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
    reservation.release();
    throw rejected.reason;
  }

  const attrs: ImageAttachmentAttrs[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") attrs.push(result.value);
  }
  return { attrs, release: () => reservation.release() };
}

function showPastedImageDecodeToast(corruptedCount: number): void {
  reportableErrorToast(
    corruptedCount === 1
      ? "Couldn't attach a pasted image."
      : "Couldn't attach some pasted images.",
    { description: "The image was corrupted or too large." },
    {
      title: "Could not attach image",
      message: null,
      code: null,
      source: "Chat composer",
    },
  );
}

export function useComposerHashFirstPaste(params: {
  readonly editorRef: {
    readonly current: ComposerHashFirstEditorHandle | null;
  };
  /**
   * Whose budget an image charges against, for the refusal copy only. The chat
   * composer and edit composer pass the chat id; the new-conversation modal
   * passes its epic id.
   */
  readonly budgetOwnerId: string | null;
  readonly disabled: boolean;
  readonly fileDrops: IFileDropHost;
  readonly mentionRoots: ReadonlyArray<string>;
}): ComposerHashFirstPasteResult {
  const { editorRef, budgetOwnerId, disabled, fileDrops, mentionRoots } =
    params;
  // One preparation session per mount, shared by BOTH ingest paths, so this
  // surface only ever holds one decoded bitmap however many images arrive at
  // once. (Its other state, the WebP-support probe, is likewise run once.)
  const preparationSession = useMemo(
    () => createComposerImagePreparationSession(),
    [],
  );
  // Node ids whose ingest job is in flight. The catch-all sweep below runs on
  // every document change, and a node keeps its b64 payload for the whole job,
  // so without this each change would start a duplicate job for the same node -
  // double-charging the budget and racing two rewrites of one node.
  const inFlightIds = useRef(new Set<string>());
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
        return hashFirstImageAttrsFromFiles(
          budgetOwnerId,
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
            surface: "chat",
          });
        });
      },
      onRejected: (error, aborted) => {
        Analytics.getInstance().track(AnalyticsEvent.AttachmentRejected, {
          kind: "image",
          surface: "chat",
          blocker: analyticsBlockerFromError(error),
        });
        if (!aborted) {
          reportableErrorToast(
            "Couldn't attach the image.",
            { description: "Please try adding it again." },
            {
              title: "Could not attach image",
              message: null,
              code: null,
              source: "Chat composer",
            },
          );
        }
        // A failed or aborted conversion can leave stored bytes without a node,
        // so schedule the normal orphan sweep in either case.
        scheduleLandingImageReconcile();
      },
    }),
    [budgetOwnerId, disabled, preparationSession],
  );
  const paste = useComposerPasteEvents(
    imageIngest,
    insertAttrs,
    filePaths,
    undefined,
  );
  const runPendingImageJob = paste.runPendingImageJob;

  const startPendingImageIngest = useCallback(
    (
      id: string,
      bytes: Uint8Array<ArrayBuffer>,
      options: {
        readonly onSettled: (() => void) | undefined;
        readonly reserveAfterStore: boolean;
        readonly fileName: string;
        readonly mimeType: string;
      },
    ) => {
      const pending = inFlightIds.current;
      if (pending.has(id)) return;
      pending.add(id);
      runPendingImageJob((signal) =>
        runPendingImageIngest({
          id,
          bytes,
          signal,
          session: preparationSession,
          budgetOwnerId,
          editor: () => editorRef.current,
          showRefusal: showImageTooLargeToast,
          options,
        }).finally(() => {
          pending.delete(id);
        }),
      );
    },
    [budgetOwnerId, editorRef, preparationSession, runPendingImageJob],
  );

  // Synchronously validate a paste's inline-base64 images (decode, MIME, source
  // ceiling, budget), mint a fresh id + start the background job for each
  // accepted one, and report a verdict per image. The paste handler keeps the
  // accepted nodes IN document order (stamped with these ids) and drops rejected
  // ones - no positions are ever discarded.
  //
  // The budget is reserved here, synchronously, on the SOURCE length: this path
  // owes the paste handler a verdict per image before it can yield, so it cannot
  // wait for preparation to report the prepared length. Preparation only ever
  // shrinks an image that was over the ceiling, and the node written at the end
  // of the job carries the prepared `size`, which is what the budget's
  // steady-state accounting reads - so the charge here is a transient upper
  // bound, not the number the budget settles on.
  const ingestPastedComposerImages = useCallback(
    (
      images: ReadonlyArray<PastedComposerImage>,
    ): ReadonlyArray<PastedComposerImageOutcome> => {
      const decoded = images.map((image) => decodeValidatedPastedImage(image));
      const acceptedBytes = decoded.filter(
        (bytes): bytes is Uint8Array<ArrayBuffer> => bytes !== null,
      );
      // Reserve atomically as a batch, but retain one handle per image so an
      // unmounted job releases its own anonymous charge before that image's
      // re-entry acquires the now-hash-aware reservation. Holding one aggregate
      // handle until the slowest sibling settles can transiently double-charge
      // earlier images near the cap.
      const reservations: LandingImageBudgetReservation[] = [];
      for (const bytes of acceptedBytes) {
        const reservation = reserveLandingImageBudget(budgetOwnerId, [
          { hash: null, bytes: bytes.byteLength },
        ]);
        if (reservation === null) break;
        reservations.push(reservation);
      }
      const budgetOk = reservations.length === acceptedBytes.length;
      if (!budgetOk) {
        for (const reservation of reservations) reservation.release();
        reservations.length = 0;
        scheduleLandingImageReconcile();
      }
      // Count ONLY undecodable images toward the generic "corrupted or too
      // large" toast. A valid image blocked solely by the aggregate budget is
      // already covered by `reserveLandingImageBudget`'s own accurate budget
      // toast, so adding this one would double-toast it with a false cause.
      let corruptedCount = 0;
      let acceptedIndex = 0;
      const outcomes = decoded.map(
        (bytes, index): PastedComposerImageOutcome => {
          if (bytes === null) {
            corruptedCount += 1;
            return { kind: "rejected" };
          }
          if (!budgetOk) return { kind: "rejected" };
          const reservation = reservations[acceptedIndex];
          acceptedIndex += 1;
          const id = uuidv4();
          const source = images[index];
          startPendingImageIngest(id, bytes, {
            onSettled: () => reservation.release(),
            reserveAfterStore: false,
            fileName: source.fileName,
            mimeType: source.mimeType,
          });
          return { kind: "accepted", id };
        },
      );
      if (corruptedCount > 0) showPastedImageDecodeToast(corruptedCount);
      return outcomes;
    },
    [budgetOwnerId, startPendingImageIngest],
  );

  // Re-entry for any pending b64 node currently in the document that no job
  // owns. Idempotent by construction: `putImage` is content-addressed and
  // single-flight, the rewrite is by id, and `inFlightIds` keeps a node from
  // being claimed twice. The restarted job re-reserves the measured, now-hashed
  // bytes AFTER the shared write settles, so capacity consumed during an
  // inactive gap correctly rejects and removes the pending node.
  const reingestPendingImages = useCallback(() => {
    const handle = editorRef.current;
    if (handle === null || !handle.isReady()) return;
    const pending = collectImageAtoms(handle.getJSON()).filter(
      (atom): atom is ComposerImageAtom & { readonly b64content: string } =>
        atom.b64content !== null && !inFlightIds.current.has(atom.id),
    );
    if (pending.length === 0) return;
    let corruptedCount = 0;
    for (const atom of pending) {
      const bytes = decodeValidatedPastedImage({
        fileName: atom.fileName,
        mimeType: atom.mimeType,
        b64content: atom.b64content,
      });
      if (bytes === null) {
        // A corrupt/oversized b64 node (a manually corrupted restore, or a
        // producer that never went through a paste) can't be ingested: drop it
        // with the single shared toast.
        handle.removeImageAttachmentById(atom.id);
        corruptedCount += 1;
        continue;
      }
      startPendingImageIngest(atom.id, bytes, {
        onSettled: undefined,
        reserveAfterStore: true,
        fileName: atom.fileName,
        mimeType: atom.mimeType,
      });
    }
    if (corruptedCount > 0) showPastedImageDecodeToast(corruptedCount);
  }, [editorRef, startPendingImageIngest]);

  const notePossiblePendingImages = useCallback(
    (content: JsonContent) => {
      // Short-circuiting and allocation-free when there is nothing pending,
      // which is every keystroke of every draft that is not mid-paste. Only a
      // positive answer pays for the atom walk in `reingestPendingImages`.
      if (!containsBase64ImageNodes(content)) return;
      reingestPendingImages();
    },
    [reingestPendingImages],
  );

  return {
    ...paste,
    ingestPastedComposerImages,
    notePossiblePendingImages,
    reingestPendingImages,
  };
}
