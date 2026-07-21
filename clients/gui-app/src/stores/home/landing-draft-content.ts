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
