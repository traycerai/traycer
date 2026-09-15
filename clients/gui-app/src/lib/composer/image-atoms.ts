import type { JsonContent } from "@traycer/protocol/common/registry";

import { numberValue, stringValue } from "./tiptap-json-content";
import {
  DEFAULT_IMAGE_MIME_TYPE,
  isHostStorableImageMimeType,
} from "./host-storable-image-formats";

export interface ComposerImageAtom {
  readonly id: string;
  readonly fileName: string;
  // Inline base64 for freshly-pasted images; null for persisted (hash-only)
  // images loaded back into the editor when a sent message is edited.
  readonly b64content: string | null;
  readonly hash: string | null;
  readonly mimeType: string;
  readonly size: number | null;
}

export function collectImageAtoms(
  content: JsonContent,
): ReadonlyArray<ComposerImageAtom> {
  const out: ComposerImageAtom[] = [];
  walk(content, (node) => {
    if (node.type !== "imageAttachment") return false;
    const atom = atomFromAttrs(node.attrs);
    if (atom !== null) out.push(atom);
    return false;
  });
  return out;
}

export function containsImageAtoms(content: JsonContent): boolean {
  return walk(content, (node) => node.type === "imageAttachment");
}

export function appendImageAttachmentAtoms(
  content: JsonContent,
  atoms: ReadonlyArray<{
    readonly id: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly size: number | null;
    readonly b64content: string;
    readonly hash: string;
  }>,
): JsonContent {
  if (atoms.length === 0) return content;
  const nodes: JsonContent[] = atoms.map((atom) => ({
    type: "imageAttachment",
    attrs: {
      id: atom.id,
      fileName: atom.fileName,
      mimeType: atom.mimeType,
      size: atom.size,
      b64content: atom.b64content,
      hash: atom.hash,
    },
  }));
  const children = content.content ?? [];
  return {
    ...content,
    content: [...children, ...nodes],
  };
}

/**
 * Every hash carried by an image node that has NO inline bytes of its own - the
 * nodes whose rendering, stashing and sending all depend on some other store
 * still holding the bytes.
 *
 * Deliberately not `collectImageAtoms().filter(...)`: an atom needs an `id` to
 * exist at all, and a hash-only node with a malformed `id` is still a node the
 * send has to account for.
 */
export function hashOnlyImageHashes(
  content: JsonContent,
): ReadonlyArray<string> {
  const hashes = new Set<string>();
  const visit = (node: JsonContent): void => {
    if (node.type === "imageAttachment") {
      const hash = hashOnlyImageHash(node);
      if (hash !== null) hashes.add(hash);
      return;
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return Array.from(hashes);
}

/**
 * Whether this document holds an inline image node that a REWRITE WILL CLAIM -
 * a job still in flight, not merely bytes in the document.
 *
 * The distinction is the whole point and it was missing at first. A
 * rich-clipboard paste inserts bytes in place and a background job flips the
 * node to a hash, so such a node means "withhold the draft write; the small
 * document is seconds away". But a node whose declared format the host's writer
 * REFUSES is left inline deliberately and permanently - no job will ever claim
 * it. Treating that one as pending withheld the entire draft forever, text and
 * settings included, for the life of the composer, with removing the image the
 * only way out. It also silently broke the settled "a BMP keeps today's
 * behaviour" decision, since today's behaviour is that the draft mirrors.
 *
 * So this asks the same format question the ingest asks, defaulting a missing
 * `mimeType` exactly as `collectImageAtoms` does. The two must agree: if the
 * collector defaulted one way and the rewrite the other, a node with no
 * declared type would be withheld by one and ignored by the other.
 */
export function containsPendingInlineImageNode(content: JsonContent): boolean {
  return walk(content, (node) => {
    if (node.type !== "imageAttachment") return false;
    if (stringValue(node.attrs?.b64content) === null) return false;
    const mimeType =
      stringValue(node.attrs?.mimeType) ?? DEFAULT_IMAGE_MIME_TYPE;
    return isHostStorableImageMimeType(mimeType);
  });
}

/** This node's hash iff it is an image node carrying no inline bytes. */
function hashOnlyImageHash(node: JsonContent): string | null {
  if (node.type !== "imageAttachment") return null;
  const hash = stringValue(node.attrs?.hash);
  if (hash === null) return null;
  return stringValue(node.attrs?.b64content) === null ? hash : null;
}

/**
 * Rewrite each hash-only image node whose hash is in `bytesByHash` to carry
 * those bytes inline instead.
 *
 * The `hash` attr is DROPPED, not kept alongside: an image node carries exactly
 * one payload, and this is the shape a fresh paste produces - which is what
 * makes a re-inlined node indistinguishable on the wire from the inline path
 * that has always been there. Nodes with nothing to inline keep their identity,
 * so an unchanged subtree stays referentially equal for memoized renderers.
 */
export function inlineHashOnlyImageBytes(
  content: JsonContent,
  bytesByHash: ReadonlyMap<string, string>,
): JsonContent {
  if (bytesByHash.size === 0) return content;
  return rewriteHashOnlyImageNodes(content, bytesByHash);
}

function rewriteHashOnlyImageNodes(
  node: JsonContent,
  base64ByHash: ReadonlyMap<string, string>,
): JsonContent {
  const hash = hashOnlyImageHash(node);
  if (hash !== null) {
    const b64content = base64ByHash.get(hash);
    if (b64content === undefined) return node;
    const { hash: _hash, ...rest } = node.attrs ?? {};
    return { ...node, attrs: { ...rest, b64content } };
  }
  const children = node.content;
  if (children === undefined) return node;
  const next: JsonContent[] = [];
  let changed = false;
  for (const child of children) {
    const rewritten = rewriteHashOnlyImageNodes(child, base64ByHash);
    if (rewritten !== child) changed = true;
    next.push(rewritten);
  }
  if (!changed) return node;
  return { ...node, content: next };
}

/**
 * Content hash is the identity everywhere else (`excludeHashes`, the landing
 * image store), so exclusion is by hash - a pasted image that happens to share
 * a crop's file name must not vanish from the rendered message.
 */
export function omitImageAtomsByHash(
  content: JsonContent,
  hashes: ReadonlySet<string>,
): JsonContent {
  if (hashes.size === 0) return content;
  const children = content.content;
  if (children === undefined) return content;
  const next: JsonContent[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === "imageAttachment") {
      const hash = stringValue(child.attrs?.hash);
      if (hash !== null && hashes.has(hash)) {
        changed = true;
        continue;
      }
    }
    const rewritten = omitImageAtomsByHash(child, hashes);
    if (rewritten !== child) changed = true;
    next.push(rewritten);
  }
  if (!changed) return content;
  return { ...content, content: next };
}

function walk(
  node: JsonContent,
  visit: (node: JsonContent) => boolean,
): boolean {
  if (visit(node)) return true;
  const children = node.content;
  if (children === undefined) return false;
  for (const child of children) {
    if (walk(child, visit)) return true;
  }
  return false;
}

function atomFromAttrs(
  attrs: Record<string, unknown> | undefined,
): ComposerImageAtom | null {
  if (attrs === undefined) return null;
  const id = stringValue(attrs.id);
  const fileName = stringValue(attrs.fileName);
  const b64content = stringValue(attrs.b64content);
  const hash = stringValue(attrs.hash);
  const mimeType = stringValue(attrs.mimeType);
  if (id === null || (b64content === null && hash === null)) return null;
  return {
    id,
    fileName: fileName ?? "image",
    b64content,
    hash,
    mimeType: mimeType ?? "image/png",
    size: numberValue(attrs.size),
  };
}
