/**
 * Submit's half of draft-image custody: turning a document's hash-only image
 * nodes back into the inline `b64content` nodes the wire has always carried.
 *
 * ## The rule
 *
 * Every hash-only image node is re-inlined, EXCEPT one whose hash is already in
 * a durable owner's custody on the host (see `host-held-image-hashes.ts`) -
 * those are sent bare, exactly as an edited or queue-edited message's images
 * have always been sent. A node whose bytes resolve NOWHERE is left hash-only
 * too, and the host's dangling-hash guard decides what happens to it. The
 * client never refuses a send because its own replica came up empty.
 *
 * ## Two functions, not one, because of the re-read
 *
 * Resolution is asynchronous and the user keeps typing through it. Every submit
 * surface therefore applies the same contract the chat composer's annotation
 * read already applies: re-read the LIVE document after the await, send that,
 * and clear only what was sent. So the resolution step hands back a
 * hash -> base64 MAP rather than a rewritten document - the document it was
 * given is stale by construction, and only the map survives the wait.
 * {@link inlineHashOnlyImageBytes} then applies it to the re-read document,
 * where a node that appeared during resolution keeps whatever payload it has:
 * inline stays inline, and a hash nothing resolved is left for the host's
 * guard.
 *
 * ## Why a separate "needed" predicate
 *
 * `draftImageInliningNeeded` exists so the three submit surfaces can keep their
 * existing SYNCHRONOUS path byte-for-byte whenever there is nothing to resolve -
 * which is every send whose images were pasted inline, i.e. all of them until a
 * composer starts minting hashes. Introducing an `await` into a submit that
 * does not need one would reorder every write that submit makes relative to the
 * user's next keystroke, for no gain.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { hashOnlyImageHashes } from "@/lib/composer/image-atoms";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { appLogger } from "@/lib/logger";

import {
  resolveDraftImageBytes,
  type DraftImageByteTarget,
} from "./resolve-draft-image-bytes";

/**
 * Which of this document's hash-only image nodes this client still owes bytes
 * for. Empty means the send can proceed with no `await` at all.
 */
export function draftImageInliningNeeded(
  content: JsonContent,
  hostHeldHashes: ReadonlySet<string>,
): ReadonlyArray<string> {
  return hashOnlyImageHashes(content).filter(
    (hash) => !hostHeldHashes.has(hash),
  );
}

/**
 * Resolve each hash to base64, dropping the ones that resolve nowhere.
 *
 * Per hash and in parallel: these are independent reads, and a document with
 * several images must not pay a host round trip serially for each. A miss is
 * simply absent from the map, which leaves its node hash-only downstream.
 */
async function resolveInto(
  base64ByHash: Map<string, string>,
  hashes: ReadonlyArray<string>,
  target: DraftImageByteTarget,
): Promise<void> {
  await Promise.all(
    hashes.map(async (hash) => {
      const bytes = await resolveDraftImageBytes(hash, target);
      if (bytes !== null) base64ByHash.set(hash, bytesToBase64(bytes));
    }),
  );
}

/**
 * The livelock bound on reconcile passes.
 *
 * Deliberately high. It was two when it was doing double duty as a "surely the
 * user cannot paste faster than this" heuristic; that reading was wrong, since
 * exhausting it silently sent an image nobody had asked the resolver for. Now
 * that exhaustion is an explicit, named outcome, the only job left is to stop an
 * adversarial or looping producer from holding a send open forever - and for
 * that, a number no human reaches with pastes is the right one.
 */
const MAX_RECONCILE_PASSES = 6;

/**
 * Resolve bytes for the images a document needs, re-checking the LIVE document
 * after every pass, and hand the result to `commit` in the SAME synchronous
 * step as the final check.
 *
 * ## Why `commit` is a callback and not a return value
 *
 * Returning the map would put an `await` between this function's last read of
 * the required set and the caller's own final read of the document - and a
 * queued editor rewrite runs in exactly that microtask. The earlier shape had
 * a comment claiming there was "no await in between"; there was one, and it was
 * the return itself. Passing the send in as a callback is what makes the claim
 * true: from `readRequiredHashes()` to `commit(...)` there is no suspension
 * point, so the document `commit` re-reads is the one just certified.
 *
 * The caller must therefore do ALL of its other awaiting BEFORE calling this -
 * the chat composer's annotation read included. An await left running in
 * parallel is another window for an image to arrive unattended, which is how a
 * late paste survived the first version of this.
 *
 * ## What `commit` is handed
 *
 * Every hash that resolved. A hash that is absent either MISSED every byte
 * source or was never attempted, and at the bound those two become
 * indistinguishable - which is why the bound is now high enough that reaching
 * it means something is wrong rather than someone typed quickly.
 *
 * ## At the bound
 *
 * The send still goes, with the unattempted nodes left exactly as they are.
 * That is the plan's rule, not an oversight: the host's dangling-hash guard is
 * the authority on whether a hash-only node may be sent, and the client never
 * refuses a send on its own replica's say-so. The warning below is the only
 * thing that distinguishes this from an ordinary miss, and it is there because
 * reaching the bound is a livelock signal worth seeing in a log.
 */
export async function prepareDraftImageInlining(args: {
  readonly initialHashes: ReadonlyArray<string>;
  readonly target: DraftImageByteTarget;
  /**
   * The live document's hash-only images MINUS anything host-held - the same
   * predicate the first pass was built from, so an inherited hash is never
   * dragged into resolution by a later pass. Must be synchronous.
   */
  readonly readRequiredHashes: () => ReadonlyArray<string>;
  /** Runs synchronously after the final required-set read. */
  readonly commit: (base64ByHash: ReadonlyMap<string, string>) => void;
}): Promise<void> {
  const base64ByHash = new Map<string, string>();
  const attempted = new Set<string>();
  let hashes = args.initialHashes;
  for (let pass = 0; ; pass += 1) {
    for (const hash of hashes) attempted.add(hash);
    // The ONLY suspension point in this loop.
    await resolveInto(base64ByHash, hashes, args.target);
    const missing = args
      .readRequiredHashes()
      .filter((hash) => !attempted.has(hash));
    if (missing.length === 0) {
      args.commit(base64ByHash);
      return;
    }
    if (pass >= MAX_RECONCILE_PASSES) {
      appLogger.warn(
        "[draft-image] reconcile bound reached; sending with unattempted images",
        { unattempted: missing.length, passes: pass + 1 },
      );
      args.commit(base64ByHash);
      return;
    }
    hashes = missing;
  }
}
