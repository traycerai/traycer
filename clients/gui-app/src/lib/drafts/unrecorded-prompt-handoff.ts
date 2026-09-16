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
 * ## Why the prompt stash
 *
 * It already is the application's durable, user-visible home for an unsent
 * prompt: IndexedDB-backed, listed in its own UI, restorable into any
 * composer, and explicitly built to survive a session ending. Inventing a
 * second place would mean inventing a second UI for finding it.
 *
 * ## Why this goes through `buildPromptStashSnapshot`
 *
 * The first version of this module built the entry by hand - it spread the
 * document, appended a paragraph, derived `blobHashes` from the content, and
 * passed `imagesByHash: new Map()` on the theory that the bytes were already
 * in this window's image partition and the repository would find them there.
 *
 * **It does not.** `savePromptStashSnapshot` iterates `entry.blobHashes` and,
 * for any hash not already in its OWN blob table, reads `snapshot.imagesByHash`
 * and throws when it is absent. An empty map therefore threw for exactly the
 * prompts this module exists to save - hash-only sends, which by definition
 * carry an image - and because the caller can only fire-and-forget at
 * teardown, the rejection was swallowed and NOTHING survived, the text
 * included. The handoff was inert, and a mocked `save` could not see it.
 *
 * So the document is prepared the way the stash's own capture path prepares
 * one: `buildPromptStashSnapshot` resolves every image through the caller's
 * resolver, canonicalizes the bytes, re-hashes them and returns a snapshot
 * whose `blobHashes` and `imagesByHash` agree. That is also what makes a
 * restored entry materialize rather than reload as unavailable.
 *
 * ## What survives when the bytes do not
 *
 * A hash whose bytes are genuinely gone from this device fails the whole
 * snapshot, which would put us back to losing the text. So an unresolvable
 * document is retried with its image nodes DROPPED, and the qualification says
 * how many went. Losing the images is bad; losing the words the user typed is
 * the failure this module exists to prevent.
 *
 * ## Why the qualification is written into the document
 *
 * `PromptStashEntry` is `{ id, createdAt, content, blobHashes }` - it has no
 * field for a reason or a workspace. The qualification therefore goes into the
 * document itself, as a trailing paragraph. That is deliberate rather than a
 * workaround: the stash's restore path drops it straight into a composer, so
 * anything not in `content` would be invisible at exactly the moment the user
 * is deciding whether to resend. A stashed prompt whose worktree is unstated
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

import {
  buildPromptStashSnapshot,
  PromptStashImagePreparationError,
  PromptStashImageUnavailableError,
  type PromptStashImageResolver,
} from "@/lib/composer/prompt-stash-content";
import { PromptStashCapacityExceededError } from "@/lib/composer/prompt-stash-repository";
import type { PromptStashSnapshot } from "@/lib/composer/prompt-stash-codec";

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

/**
 * Why a handoff could not keep its images. Each maps to a different sentence,
 * because "we dropped your picture" and "we could not find your picture" are
 * different facts and a reader deciding whether to resend needs the right one.
 */
export type DroppedImageCause =
  | "missing"
  | "timed-out"
  | "too-large"
  | "capacity"
  | "unprepared";

const DROPPED_IMAGE_CLAUSE: Readonly<Record<DroppedImageCause, string>> = {
  missing: "the bytes are no longer on this device",
  "timed-out": "the bytes could not be read in time",
  "too-large": "it was over the size limit for a stashed image",
  capacity: "it did not fit in the prompt stash",
  unprepared: "it could not be prepared for the stash",
};

/**
 * Build the stash snapshot for a prompt being handed off at teardown.
 *
 * `reason` is the already-qualified account text. Rejects only if even the
 * text-only fallback cannot be built, which the caller treats as unrecoverable.
 */
export async function buildUnrecordedPromptHandoff(args: {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent;
  readonly reason: string;
  readonly readHashImage: PromptStashImageResolver;
}): Promise<PromptStashSnapshot> {
  try {
    // BOUNDED. `readHashImage` reaches the host for a digest this window does
    // not hold locally, and that read can hang - it is the same leg
    // `RECOVERY_INLINING_TIMEOUT_MS` exists to bound on the retry path. An
    // unbounded wait here does not degrade the handoff, it CANCELS it: the
    // chain never settles, `save` is never called, and the prompt is lost as
    // silently as if nothing had been written at all. The deadline is what
    // makes the text-only fallback reachable rather than theoretical.
    const withImages = await Promise.race([
      buildPromptStashSnapshot({
        id: args.id,
        createdAt: args.createdAt,
        content: args.content,
        // A handoff prompt is a SEND that never landed, not a composer draft:
        // it was detached from the composer - and from the annotation sidecar
        // that lives there - at submit. There is nothing to carry.
        annotations: [],
        readHashImage: args.readHashImage,
      }),
      timeoutAfter(HANDOFF_IMAGE_RESOLUTION_TIMEOUT_MS),
    ]);
    if (withImages === TIMED_OUT) {
      // Awaited INSIDE the try on purpose: a rejection from the text-only path
      // must reach the catch below, not escape to the caller.
      return await buildTextOnlyPromptHandoff({
        ...args,
        cause: "timed-out",
      });
    }
    return withQualification(withImages, `Unsent — ${args.reason}`);
  } catch (error: unknown) {
    return buildTextOnlyPromptHandoff({ ...args, cause: causeOf(error) });
  }
}

/**
 * The same handoff with every image REMOVED - inline and hash alike.
 *
 * Separate and explicit, because the previous shape induced this path by
 * passing a resolver that returns `null` and relying on the build to fail.
 * That does not work for an INLINE image: `resolveImageSource` reads
 * `attrs.b64content` before it ever consults the resolver, so the build
 * succeeds, the bytes go back in, and a capacity refusal repeats forever -
 * losing the words to protect a picture, which is the one trade this module
 * exists to refuse. Stripping is a decision, so it is expressed as one.
 */
export async function buildTextOnlyPromptHandoff(args: {
  readonly id: string;
  readonly createdAt: number;
  readonly content: JsonContent;
  readonly reason: string;
  readonly cause: DroppedImageCause;
}): Promise<PromptStashSnapshot> {
  const stripped = withoutImageAttachments(args.content);
  const snapshot = await buildPromptStashSnapshot({
    id: args.id,
    createdAt: args.createdAt,
    content: stripped.content,
    // Text-only by construction: the images are what this path drops, so
    // records describing them would name blobs the entry does not own.
    annotations: [],
    // Unreachable: `stripped.content` has no image nodes left to ask about.
    readHashImage: () => Promise.resolve(null),
  });
  if (stripped.dropped === 0) {
    return withQualification(snapshot, `Unsent — ${args.reason}`);
  }
  const subject =
    stripped.dropped === 1 ? "An image was" : `${stripped.dropped} images were`;
  return withQualification(
    snapshot,
    `Unsent — ${args.reason} ${subject} not saved with it: ${DROPPED_IMAGE_CLAUSE[args.cause]}.`,
  );
}

function causeOf(error: unknown): DroppedImageCause {
  if (error instanceof PromptStashImageUnavailableError) return "missing";
  if (error instanceof PromptStashCapacityExceededError) return "capacity";
  if (error instanceof PromptStashImagePreparationError) return "unprepared";
  // The repository's own inline-size guard throws a plain `Error`; its message
  // is the only signal, and getting this wrong only mislabels a sentence.
  if (error instanceof Error && error.message.includes("over the")) {
    return "too-large";
  }
  return "unprepared";
}

function withQualification(
  snapshot: PromptStashSnapshot,
  qualification: string,
): PromptStashSnapshot {
  return {
    entry: {
      ...snapshot.entry,
      content: withTrailingParagraph(snapshot.entry.content, qualification),
    },
    imagesByHash: snapshot.imagesByHash,
    droppedAnnotations: snapshot.droppedAnnotations,
  };
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
