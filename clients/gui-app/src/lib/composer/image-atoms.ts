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
