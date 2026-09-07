/**
 * Canonical allowlist of composer node/mark type names a persisted prompt stash entry may contain, kept in one pure module the persistence codec (`prompt-stash-codec.ts`) imports directly.
 */

export const KNOWN_STASH_NODE_TYPES: ReadonlySet<string> = new Set([
  "doc",
  "paragraph",
  "text",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "hardBreak",
  "blockquote",
  "sourcedQuote",
  "mention",
  "slashCommand",
  "attachmentGroup",
  "imageAttachment",
]);

export const KNOWN_STASH_MARK_TYPES: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "strike",
  "underline",
  "code",
  "link",
]);
