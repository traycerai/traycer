/**
 * The hash-only image nodes a submit owes NOTHING for - the union of the two
 * ways a hash can already be in a durable owner's custody.
 *
 * This is deliberately one function rather than a second seam beside
 * `host-held-image-hashes`. Both sources answer the same question the submit
 * path asks once ("may this node travel as a bare hash?"), and a send that
 * consulted one of them in one place and the other somewhere else is a send
 * whose two halves can disagree.
 *
 *  1. **Inherited** - the surface was seeded from host content (a queue-edit,
 *     an inline message edit), so these hashes are already epic attachments.
 *     See `host-held-image-hashes.ts` for why re-inlining one is wrong.
 *  2. **Confirmed uploaded** - this client itself put the bytes on the host
 *     with `drafts.putBlob` and the host acknowledged holding them, for THIS
 *     host and THIS owner.
 *
 * ## What gates the second source, and why all three conditions
 *
 * `bridgeSupported` is the chat's OWN live stream's negotiated capability, not
 * an app-wide fact: a host can serve one chat on a stream that understands the
 * draft-blob bridge and another that does not. Sending a bare hash to a session
 * that cannot materialize it produces a refusal the user has to read, so the
 * flag is checked per send, from the session the send is going out on.
 *
 * `hostId` is the composer's target host, which is also the host its mirror
 * uploaded to - that equivalence is what makes the memo's answer relevant here
 * at all. A surface with no target host confirms nothing.
 *
 * A digest this host has refused by FORMAT is subtracted even when it is
 * otherwise confirmed. The two can both be true after a host downgrade, and the
 * refusal is the more recent and more specific fact.
 *
 * ## Recomputed, never captured
 *
 * The submit path reads this twice - once before its async leg and once in the
 * live re-read that decides the final required set - and both reads must see
 * the state as of NOW. An upload confirmed while the annotation images were
 * resolving should let its node travel bare; a confirmation invalidated by a
 * refusal in that window must not. Capturing one set up front would freeze the
 * answer at the wrong moment, in whichever direction happened to apply.
 *
 * The failure directions stay as `host-held-image-hashes` documents them: a
 * hash wrongly present is sent bare, which the host's dangling-hash guard
 * catches and the refusal path retries inline; a hash wrongly absent is
 * re-inlined, which only costs bytes. Neither loses an image.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerEditorIncarnation } from "@/lib/composer/composer-editor-incarnation";
import { hashOnlyImageHashes } from "@/lib/composer/image-atoms";
import { hostHeldImageHashes } from "@/lib/composer/host-held-image-hashes";
import {
  confirmedDraftBlobHashes,
  isDraftBlobUnbridgeable,
} from "@/lib/drafts/draft-blob-transport";

export interface SubmitHostHeldImageHashesArgs {
  /** The composer surface - a chat id, a message id. */
  readonly surfaceKey: string;
  readonly incarnation: ComposerEditorIncarnation | null;
  /** The document being sent, read live at each call. */
  readonly content: JsonContent;
  /** The composer's target host, or `null` where the surface owns placement. */
  readonly hostId: string | null;
  /** This chat's own live stream's draft-blob bridge capability (T1). */
  readonly bridgeSupported: boolean;
  readonly ownerUserId: string | null;
}

export function submitHostHeldImageHashes(
  args: SubmitHostHeldImageHashesArgs,
): ReadonlySet<string> {
  const inherited = hostHeldImageHashes(args.surfaceKey, args.incarnation);
  if (!args.bridgeSupported || args.hostId === null) return inherited;
  const hostId = args.hostId;
  const confirmed = confirmedDraftBlobHashes(
    hostId,
    args.ownerUserId,
    hashOnlyImageHashes(args.content),
  );
  if (confirmed.size === 0) return inherited;
  const held = new Set(inherited);
  for (const hash of confirmed) {
    if (isDraftBlobUnbridgeable(hostId, hash)) continue;
    held.add(hash);
  }
  return held;
}
