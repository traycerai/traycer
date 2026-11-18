/**
 * Re-inline a REFUSED send's images so it can be sent once more, this time
 * carrying its bytes.
 *
 * This module exists to be the single hop between the chat session store and
 * the draft image resolver. The store needs re-inlined content to retry a
 * `MISSING_ATTACHMENT_BYTES` rejection; the resolver must stay a leaf that
 * knows nothing about chat sessions. Putting the call here keeps that boundary
 * intact - `chat-session-store.ts` imports this and nothing else from the
 * resolver's side of the tree.
 *
 * ## Frozen content, and what that buys
 *
 * The submit path re-reads its editor between resolving bytes and sending,
 * because the user can type during the read. Here there is no editor and no
 * user: the content is the `wireContent` frozen on the pending action when
 * the send went out, and nothing can change it. So `readRequiredHashes` is
 * constant, the reconcile loop settles after one pass by construction, and the
 * bounded-pass warning can never fire.
 *
 * It is still `prepareDraftImageInlining` rather than a hand-rolled loop, so
 * there is one inlining path with one set of leg-ordering, digest and
 * containment rules. A second implementation here would be a second place for
 * the cloud leg to be forgotten.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import {
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { prepareDraftImageInlining } from "@/lib/drafts/draft-image-inlining";

/**
 * The ceiling on one recovery's byte resolution. Generous against three real
 * legs (local, host blob, cloud blob) and short against a user noticing a chat
 * that will not park.
 */
export const RECOVERY_INLINING_TIMEOUT_MS = 30_000;

export interface DraftImageRetryContent {
  readonly content: JsonContent;
  /**
   * Digests no leg could answer, reported rather than acted on.
   *
   * The retry caller deliberately sends anyway: a document still carrying a
   * bare hash is refused a second time, and THAT refusal is loud because its
   * record is marked as the retry. Withholding the send here instead would
   * mean a second implementation of the surfacing path for a case the first
   * one already handles correctly, one round trip later.
   */
  readonly unresolved: ReadonlyArray<string>;
}

export async function reinlineRefusedSendContent(args: {
  readonly content: JsonContent;
  readonly hostId: string | null;
}): Promise<DraftImageRetryContent> {
  const hashes = hashOnlyImageHashes(args.content);
  if (hashes.length === 0) {
    return { content: args.content, unresolved: [] };
  }
  // PER-HASH, not one all-or-nothing wait. `prepareDraftImageInlining` commits
  // a single map only after its whole batch settles, so a deadline that fired
  // while ANY hash was stalled harvested an empty map - and a digest that had
  // answered in milliseconds went out bare beside the stalled one, forcing a
  // second refusal the host could have been spared.
  //
  // Each hash gets the shared deadline and contributes whatever it has when
  // the deadline passes. A late answer writes into a map nothing reads after
  // this point, so it can neither mutate the sent document nor trigger a
  // second send.
  const resolvedByHash = new Map<string, string>();
  // Disarmed once every hash has settled. A bare `setTimeout` keeps a live
  // timer - and in a fake-timer test, an unsettled promise - for the full
  // window after the work is done, which on the ordinary path is thirty
  // seconds of nothing.
  let disarmDeadline = (): void => undefined;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RECOVERY_INLINING_TIMEOUT_MS);
    disarmDeadline = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await Promise.all(
    hashes.map(async (hash) => {
      const one = prepareDraftImageInlining({
        initialHashes: [hash],
        target: draftImageByteTargetForHost(args.hostId),
        // Constant and single: the content is frozen, so this hash's required
        // set is exactly itself.
        readRequiredHashes: () => [hash],
        commit: (base64ByHash) => {
          const bytes = base64ByHash.get(hash);
          if (bytes !== undefined) resolvedByHash.set(hash, bytes);
        },
      });
      await Promise.race([one, deadline]);
    }),
  );
  disarmDeadline();
  const resolved: ReadonlyMap<string, string> = resolvedByHash;
  const unresolved = hashes.filter((hash) => !resolved.has(hash));
  return {
    content: inlineHashOnlyImageBytes(args.content, resolved),
    unresolved,
  };
}
