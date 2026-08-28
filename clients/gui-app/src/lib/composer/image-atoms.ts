import type { JsonContent } from "@traycer/protocol/common/registry";

import { numberValue, stringValue } from "./tiptap-json-content";

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
