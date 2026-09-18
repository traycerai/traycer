/**
 * The last resort for a prompt the host never recorded: put it somewhere that
 * outlives the chat session entirely.
 *
 * ## Why retention was not enough
 *
 * The first answer to "a recovering chat must not be disposed" was to hold the
 * session: `holdsUnrecordedPrompt` refuses warm eviction and defers the idle
 * clock. That is necessary and it is not sufficient, because **every hold in
 * this registry is bounded**. The idle deferral caps at
 * `MAX_ACTIVE_CHAT_IDLE_DEFER_MS` - one hour - measured from the moment the
 * session went lease-free, and at that boundary the shared registry disposes
 * whatever `hasActiveWork` says. An unread hand-back going unread for an hour
 * is not an exotic case; it is a user who opened another tab.
 *
 * Raising the cap would not fix it either, and the reviewer's phrasing is the
 * right one to keep: **a longer timer is not a handoff.** Something has to take
 * ownership of the text before the session goes.
 *
 * ## Why a closed start-page draft
 *
 * Drafts are the application's durable, user-visible home for an unsent prompt
 * (D01/D03): persisted, listed in the composer's Drafts control, openable into
 * any composer, and explicitly built to survive a session ending. A `closed`
 * start-page draft is the put-away shape of exactly that - it is a row in the
 * list and nothing is mounted on it. Inventing a second place would mean
 * inventing a second UI for finding it.
 *
 * This module used to write the prompt stash, which was the same argument
 * against a different plane; the stash is gone and the drafts control took its
 * place, so the handoff follows it.
 *
 * ## Why this goes through `importImagesIntoLanding`
 *
 * A landing draft's images live in this window's hash-addressed landing
 * partition, and a draft row that names a digest the partition does not hold
 * renders as unavailable. `importImagesIntoLanding` is the one path that
 * resolves a source blob, charges it against the landing budget, writes the
 * bytes and rewrites the content to the landing hashes - holding its
 * reservation across the install, so the bytes are never unreferenced roots
 * while an image reconcile runs. `lib/drafts/stash-migration.ts` installs a
 * converted stash entry exactly this way, and the two must not drift.
 *
 * ## What survives when the bytes do not
 *
 * A hash whose bytes are genuinely gone from this device fails the whole
 * import, which would put us back to losing the text. So an unresolvable
 * document is retried with its image nodes DROPPED, and the qualification says
 * how many went. Losing the images is bad; losing the words the user typed is
 * the failure this module exists to prevent.
 *
 * ## Why the qualification is written into the document
 *
 * A landing draft is `{ content, selection, settings, workspace, ... }` - it
 * has no field for a reason. The qualification therefore goes into the
 * document itself, as a trailing paragraph. That is deliberate rather than a
 * workaround: opening the row drops it straight into a composer, so anything
 * not in `content` would be invisible at exactly the moment the user is
 * deciding whether to resend. A handed-off prompt whose worktree is unstated
 * is one the user can resend into the wrong workspace, which is the failure
 * this whole account-qualification thread exists to prevent.
 *
 * The caller passes `reason` ALREADY account-qualified - the full
 * `deadSendAccountClauses` text, naming every staged entry, its branch and
 * whether it still exists. An earlier version took a single `workspacePath`
 * and silently dropped an import worktree's ref, its branch, and every folder
 * after the first.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";

import { sniffImageMimeType } from "@/lib/attachments/image-mime-signature";
import {
  ImageBlobMissingError,
  type ImageBlob,
  type ImageBytes,
} from "@/lib/attachments/image-bytes";
import { readComposerHostIdSnapshot } from "@/lib/composer/composer-host-snapshot";
import { base64ToBytes } from "@/lib/composer/image-base64";
import {
  DEFAULT_IMAGE_MIME_TYPE,
  isHostStorableImageMimeType,
} from "@/lib/composer/host-storable-image-formats";
import {
  importImagesIntoLanding,
  type LandingImageImportResult,
} from "@/lib/composer/landing-image-import";
import { sha256Hex } from "@/lib/composer/landing-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";

/**
 * How long the handoff waits for a prompt's images before giving up on them
 * and saving the text alone. Shorter than the retry path's window on purpose:
 * this runs during teardown, and the thing being protected is the words.
 */
export const HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS = 5_000;

const TIMED_OUT = Symbol("handoff-image-timeout");

function timeoutAfter(ms: number): Promise<typeof TIMED_OUT> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(TIMED_OUT), ms);
  });
}

/** Resolves one of the prompt's image hashes to bytes, or `null`. */
export type HandoffImageResolver = (hash: string) => Promise<ImageBytes | null>;

/**
 * Why a handoff could not keep its images. Each maps to a different sentence,
 * because "we dropped your picture" and "we could not find your picture" are
 * different facts and a reader deciding whether to resend needs the right one.
 */
export type DroppedImageCause =
  | "missing"
  | "timed-out"
  | "capacity"
  | "unsupported"
  | "unprepared";

const DROPPED_IMAGE_CLAUSE: Readonly<Record<DroppedImageCause, string>> = {
  missing: "the bytes are no longer on this device",
  "timed-out": "the bytes could not be read in time",
  capacity: "it did not fit in this window's image budget",
  unsupported: "its format cannot be kept in a draft",
  unprepared: "it could not be prepared for a draft",
};

/**
 * What a handoff leaves behind.
 *
 * `readsSettled` exists because the image import is BOUNDED but not
 * cancellable. When the deadline wins, the import is still reading blobs and
 * writing bytes, and the caller's image roots (`handoffCaptureRoots`) are the
 * only thing naming those hashes while it does. Releasing them when the
 * text-only fallback installs would hand a concurrent sweep the very bytes the
 * abandoned read is part-way through. So the caller waits on this instead of
 * on the install.
 *
 * It settles immediately on every path that started no reads, and on the
 * ordinary path once the import that won the race has finished.
 */
export interface PromptHandoffOutcome {
  /** The installed draft's id, or `null` when the identity fence refused it. */
  readonly draftId: string | null;
  /** Settles once every image read this handoff started has finished. */
  readonly readsSettled: Promise<void>;
}

/**
 * The import, flattened so it never rejects.
 *
 * A rejecting promise cannot be safely left attached after the race: the
 * `.catch` that keeps it from becoming a detached unhandled rejection would
 * also have to decide what the rejection MEANS, and only the winning path
 * knows that. Flattening moves the decision to one place and lets the losing
 * leg do nothing but release.
 */
type ImportOutcome =
  | {
      readonly kind: "imported";
      readonly result: LandingImageImportResult;
      readonly droppedInline: number;
    }
  | { readonly kind: "refused"; readonly droppedInline: number }
  | { readonly kind: "failed"; readonly error: unknown };

/**
 * Install the prompt being handed off at teardown as a closed start-page
 * draft.
 *
 * `reason` is the already-qualified account text. `stillCurrent` is the
 * caller's identity fence; it is re-asked SYNCHRONOUSLY immediately before the
 * install, because every await above it is a window in which a sign-out or a
 * user switch could have moved the account this text belongs to.
 *
 * Resolves to the installed draft id (or `null` when the fence refused it)
 * together with `readsSettled` - see {@link PromptHandoffOutcome}. Rejects only
 * if even the text-only fallback cannot be installed, which the caller treats
 * as unrecoverable.
 */
export async function buildUnrecordedPromptHandoff(args: {
  readonly content: JsonContent;
  /**
   * The prompt's annotation sidecar, or `[]` for a source that has none.
   * Required rather than defaulted, so a new handoff site has to decide - the
   * draft this builds is the LAST copy of the text, and it cannot carry the
   * sidecar at all.
   */
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
  readonly reason: string;
  readonly readHashImage: HandoffImageResolver;
  readonly stillCurrent: () => boolean;
}): Promise<PromptHandoffOutcome> {
  // Started BEFORE the race and held afterwards, whichever leg wins. The race
  // bounds how long the handoff waits; it does not cancel anything, so this
  // promise is the only remaining owner of whatever the import allocates.
  const pending = resolveHandoffImages(args.content, args.readHashImage);
  try {
    // BOUNDED. `readHashImage` reaches the host for a digest this window does
    // not hold locally, and that read can hang - it is the same leg
    // `RECOVERY_INLINING_TIMEOUT_MS` exists to bound on the retry path. An
    // unbounded wait here does not degrade the handoff, it CANCELS it: the
    // chain never settles, nothing is installed, and the prompt is lost as
    // silently as if nothing had been written at all. The deadline is what
    // makes the text-only fallback reachable rather than theoretical.
    const raced = await Promise.race([
      pending,
      timeoutAfter(HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS),
    ]);
    if (raced === TIMED_OUT) {
      // The import is still running, and it is not cancellable. Its budget
      // reservation has no other owner from here - the winning path below is
      // the only code that would have released it - so an outstanding charge
      // would sit against this window's image budget for the rest of the
      // session, refusing later pastes for bytes nothing references.
      const readsSettled = pending.then((outcome) => {
        if (outcome.kind === "imported") outcome.result.reservation.release();
      });
      // Awaited INSIDE the try on purpose: a rejection from the text-only path
      // must reach the catch below, not escape to the caller.
      const draftId = await installTextOnly({ ...args, cause: "timed-out" });
      return { draftId, readsSettled };
    }
    if (raced.kind === "failed") throw raced.error;
    // A budget refusal, not a read failure - the words are still here and the
    // images are the only loss, so it takes the same text-only install rather
    // than throwing.
    if (raced.kind === "refused") {
      const draftId = await installTextOnly({ ...args, cause: "capacity" });
      return { draftId, readsSettled: Promise.resolve() };
    }
    try {
      const draftId = installHandoffDraft({
        content: raced.result.content,
        stillCurrent: args.stillCurrent,
        qualification: teardownQualification({
          reason: args.reason,
          // Inline images whose format the host's writer will not accept are
          // the only loss on this path: everything else was materialized into
          // the landing partition above.
          droppedImages: raced.droppedInline,
          droppedImageCause: raced.droppedInline > 0 ? "unsupported" : null,
          // The sidecar is dropped unconditionally: a landing draft has no
          // annotation sidecar to carry it in (M02). A record's comment, the
          // page it was taken on and which elements were marked are none of
          // them in the document text, and a draft that looks complete is how
          // the user finds that out far too late, if at all - so the count is
          // stated instead.
          droppedAnnotations: args.browserAnnotations.length,
        }),
      });
      return { draftId, readsSettled: Promise.resolve() };
    } finally {
      // Always: an install that threw must not pin the reservation for the
      // rest of the session.
      raced.result.reservation.release();
    }
  } catch (error: unknown) {
    const draftId = await installTextOnly({ ...args, cause: causeOf(error) });
    // The import either settled (that is how we got here) or has already had
    // its reservation released by the `finally` above.
    return { draftId, readsSettled: Promise.resolve() };
  }
}

/**
 * Materialize every image the prompt carries into this window's landing
 * partition, and answer content that names only landing hashes.
 *
 * Two kinds arrive here and only one of them used to be handled. A HASHED node
 * names bytes the resolver can fetch. An INLINE node carries its bytes in
 * `attrs.b64content` and no resolver is ever consulted for it - and both
 * landing persistence seams (`partialize` and the desktop per-window
 * projection) STRIP such a node, because ordinarily it is a paste whose
 * background rewrite has not landed yet. A closed handoff draft has no mounted
 * editor to finish that rewrite, so an inline node installed as-is is a picture
 * that survives in memory and is gone after a reload, with the draft claiming
 * nothing was lost. Production reaches this: `use-composer-pending-image-ingest`
 * deliberately leaves an unsupported-format or budget-refused image inline.
 *
 * So inline bytes are decoded and given a real content address here, BEFORE the
 * import, which then treats them exactly like any other hashed atom. A format
 * the host's writer will not accept cannot be given one - it would name a hash
 * the partition may never be allowed to hold - so it is dropped and counted.
 */
async function resolveHandoffImages(
  content: JsonContent,
  readHashImage: HandoffImageResolver,
): Promise<ImportOutcome> {
  try {
    const inline = await materializeInlineImages(content);
    const readBlob = blobReaderFor(readHashImage, inline.bytesByHash);
    const result = await importImagesIntoLanding({
      content: inline.content,
      blobHashes: blobHashesFromContent(inline.content),
      readBlob,
      draftId: null,
    });
    return result === null
      ? { kind: "refused", droppedInline: inline.dropped }
      : { kind: "imported", result, droppedInline: inline.dropped };
  } catch (error: unknown) {
    return { kind: "failed", error };
  }
}

interface InlineMaterialization {
  /** `content` with every inline image node either hashed or removed. */
  readonly content: JsonContent;
  /** Bytes for the hashes this pass minted, for the import's `readBlob`. */
  readonly bytesByHash: ReadonlyMap<string, ImageBlob>;
  /** Inline nodes removed because their format is not host-storable. */
  readonly dropped: number;
}

async function materializeInlineImages(
  content: JsonContent,
): Promise<InlineMaterialization> {
  const bytesByHash = new Map<string, ImageBlob>();
  let dropped = 0;

  const visit = async (node: JsonContent): Promise<JsonContent | null> => {
    if (node.type === "imageAttachment") {
      const b64 = stringValue(node.attrs?.b64content);
      // Already hashed: the import's ordinary path owns it.
      if (b64 === null) return node;
      // DECLARED, never sniffed - `host-storable-image-formats` states why:
      // the authority on format is the host's writer, and a second opinion
      // here would make the two disagree about the same node.
      const mimeType =
        stringValue(node.attrs?.mimeType) ?? DEFAULT_IMAGE_MIME_TYPE;
      const bytes = isHostStorableImageMimeType(mimeType)
        ? base64ToBytes(b64)
        : null;
      if (bytes === null) {
        dropped += 1;
        return null;
      }
      const hash = await sha256Hex(bytes);
      bytesByHash.set(hash, { bytes, mimeType });
      return {
        ...node,
        attrs: {
          ...node.attrs,
          b64content: null,
          hash,
          mimeType,
          // From the BYTES. The import verifies the node's declared size
          // against the blob it resolves and calls a disagreement corruption,
          // and an inline node's `size` attr is whatever the paste recorded.
          size: bytes.byteLength,
        },
      };
    }
    if (node.content === undefined) return node;
    const children: JsonContent[] = [];
    for (const child of node.content) {
      const kept = await visit(child);
      if (kept !== null) children.push(kept);
    }
    // An attachment group emptied by the drops above would render as a blank
    // strip; `stripBase64ImageNodes` removes one for the same reason.
    if (node.type === "attachmentGroup" && children.length === 0) return null;
    return { ...node, content: children };
  };

  const visited = await visit(content);
  return {
    content: visited ?? content,
    bytesByHash,
    dropped,
  };
}

/**
 * The same handoff with every image REMOVED - inline and hash alike.
 *
 * Separate and explicit, because the previous shape induced this path by
 * passing a resolver that returns `null` and relying on the import to fail.
 * That does not work for an INLINE image: its bytes ride in `attrs.b64content`
 * and no resolver is consulted for it at all, so the import succeeds with the
 * bytes still in the document and a capacity refusal repeats forever - losing
 * the words to protect a picture, which is the one trade this module exists to
 * refuse. Stripping is a decision, so it is expressed as one.
 */
export interface TextOnlyPromptHandoffInput {
  readonly content: JsonContent;
  /**
   * The sidecar this path is about to drop. It cannot be carried - a landing
   * draft owns no sidecar - but the COUNT is what lets the draft say so
   * instead of looking complete.
   */
  readonly browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>;
  readonly reason: string;
  readonly cause: DroppedImageCause;
  readonly stillCurrent: () => boolean;
}

export function buildTextOnlyPromptHandoff(
  args: TextOnlyPromptHandoffInput,
): Promise<PromptHandoffOutcome> {
  // Reads NOTHING, so its settlement is immediate - the caller's image roots
  // are free the moment this returns.
  return installTextOnly(args).then((draftId) => ({
    draftId,
    readsSettled: Promise.resolve(),
  }));
}

/**
 * The bare install, for the callers inside this module that already know what
 * to say about the reads they started.
 *
 * `installHandoffDraft` is synchronous, so nothing here is genuinely awaited -
 * the `try`/`catch` exists so a throw from `installLandingDraft` reaches the
 * caller as a rejection instead of unwinding synchronously through it.
 */
function installTextOnly(
  args: TextOnlyPromptHandoffInput,
): Promise<string | null> {
  const stripped = withoutImageAttachments(args.content);
  try {
    return Promise.resolve(
      installHandoffDraft({
        content: stripped.content,
        stillCurrent: args.stillCurrent,
        qualification: teardownQualification({
          reason: args.reason,
          droppedImages: stripped.dropped,
          droppedImageCause: args.cause,
          // EVERY record, not a subset: this path carries no images at all,
          // so there is nothing for a record to name.
          droppedAnnotations: args.browserAnnotations.length,
        }),
      }),
    );
  } catch (error: unknown) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * The install itself: a closed start-page draft, timestamped now so it sorts
 * to the top of the Drafts list the user will go looking in.
 *
 * The same shape `stash-migration.ts` installs a converted entry with, and for
 * the same reason - a put-away row with no workspace and this window's global
 * run settings is what a draft with no surface behind it is.
 */
function installHandoffDraft(args: {
  readonly content: JsonContent;
  readonly qualification: string;
  readonly stillCurrent: () => boolean;
}): string | null {
  // SYNCHRONOUS with the install, with no await between them. The fence is
  // about WHO this text belongs to, and the image reads above it are long
  // enough for a sign-out to land: installing then would file the outgoing
  // account's private prompt in the incoming account's drafts list, and root
  // its images in that account's partition.
  if (!args.stillCurrent()) return null;
  const draftId = mintDraftId();
  useLandingDraftStore.getState().installLandingDraft({
    id: draftId,
    content: withTrailingParagraph(args.content, args.qualification),
    selection: null,
    lastTouchedAt: Date.now(),
    settings: useComposerRunSettingsStore
      .getState()
      .getGlobalRunSettings(readComposerHostIdSnapshot()),
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    closed: true,
  });
  return draftId;
}

/**
 * Adapts the caller's byte resolver to the blob reader `importImagesIntoLanding`
 * wants, with the inline pass's own bytes in front of it.
 *
 * For a hash the resolver answers, the MIME is sniffed from the BYTES rather
 * than taken from the node's `mimeType` attr, and with no fallback: the import verifies the two against
 * each other and treats a disagreement as corruption, so a label this side
 * cannot justify is a document that fails the whole import. Bytes that sniff
 * to nothing are reported as absent, which routes them to the text-only path
 * with the words intact.
 */
function blobReaderFor(
  readHashImage: HandoffImageResolver,
  inlineBytesByHash: ReadonlyMap<string, ImageBlob>,
): (hash: string) => Promise<ImageBlob | null> {
  return async (hash: string): Promise<ImageBlob | null> => {
    // The inline pass minted this hash from bytes it is still holding, and
    // those bytes are in no store yet - the resolver would answer `null` for
    // it and take the whole document to the text-only path.
    const materialized = inlineBytesByHash.get(hash);
    if (materialized !== undefined) return materialized;
    const bytes = await readHashImage(hash);
    if (bytes === null) return null;
    const mimeType = sniffImageMimeType(bytes);
    if (mimeType === null) return null;
    return { bytes, mimeType };
  };
}

/**
 * The trailing sentence, stating exactly what this draft could not take.
 *
 * One builder for both paths so the two cannot drift into describing the same
 * loss differently - and so a NEW kind of loss has one place to be added.
 */
function teardownQualification(args: {
  readonly reason: string;
  readonly droppedImages: number;
  readonly droppedImageCause: DroppedImageCause | null;
  readonly droppedAnnotations: number;
}): string {
  const clauses: string[] = [];
  if (args.droppedImages > 0 && args.droppedImageCause !== null) {
    const subject =
      args.droppedImages === 1
        ? "An image was"
        : `${args.droppedImages} images were`;
    clauses.push(
      `${subject} not saved with it: ${DROPPED_IMAGE_CLAUSE[args.droppedImageCause]}.`,
    );
  }
  if (args.droppedAnnotations > 0) {
    const subject =
      args.droppedAnnotations === 1
        ? "A browser annotation was"
        : `${args.droppedAnnotations} browser annotations were`;
    // NO reason, on either path, because neither one has the annotation's -
    // and now neither one could carry the record anyway. A landing draft has
    // no annotation sidecar, so records are dropped here as a STRUCTURAL
    // decision rather than a failure of these particular bytes.
    //
    // The text-only path looks like it knows - it has a `DroppedImageCause` -
    // but that cause belongs to the DOCUMENT image, and reusing it blames the
    // crop for something that did not happen to it. A wrong reason is worse
    // than none: it points the reader at a remedy that does not apply.
    clauses.push(`${subject} not saved with it.`);
  }
  return [`Unsent — ${args.reason}`, ...clauses].join(" ");
}

/**
 * `ImageBlobCorruptError` and anything else the import raises land on
 * `"unprepared"` together: what the reader needs is "the picture did not come
 * with it", and a corrupt blob is not a fact they can act on differently.
 */
function causeOf(error: unknown): DroppedImageCause {
  if (error instanceof ImageBlobMissingError) return "missing";
  return "unprepared";
}

function withTrailingParagraph(
  content: JsonContent,
  text: string,
): JsonContent {
  return {
    ...content,
    content: [
      ...(content.content ?? []),
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  };
}

function withoutImageAttachments(node: JsonContent): {
  readonly content: JsonContent;
  readonly dropped: number;
} {
  if (node.content === undefined) return { content: node, dropped: 0 };
  const kept: JsonContent[] = [];
  let dropped = 0;
  for (const child of node.content) {
    if (child.type === "imageAttachment") {
      dropped += 1;
      continue;
    }
    const inner = withoutImageAttachments(child);
    dropped += inner.dropped;
    kept.push(inner.content);
  }
  return { content: { ...node, content: kept }, dropped };
}
