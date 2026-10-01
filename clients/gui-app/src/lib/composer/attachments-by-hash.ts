/**
 * The CREATE side of "which image nodes may travel to the host by hash", plus
 * the plan/confirm steps any surface runs before it puts a hash on the wire.
 *
 * ## The name is wider than the module
 *
 * It used to own both halves. The SEND half is gone: `chat.subscribe@1.12`
 * moved send-path materialization behind
 * `ChatStreamClient.draftBlobBridgeSupported()`, and the inlining that used to
 * back it out now lives in three modules of its own —
 * `lib/composer/image-atoms.ts` (which nodes are hash-only, and the rewrite
 * that puts bytes back), `lib/drafts/resolve-draft-image-bytes.ts` (local →
 * host → cloud byte resolution) and `lib/drafts/draft-image-inlining.ts` (the
 * bounded reconcile that keeps a document's required set exact across the
 * await). Nothing here decides anything about a send's wire shape any more.
 * The name is kept for this merge; read this paragraph, not the file name.
 *
 * ## What is left
 *
 * **The create capability gate.** A host on `epic.create@1.2` /
 * `epic.createChat@1.2` (with `attachmentsByHash: true`) resolves a hash-only
 * node out of the requester's draft blob tier; anything older needs the bytes
 * inline. Two facts decide it and both must hold, FAILING CLOSED on every
 * non-version answer: the negotiated minor of the unary method the create is
 * dispatched on, and the host not withholding `drafts.putBlob` — without the
 * upload channel there is no staging tier to resolve out of.
 *
 * **The per-node verdict.** `ImageAttachmentAttrs.byHashEligible`, recorded by
 * the preparer at paste. The host's staging install refuses SVG and every
 * payload it cannot model as a raster image, so a node the preparer could not
 * model stays inline whatever the host negotiates — the
 * `missing-attachment-bytes` refusal is the backstop for that class, not the
 * rule.
 *
 * **The count cap**, which is not per node: the host refuses a create
 * referencing more than {@link MAX_CREATE_ATTACHMENT_HASHES} distinct hashes
 * with an `InvalidArgumentError` that has no UI arm anywhere, so both create
 * surfaces check it themselves and {@link reportCreateAttachmentHashCapExceeded}
 * puts a sentence in front of the user instead.
 *
 * **Plan and confirm** ({@link planAttachmentsByHash},
 * {@link confirmAttachmentsByHash}), which are NOT create-only despite the rest
 * of this file: they split a document's hashes and make sure the host holds the
 * bytes for the ones travelling by hash. The chat session store and the queued
 * prompt repair drive them too, because "has the host got these bytes" is the
 * same question wherever a hash is about to be sent.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";
import { toast } from "sonner";

import { imageAttachmentByHashEligible } from "@/lib/composer/image-atoms";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import {
  hostWithholdsDraftBlobs,
  isDraftBlobConfirmed,
  putDraftBlobsWithProgress,
  type DraftBlobClient,
  type DraftBlobUploadProgressListener,
} from "@/lib/drafts/draft-blob-transport";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/**
 * How many distinct hashes one create may reference.
 *
 * MIRRORS the host's `MAX_CREATE_ATTACHMENT_HASHES`
 * (`traycer-host/src/transport/rpc/resolvers/epic/create-attachment-resolution.ts`),
 * which refuses more as an `InvalidArgumentError` before it probes anything.
 * That refusal is deliberately NOT the `missing-attachment-bytes` kind - its
 * remedy is "re-upload and retry", which for an oversized request would loop -
 * so it arrives as a bare RPC error with no typed arm to render. Checking here
 * keeps a request the host will certainly reject off the wire and puts a
 * sentence in front of the user instead.
 *
 * Duplicated rather than imported because the constant lives in the internal
 * host repo and this is the OSS client; the two are pinned to each other by
 * this comment and by the host's own doc naming the client check.
 */
export const MAX_CREATE_ATTACHMENT_HASHES = 32;

/**
 * The `epic.create` / `epic.createChat` minor that carries
 * `attachmentsByHash`. Both methods grew the field on the same minor of the
 * same major, and it is the same minor that carries
 * `deferWorktreeProvisioning` - but the two gates stay separate functions
 * because a host can be told to resolve hashes without being asked to defer a
 * worktree, and reading one answer for both would tie the decisions together.
 */
export const CREATE_ATTACHMENTS_BY_HASH_MINOR = 2;

export type AttachmentsByHashCreateMethod = "epic.create" | "epic.createChat";

/**
 * Whether a create dispatched at `hostId` may send hash-only image nodes.
 *
 * FAILS CLOSED on both non-version answers from the unary reader - `null` (no
 * handshake yet, no bound client, or a name-only legacy manifest record) and
 * `false` (the host handshook and does not advertise the method) - and on a
 * host known to withhold the blob methods. Every one of those means the same
 * thing here: inline the bytes, exactly as before this change.
 */
export function createAttachmentsByHashSupported(
  hostId: string,
  method: AttachmentsByHashCreateMethod,
): boolean {
  if (hostWithholdsDraftBlobs(hostId)) return false;
  const version = readNegotiatedMethodVersion(hostId, method);
  if (version === null || version === false) return false;
  return (
    version.major === 1 && version.minor >= CREATE_ATTACHMENTS_BY_HASH_MINOR
  );
}

export interface AttachmentsByHashPlan {
  /** Distinct hashes on hash-only nodes the preparer marked by-hash eligible. */
  readonly eligible: ReadonlyArray<string>;
  /** Distinct hashes on hash-only nodes that must be inlined regardless. */
  readonly ineligible: ReadonlyArray<string>;
  /**
   * Whether some node carries BOTH `b64content` and a `hash` - the browser
   * annotation crop atom, which keeps its hash so the rendered message can
   * de-duplicate the crop by it.
   *
   * It matters because the HOST's hash collection
   * (`collectAttachmentHashes`) does not skip such a node: under
   * `attachmentsByHash` it would try to resolve that hash out of the staging
   * tier and, finding nothing, refuse the whole create. The node cannot be
   * inlined away (it already is inline; clearing its hash breaks the dedupe),
   * so the only safe answer for a message containing one is to send the whole
   * message the old way. No create surface produces crops today - only the
   * in-epic chat composer does - which is why this is a flag rather than a
   * per-node arm.
   */
  readonly hasInlineHashedNode: boolean;
}

/**
 * Split a document's image hashes into the ones that may travel by hash and the
 * ones that must be inlined.
 *
 * A hash that appears on an eligible AND an ineligible node lands in
 * `ineligible`: inlining is per HASH (`inlineHashOnlyImageBytes` rewrites every node
 * carrying it), so the two nodes cannot take different paths and the safe
 * answer is the one that always works.
 */
export function planAttachmentsByHash(
  content: JsonContent,
): AttachmentsByHashPlan {
  const eligible = new Set<string>();
  const ineligible = new Set<string>();
  let hasInlineHashedNode = false;
  const visit = (node: JsonContent): void => {
    if (node.type === "imageAttachment") {
      const attrs = node.attrs;
      const hash = stringValue(attrs?.hash);
      if (hash !== null) {
        if (stringValue(attrs?.b64content) !== null) {
          hasInlineHashedNode = true;
        } else if (imageAttachmentByHashEligible(attrs?.byHashEligible)) {
          eligible.add(hash);
        } else {
          ineligible.add(hash);
        }
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(content);
  for (const hash of ineligible) eligible.delete(hash);
  return {
    eligible: [...eligible],
    ineligible: [...ineligible],
    hasInlineHashedNode,
  };
}

export interface ConfirmedAttachmentsByHash {
  /** Hashes the host holds: their nodes stay hash-only on the wire. */
  readonly byHash: ReadonlySet<string>;
  /** Hashes whose nodes this message must inline before it can be sent. */
  readonly inline: ReadonlyArray<string>;
}

/**
 * Make sure the host holds the bytes for every eligible hash, and report what
 * is left to inline.
 *
 * DIFFS REQUESTED AGAINST CONFIRMED rather than trusting the upload pass:
 * `putDraftBlobs` returns only the subset it got an ack for and silently skips
 * a hash with no local bytes, a digest mismatch, an over-cap blob or a failed
 * put, so a caller that assumed "asked for" meant "on the host" would send
 * hashes into a refusal.
 *
 * Already-confirmed hashes are not re-uploaded (see `confirmedBlobOwners`),
 * which is what makes the ordinary create - paste, then send - carry no
 * `drafts.putBlob` at submit at all.
 *
 * OWNER-KEYED, AND THE OWNER IS AN INPUT. A confirmation records which account
 * put the bytes there, so "does this host hold it" is only answerable together
 * with "for whom" - a `null` owner confirms nothing and every eligible hash
 * falls to `inline`, which is the correct answer for a window with no signed-in
 * account rather than a degenerate one. It arrives as a parameter rather than
 * being read from the auth store here because this is a leaf: its own suite
 * drives it with no store mounted, and a leaf that reaches for ambient state
 * cannot be tested without one. The create surfaces pass
 * `currentDraftBlobOwnerId()`.
 */
export async function confirmAttachmentsByHash(input: {
  readonly hostId: string;
  readonly client: DraftBlobClient;
  readonly plan: AttachmentsByHashPlan;
  readonly ownerUserId: string | null;
  /**
   * Upload progress for the surface that is waiting on it, or `null`. The
   * landing composer shows "k of N" from it; a surface with nowhere to put it
   * passes `null`. Only the digests this call actually sends are counted.
   */
  readonly onProgress: DraftBlobUploadProgressListener | null;
}): Promise<ConfirmedAttachmentsByHash> {
  const pending = input.plan.eligible.filter(
    (hash) => !isDraftBlobConfirmed(input.hostId, hash, input.ownerUserId),
  );
  if (pending.length > 0) {
    await putDraftBlobsWithProgress({
      hostId: input.hostId,
      client: input.client,
      hashes: pending,
      ownerUserId: input.ownerUserId,
      onProgress: input.onProgress,
    });
  }
  const byHash = new Set<string>();
  const inline: string[] = [...input.plan.ineligible];
  for (const hash of input.plan.eligible) {
    if (isDraftBlobConfirmed(input.hostId, hash, input.ownerUserId)) {
      byHash.add(hash);
      continue;
    }
    inline.push(hash);
  }
  return { byHash, inline };
}

/**
 * The count cap, checked against a set of hashes.
 *
 * TAKES THE HASHES RATHER THAN THE PLAN because the number that matters is the
 * one the HOST will count, and that is neither the plan's eligible set nor its
 * ineligible one. `collectAttachmentHashes` walks the content the create
 * actually carries and counts every `imageAttachment` still holding a `hash`,
 * eligibility being a client-side notion the host never sees. So the two
 * call sites pass two different things on purpose:
 *
 *  - BEFORE the upload, the plan's eligible set - a cheap early refusal that
 *    keeps an obviously oversized request off the wire and saves the disk work
 *    of uploading blobs for a create that cannot succeed. It is a fast path,
 *    not the decision: it can only ever see one of the two kinds of hash.
 *  - AFTER inlining, the hashes the send content still carries. This is the
 *    authoritative one, and it is the check the mixed document needs: one
 *    eligible image plus thirty-two hashes whose bytes are nowhere local
 *    inlines away to none of them, leaves thirty-three hashes on the wire and
 *    clears an eligible-only cap by a mile.
 *
 * `inlineHashOnlyImageBytes` clears the `hash` on every node it inlines, which is
 * makes the post-inlining count the host's count and not an approximation of it.
 * The one node the two would disagree about - base64 AND a hash, which the host
 * counts and `hashOnlyImageHashes` skips - cannot occur on this path:
 * `hasInlineHashedNode` sends that whole message the old way, with
 * `attachmentsByHash` off, and the host runs no cap check at all unless the flag
 * is on.
 */
export function exceedsCreateAttachmentHashCap(
  hashes: ReadonlyArray<string>,
): boolean {
  return hashes.length > MAX_CREATE_ATTACHMENT_HASHES;
}

/**
 * The refusal a create surface raises instead of letting the host's
 * `InvalidArgumentError` be the first thing the user hears about the cap.
 *
 * No hash and no id in the copy: a toast is pasted into support threads.
 */
export function reportCreateAttachmentHashCapExceeded(): void {
  toast.error("Too many images to attach.", {
    description: `A single message can carry at most ${String(
      MAX_CREATE_ATTACHMENT_HASHES,
    )} images. Remove some and try again.`,
  });
}
