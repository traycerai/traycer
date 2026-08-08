/**
 * Canonical allowlist of composer node/mark type names a persisted prompt
 * stash entry may contain, kept in one pure module the persistence codec
 * (`prompt-stash-codec.ts`) imports directly.
 *
 * The composer's actual Tiptap schema - chat, landing, and new-conversation
 * all share one `buildComposerExtensions` factory
 * (`components/chat/composer/editor/editor-config.ts`), there is no
 * per-surface variant. This list is hand-mirrored from that factory's
 * registered node/mark extensions rather than imported: this module is pure
 * persistence data and must not depend on live editor/UI configuration, and
 * Tiptap's own normalization on load is explicitly not a substitute for this
 * check - a node/mark type this repository doesn't recognize must make the
 * whole entry unavailable, not get silently reshaped or dropped by the
 * editor.
 *
 * Update by hand alongside any change to the registered extensions, and rely
 * on `__tests__/prompt-stash-schema-descriptor-drift.test.ts` - which builds
 * the real editor schema from `buildComposerExtensions` and diffs it against
 * these two sets - to catch a forgotten update instead of trusting review
 * alone.
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
