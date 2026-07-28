import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * The empty editor document a fresh landing draft starts from.
 *
 * Lives in a dependency-free leaf so both the persisted draft source and the
 * renderer-local runtime registry can seed a document without a store cycle.
 */
export const EMPTY_LANDING_DRAFT_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/**
 * Value-based content equality. Reference identity is never enough here: every
 * editor callback hands back a fresh `editor.getJSON()` object, so an identity
 * check reports "changed" for documents that are byte-identical.
 *
 * This runs on the CANONICAL in-memory content, which may transiently carry a
 * paste's pending b64 image node (bounded by the per-image 5MB cap plus the
 * aggregate image budget) until its background job flips it to a hash. The
 * serialization is therefore bounded, and a stable JSON serialization
 * short-circuits identical echoes without a deep structural walk.
 */
export function sameJsonContent(a: JsonContent, b: JsonContent): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
