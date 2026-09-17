/**
 * Which of a composer surface's hash-only image nodes are already in a DURABLE
 * owner's custody on the host, and so must be sent as a bare hash rather than
 * re-inlined at submit.
 *
 * ## Why the submit path needs this at all
 *
 * Submit's rule is "resolve every hash-only image node's bytes and re-inline
 * them, so the send carries what it has always carried". That rule is right for
 * a node this client MINTED - a paste whose bytes only ever existed in this
 * window's image partition and the host's draft blob store. It is wrong for a
 * node the surface INHERITED from the host, because those already exist in the
 * epic attachment store: re-inlining one would put megabytes of base64 back on
 * a wire that has been carrying a 64-character hash for as long as message
 * editing has existed.
 *
 * Two surfaces inherit such content today, before any of this work makes a
 * composer produce a hash-only node of its own:
 *
 *  - the inline message editor, seeded from the sent message's
 *    `structuredContent` (`use-chat-message-actions.ts`'s `beginInlineEdit`);
 *  - the chat composer in queue-edit mode, seeded from the queued prompt's
 *    content (`use-chat-queue-actions.ts`'s `editQueuedItem`).
 *
 * ## What "host-held" means, and what it deliberately does not
 *
 * It means: some durable owner other than this client is known to hold these
 * bytes, so the client owes the send nothing. It is NOT a claim that the send
 * will succeed - the host's dangling-hash guard remains the only authority on
 * that, and its refusal is the message the user acts on. That asymmetry is what
 * makes the failure modes here safe in the right direction: a hash wrongly left
 * in the set is sent bare, which is exactly today's behaviour; a hash wrongly
 * ABSENT from the set is re-inlined, which costs bytes. Neither loses an image.
 *
 * The set is also the seam the hash-only send gate extends rather than
 * replaces: a confirmed `drafts.putBlob` for this host and owner is a second
 * way for a hash to become host-held, added on top of the seeding below once
 * the bridge flag says the host can resolve it.
 *
 * ## Keying
 *
 * Per surface (a chat id, a message id), and per editor INCARNATION where the
 * caller has one. A surface whose editor was torn down and recreated is holding
 * a document that was re-seeded from somewhere, so an incarnation mismatch
 * answers empty rather than carrying a previous editor's inheritance forward.
 * Callers with no incarnation to name pass `null`, which matches any.
 */
import type { ComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";

interface HostHeldEntry {
  readonly incarnation: ComposerEditorIncarnation | null;
  readonly hashes: ReadonlySet<string>;
}

const entriesBySurface = new Map<string, HostHeldEntry>();

/**
 * For a surface that inherits nothing - the new-conversation modal, a fresh
 * chat draft. Shared so those call sites read as a deliberate "nothing is
 * host-held here" rather than an inline empty set nobody can search for.
 */
export const NO_HOST_HELD_HASHES: ReadonlySet<string> = new Set<string>();

const NO_HASHES = NO_HOST_HELD_HASHES;

/**
 * Replace this surface's host-held set. Called wherever a surface takes on
 * content that came from the host - the seeding points named in the module doc.
 */
export function setHostHeldImageHashes(
  surfaceKey: string,
  incarnation: ComposerEditorIncarnation | null,
  hashes: ReadonlyArray<string>,
): void {
  if (hashes.length === 0) {
    entriesBySurface.delete(surfaceKey);
    return;
  }
  entriesBySurface.set(surfaceKey, {
    incarnation,
    hashes: new Set(hashes),
  });
}

/**
 * This surface's host-held set for `incarnation`, or an empty set when the
 * surface has none or the entry belongs to a different editor incarnation.
 */
export function hostHeldImageHashes(
  surfaceKey: string,
  incarnation: ComposerEditorIncarnation | null,
): ReadonlySet<string> {
  const entry = entriesBySurface.get(surfaceKey);
  if (entry === undefined) return NO_HASHES;
  if (
    entry.incarnation !== null &&
    incarnation !== null &&
    entry.incarnation !== incarnation
  ) {
    return NO_HASHES;
  }
  return entry.hashes;
}

/**
 * Forget this surface's set - its inherited content was replaced or sent.
 *
 * Hygiene rather than correctness: a stale entry only ever leaves a hash bare
 * on a send, which is the behaviour that predates all of this. Clearing keeps
 * the map from accumulating a row per chat ever queue-edited.
 */
export function clearHostHeldImageHashes(surfaceKey: string): void {
  entriesBySurface.delete(surfaceKey);
}

export function __resetHostHeldImageHashesForTests(): void {
  entriesBySurface.clear();
}
