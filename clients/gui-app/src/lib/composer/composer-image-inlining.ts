/**
 * Turning hash-only composer content back into the inline-base64 shape the host
 * ingests today, at the moment of submit.
 *
 * Every composer surface PASTES hash-first — bytes go to the window's composer
 * image store and the node carries only a `hash`. This module is the seam that
 * puts the bytes back for the wire: the landing create, the in-epic send, the
 * edit-and-resend, the new-conversation create and the initial-chat handoff
 * resend all go through here, so the "what the host receives" question has
 * exactly one answer.
 *
 * WHEN IT RUNS IS A NEGOTIATION, NOT A RULE. Inlining is not what a send does;
 * it is what a send falls back to. Every producer asks first, but they do not
 * all ask the same question. The two CREATE surfaces — the landing composer
 * on `epic.create`, the new-conversation modal on `epic.createChat` — read
 * that UNARY method's own negotiated minor and need `1.2`; the three SEND
 * surfaces — the in-epic composer, the edit-and-resend, the initial-chat
 * handoff resend — read the `chat.subscribe` STREAM minor and need `1.11`.
 * The two gates are `createAttachmentsByHashSupported` and
 * `sendAttachmentsByHashSupported` (`attachments-by-hash.ts`); both fail
 * closed, and both also require that the host is not withholding
 * `drafts.putBlob`. On a host that takes attachments BY HASH the document
 * goes out hash-only with the bytes pushed to that host's blob tier instead.
 * This module is the arm below whichever of those two minors applies,
 * plus the best-effort arm above it: a chat document routinely holds
 * hashes this window never had the bytes for (an image copied out of a
 * rendered message, a restored failed send, one that addresses the host's
 * own epic attachment store), and those are left hash-only for the host
 * to resolve rather than refused. Only the landing composer, which must
 * have local bytes for a chat that does not exist yet, refuses.
 *
 * NOR IS THE PERSISTED SIDE UNIFORMLY BASE64-FREE. Drafts, localStorage and the
 * desktop projection are stripped, and that is the point of the hash-first
 * model. The HOST DRAFT MIRROR is the deliberate exception: `drafts.upsert`
 * carries the in-memory document with a pending node's base64 intact, because
 * the mirror echoes back and a stripped echo would delete a node whose
 * background ingest has not finished hashing it yet. The write that follows the
 * ingest carries the hash, so the base64 is transient rather than stored — and
 * a mirror row that outlives the ingest is a pending node the next write
 * settles, not a leak.
 *
 * Two paths, both of which a caller has to handle:
 *
 * - The SESSION path ({@link readSessionImageBytes}) is synchronous and covers
 *   the overwhelmingly common "you just pasted it" case, which is what lets a
 *   submit stay in one stack frame — no await between reading the document and
 *   clearing it.
 * - The STORE path ({@link resolveImageBytes}) awaits IndexedDB and covers a
 *   draft restored in a later session. A hash with no bytes on either path is
 *   reported as missing rather than silently dropped: an image the user can see
 *   in their composer must never vanish from the message without being told.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/composer-image-store";
import { stringValue } from "@/lib/composer/tiptap-json-content";

/**
 * Distinct hashes in `content` whose node needs bytes resolved before it can be
 * sent — that is, HASH-ONLY nodes.
 *
 * A node that already carries `b64content` is skipped even when it also carries
 * a `hash`. That combination is not the XOR paste shape; it is the browser
 * annotation crop atom (`appendImageAttachmentAtoms`), which deliberately
 * carries both because the rendered message de-duplicates the crop BY HASH.
 * Resolving it would be wasted work, and inlining it would clear the very
 * `hash` that dedupe reads (see {@link inlineImageHashes}).
 */
export function imageHashesFromContent(content: JsonContent): string[] {
  return Array.from(
    new Set(
      collectImageAtoms(content).flatMap((atom) =>
        atom.hash !== null && atom.b64content === null ? [atom.hash] : [],
      ),
    ),
  );
}

/**
 * Synchronous resolve of every hash from the session cache. Returns `null` if
 * ANY hash is missing, signalling the caller to fall back to the async
 * IndexedDB path; a complete map keeps the submit fully synchronous.
 */
export function readSessionImageBytes(
  hashes: ReadonlyArray<string>,
): Map<string, Uint8Array> | null {
  const bytesByHash = new Map<string, Uint8Array>();
  for (const hash of hashes) {
    const bytes = sessionImageBytes(hash);
    if (bytes === null) return null;
    bytesByHash.set(hash, bytes);
  }
  return bytesByHash;
}

/**
 * Async resolve via the composer image store (session ?? IndexedDB). Hashes
 * with no bytes are simply absent from the map; the caller treats those as
 * missing and refuses the send rather than dropping the image.
 */
export async function resolveImageBytes(
  hashes: ReadonlyArray<string>,
): Promise<Map<string, Uint8Array>> {
  const bytesByHash = new Map<string, Uint8Array>();
  await Promise.all(
    hashes.map(async (hash) => {
      const bytes = await getImageBytes(hash);
      if (bytes !== undefined) bytesByHash.set(hash, bytes);
    }),
  );
  return bytesByHash;
}

/**
 * Replace each resolvable `imageAttachment` hash with inline base64, matching a
 * fresh base64 paste's node shape (`b64content` set, `hash` cleared) so the host
 * ingests it identically. Nodes without resolvable bytes are left unchanged.
 *
 * A node that ALREADY carries `b64content` is returned untouched — see
 * {@link imageHashesFromContent} for why that case exists and why clearing its
 * `hash` would break the annotation-crop dedupe.
 */
export function inlineImageHashes(
  node: JsonContent,
  bytesByHash: ReadonlyMap<string, Uint8Array>,
): JsonContent {
  if (node.type === "imageAttachment") {
    if (stringValue(node.attrs?.b64content) !== null) return node;
    const hash = stringValue(node.attrs?.hash);
    if (hash === null) return node;
    const bytes = bytesByHash.get(hash);
    if (bytes === undefined) return node;
    return {
      ...node,
      attrs: { ...node.attrs, b64content: bytesToBase64(bytes), hash: null },
    };
  }
  const children = node.content;
  if (children === undefined) return node;
  return {
    ...node,
    content: children.map((child) => inlineImageHashes(child, bytesByHash)),
  };
}

/**
 * The whole inline step for a caller that can only resolve synchronously, or
 * that wants to take the fast path before committing to an await: the content
 * with every hash inlined, or `null` when at least one hash is session-cold and
 * the caller must go through {@link resolveImageBytes}.
 */
export function inlineImageHashesFromSession(
  content: JsonContent,
): JsonContent | null {
  const hashes = imageHashesFromContent(content);
  if (hashes.length === 0) return content;
  const sessionBytes = readSessionImageBytes(hashes);
  if (sessionBytes === null) return null;
  return inlineImageHashes(content, sessionBytes);
}

/**
 * The async half, BEST EFFORT: inline every hash this window's store can
 * resolve and leave the rest hash-only.
 *
 * Leaving a hash alone is not a failure on a chat surface, it is the correct
 * answer. A chat composer's document routinely holds hashes whose bytes were
 * never in the LOCAL store at all — an image copied out of a rendered message,
 * a sent message loaded back into the edit composer, a failed send restored to
 * the draft. Those address the epic attachment store on the HOST, which
 * resolves them exactly as it does today; inlining is only ever about bytes
 * this window happens to hold.
 *
 * So the refusal belongs to the landing composer alone (a hash with no local
 * bytes there names nothing, because no epic exists yet), and it keeps its own
 * explicit missing-check rather than sharing this. Here, a hash that is
 * genuinely lost on both sides reaches the host hash-only and comes back as the
 * existing `MISSING_ATTACHMENT_BYTES` rejection, which restores the prompt —
 * the same outcome, and the same message, as before this change.
 */
export async function inlineLocalImageHashes(
  content: JsonContent,
): Promise<JsonContent> {
  const hashes = imageHashesFromContent(content);
  if (hashes.length === 0) return content;
  const bytesByHash = await resolveImageBytes(hashes);
  if (bytesByHash.size === 0) return content;
  return inlineImageHashes(content, bytesByHash);
}
