import type { JsonContent } from "@traycer/protocol/common/registry";

/** The empty editor document a fresh landing draft starts from. */
export const EMPTY_LANDING_DRAFT_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/** Value-based content equality. */
export function sameJsonContent(a: JsonContent, b: JsonContent): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
