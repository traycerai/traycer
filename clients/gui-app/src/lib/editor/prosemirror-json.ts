import type { Slice } from "@tiptap/pm/model";
import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * Wrap a copied ProseMirror slice into a `doc`-shaped JSON tree so a block-aware
 * serializer (markdown / structured plain text) can walk it the same way it
 * walks a whole document.
 *
 * A slice whose top level is inline (e.g. a fragment of bare text with no
 * enclosing block) is wrapped in a paragraph first, so the serializer emits one
 * block instead of treating each text run as its own block - the latter injects
 * a blank line between runs.
 *
 * Returns `null` for an empty slice. `Fragment.toJSON()` is typed `any` by
 * ProseMirror; it is funnelled through `unknown` and the `isJsonContent` guard
 * so no `any` escapes into the typed surface.
 */
export function sliceToDocJson(slice: Slice): JsonContent | null {
  const firstChild = slice.content.firstChild;
  if (firstChild === null) return null;
  const content: unknown = slice.content.toJSON();
  const doc: unknown = firstChild.isInline
    ? { type: "doc", content: [{ type: "paragraph", content }] }
    : { type: "doc", content };
  return isJsonContent(doc, 0) ? doc : null;
}

export function isJsonContent(
  value: unknown,
  depth: number,
): value is JsonContent {
  if (depth > 100) return false;
  if (!isRecord(value)) return false;
  if (!isStringOrUndefined(value.type)) return false;
  if (!isStringOrUndefined(value.text)) return false;
  if (!isAttrsOrUndefined(value.attrs)) return false;
  if (!isMarksOrUndefined(value.marks)) return false;
  const content = value.content;
  if (content === undefined) return true;
  return (
    Array.isArray(content) &&
    content.every((child) => isJsonContent(child, depth + 1))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrUndefined(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isAttrsOrUndefined(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isMarksOrUndefined(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((mark) => {
    if (!isRecord(mark)) return false;
    if (typeof mark.type !== "string") return false;
    return isAttrsOrUndefined(mark.attrs);
  });
}
