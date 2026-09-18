/**
 * Deciding, per message, which image nodes may travel to the host BY HASH.
 *
 * Every composer surface is hash-first: the bytes go to this window's composer
 * image store at paste and the node carries only a `hash`. What varies is what
 * the WIRE can take. A host on `epic.create@1.2` / `epic.createChat@1.2` (with
 * `attachmentsByHash: true`) or on `chat.subscribe@1.11` resolves a hash-only
 * node from the requester's draft blob tier; anything older needs the bytes
 * inline, which is what `composer-image-inlining.ts` puts back.
 *
 * Three facts decide it, and all three must hold for a node to go by hash:
 *
 *  1. The negotiated version of the method this message is dispatched on, read
 *     at dispatch and FAILING CLOSED on every non-version answer.
 *  2. The host is not withholding `drafts.putBlob` - without the upload channel
 *     there is no staging tier for the host to resolve out of.
 *  3. The NODE's own `byHashEligible`, the preparer's verdict recorded at paste
 *     (`ImageAttachmentAttrs.byHashEligible`). The host's staging install
 *     refuses SVG and every payload it cannot model as a raster image, so a
 *     node the preparer could not model must stay inline whatever the host
 *     negotiates - the `missing-attachment-bytes` refusal is the backstop for
 *     that class, not the rule.
 *
 * The count cap is the fourth fact and it is not per node: the host refuses a
 * create referencing more than {@link MAX_CREATE_ATTACHMENT_HASHES} distinct
 * hashes with an `InvalidArgumentError`, which has no UI arm anywhere. Both
 * create surfaces check it themselves so that refusal is never the user's first
 * notice.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";
import { toast } from "sonner";

import {
  inlineImageHashes,
  resolveImageBytes,
} from "@/lib/composer/composer-image-inlining";
import { imageAttachmentByHashEligible } from "@/lib/composer/image-atoms";
import { stringValue } from "@/lib/composer/tiptap-json-content";
import {
  draftBlobConfirmedOnHost,
  hostWithholdsDraftBlobs,
  putDraftBlobs,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { readNegotiatedStreamMethodVersion } from "@/lib/host/read-negotiated-stream-method-version";

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

/** The `chat.subscribe` minor whose `send` frame may carry hash-only nodes. */
export const SEND_ATTACHMENTS_BY_HASH_STREAM_MINOR = 11;

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

/**
 * Whether a `send` frame on `hostId`'s chat stream may carry hash-only nodes.
 *
 * Reads the host-keyed stream registry rather than a live session's own
 * negotiated version - reader (3) of the three that
 * `read-negotiated-stream-method-version.ts` ranks, where a SEND gate normally
 * takes reader (1). This is the gate that reader's docblock names as the
 * exception, and it qualifies on both of the conditions stated there:
 *
 *  A. the callers hold a `hostId` and no session, because they decide the
 *     document's SHAPE before the store hands it to one (the composer's submit,
 *     the handoff resend, the modal's create), and the divergence reader (3)
 *     allows is bounded by a session's lifetime - no session survives the host
 *     incarnation it negotiated against, on either plane;
 *  B. guessing high commits nothing. Hash-only content reaching a `@1.10`
 *     session comes back as the existing `MISSING_ATTACHMENT_BYTES` rejection,
 *     which surfaces and restores the prompt.
 *
 * Read the two conditions there before adding a caller: a gate that would
 * WRITE something under a contract the host predates fails B, and no amount of
 * plumbing awkwardness licenses reader (3) for it.
 */
export function sendAttachmentsByHashSupported(hostId: string): boolean {
  if (hostWithholdsDraftBlobs(hostId)) return false;
  const version = readNegotiatedStreamMethodVersion(hostId, "chat.subscribe");
  if (version === null) return false;
  return (
    version.major === 1 &&
    version.minor >= SEND_ATTACHMENTS_BY_HASH_STREAM_MINOR
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
 * `ineligible`: inlining is per HASH (`inlineImageHashes` rewrites every node
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
 * Already-confirmed hashes are not re-uploaded (see `confirmedBlobsByHost`),
 * which is what makes the ordinary create - paste, then send - carry no
 * `drafts.putBlob` at submit at all.
 */
export async function confirmAttachmentsByHash(input: {
  readonly hostId: string;
  readonly client: DraftBlobClient;
  readonly plan: AttachmentsByHashPlan;
}): Promise<ConfirmedAttachmentsByHash> {
  const pending = input.plan.eligible.filter(
    (hash) => !draftBlobConfirmedOnHost(input.hostId, hash),
  );
  if (pending.length > 0) {
    await putDraftBlobs(input.hostId, input.client, pending);
  }
  const byHash = new Set<string>();
  const inline: string[] = [...input.plan.ineligible];
  for (const hash of input.plan.eligible) {
    if (draftBlobConfirmedOnHost(input.hostId, hash)) {
      byHash.add(hash);
      continue;
    }
    inline.push(hash);
  }
  return { byHash, inline };
}

/**
 * The whole confirm-or-inline step for a BEST-EFFORT surface: confirm what can
 * be confirmed, inline what this window holds bytes for, and leave the rest
 * hash-only.
 *
 * Leaving a hash alone is the correct answer here rather than a failure. A chat
 * document routinely holds hashes whose bytes were never local - an image
 * copied out of a rendered message, a sent message reopened for edit, a quote
 * seed - and those address the epic's own attachment store, which the host
 * checks BEFORE it looks at the staging tier. A hash that is genuinely lost on
 * both sides reaches the host hash-only and comes back as the existing
 * `MISSING_ATTACHMENT_BYTES` rejection, which restores the prompt - the same
 * outcome, and the same message, as before any of this.
 *
 * The landing composer deliberately does NOT use this: a hash there names bytes
 * pasted into that window and existing nowhere else (no epic exists yet), so it
 * refuses instead of shipping a reference nothing can resolve.
 *
 * A node carrying both base64 and a hash is not a problem on the SEND path the
 * way it is on a create: the host's send-side materializer collects its hash
 * too but discards the `missing` set (the dangling-hash guard, which skips such
 * a node entirely, is what decides), so an annotation crop costs one wasted
 * probe and nothing else.
 */
export async function resolveSendContentByHash(input: {
  readonly hostId: string;
  readonly client: DraftBlobClient;
  readonly content: JsonContent;
  readonly plan: AttachmentsByHashPlan;
}): Promise<JsonContent> {
  const confirmed = await confirmAttachmentsByHash({
    hostId: input.hostId,
    client: input.client,
    plan: input.plan,
  });
  if (confirmed.inline.length === 0) return input.content;
  const bytesByHash = await resolveImageBytes(confirmed.inline);
  if (bytesByHash.size === 0) return input.content;
  return inlineImageHashes(input.content, bytesByHash);
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
 * `inlineImageHashes` clears the `hash` on every node it inlines, which is what
 * makes the post-inlining count the host's count and not an approximation of it.
 * The one node the two would disagree about - base64 AND a hash, which the host
 * counts and `imageHashesFromContent` skips - cannot occur on this path:
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
