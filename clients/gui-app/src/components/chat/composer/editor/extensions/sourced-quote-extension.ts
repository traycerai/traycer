import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";

import { dataAttributeMap } from "./attribute-helpers";

/**
 * A quote that remembers where it came from. `blockquote` says "the user
 * quoted something"; this says "the user quoted THIS", and the protocol
 * serializer turns it into
 * `<quoted_artifact artifact_type=… artifact_id=… epic_id=…>` so the coding
 * agent can go read the source rather than working from the excerpt alone.
 *
 * The composer needs it in its schema even though nothing here authors one by
 * hand: Tiptap silently DROPS unknown node types on `setContent`, so a quote
 * appended to a draft from outside the editor (see `appendTerminalQuoteToDraft`)
 * would lose its source the moment the composer loaded that draft.
 */
export const SOURCED_QUOTE_ATTRIBUTE_NAMES: ReadonlyArray<string> = [
  "sourceType",
  "sourceId",
  "sourceEpicId",
];

export const ComposerSourcedQuote = TiptapNode.create({
  name: "sourcedQuote",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return dataAttributeMap(SOURCED_QUOTE_ATTRIBUTE_NAMES);
  },

  parseHTML() {
    // Outranks the plain `blockquote` rule StarterKit contributes. Both match
    // this element, and at equal priority ProseMirror settles the tie by schema
    // order - which the bare rule wins, parsing the quote back as an ordinary
    // blockquote and dropping the source attributes on any HTML round-trip
    // (a paste, a clipboard copy of the draft).
    return [{ tag: "blockquote[data-composer-sourced-quote]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "blockquote",
      mergeAttributes(HTMLAttributes, { "data-composer-sourced-quote": "" }),
      0,
    ];
  },
});
