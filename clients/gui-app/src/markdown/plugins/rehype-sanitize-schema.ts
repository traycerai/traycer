import {
  TRAYCER_AGENT_TAG,
  TRAYCER_CHAT_TAG,
  TRAYCER_EPIC_TAG,
  TRAYCER_MERMAID_TAG,
  TRAYCER_SPEC_TAG,
  TRAYCER_TICKET_TAG,
} from "./const";
import type { Schema } from "hast-util-sanitize";
import { defaultSchema } from "rehype-sanitize";

// Windows drive pseudo-schemes (`C:\…` → scheme `c`). Sanitize runs before
// react-markdown's urlTransform, so a bare drive href is dropped here unless its
// single-letter scheme is allow-listed. `hast-util-sanitize` matches the scheme
// case-sensitively, so both `A`–`Z` (drives are usually upper-case) and `a`–`z`
// are listed. A single ASCII letter can never collide with an exact-match
// dangerous scheme (`javascript`, `data`, `vbscript`), so permitting these for
// `href` is safe; do not broaden to multi-letter schemes.
const DRIVE_LETTER_SCHEMES = Array.from({ length: 26 }, (_, index) => [
  String.fromCharCode(65 + index),
  String.fromCharCode(97 + index),
]).flat();

const TRAYCER_TAG_NAMES = [
  TRAYCER_CHAT_TAG,
  TRAYCER_AGENT_TAG,
  TRAYCER_EPIC_TAG,
  TRAYCER_SPEC_TAG,
  TRAYCER_TICKET_TAG,
  TRAYCER_MERMAID_TAG,
] as const;

const TRAYCER_TAG_ATTRIBUTES: Schema["attributes"] = {
  [TRAYCER_CHAT_TAG]: ["data-epic-id", "data-chat-id", "data-title"],
  [TRAYCER_AGENT_TAG]: ["data-agent-id", "data-display"],
  [TRAYCER_EPIC_TAG]: ["data-epic-id", "data-title"],
  [TRAYCER_SPEC_TAG]: ["data-epic-id", "data-spec-id", "data-title"],
  [TRAYCER_TICKET_TAG]: ["data-epic-id", "data-ticket-id", "data-title"],
  [TRAYCER_MERMAID_TAG]: ["data-code"],
};

/**
 * Merge product attribute allowlists onto a base schema without dropping
 * caller-supplied attributes for the same tag (spread overwrite would).
 */
function mergeTraycerTagAttributes(
  baseAttributes: Schema["attributes"],
): Schema["attributes"] {
  const base = baseAttributes ?? {};
  const traycerAttrs = TRAYCER_TAG_ATTRIBUTES ?? {};
  const merged: NonNullable<Schema["attributes"]> = { ...base };
  for (const tag of TRAYCER_TAG_NAMES) {
    const required = traycerAttrs[tag];
    if (!Array.isArray(required)) continue;
    if (!Object.hasOwn(base, tag)) {
      merged[tag] = [...required];
      continue;
    }
    const existing = base[tag];
    const existingList = Array.isArray(existing) ? existing : [];
    merged[tag] = [...existingList, ...required];
  }
  return merged;
}

/**
 * Extend Tailmark's (or any base) sanitize schema with Traycer product tags and
 * file-link protocols. Used as `StreamingMarkdown`'s `sanitizeSchema` so the
 * base `streamdown:` incomplete-link protocol is preserved.
 */
export function extendTraycerSanitizeSchema(schema: Schema): Schema {
  return {
    ...schema,
    protocols: {
      ...schema.protocols,
      href: [
        ...(schema.protocols?.href ?? []),
        "file",
        ...DRIVE_LETTER_SCHEMES,
      ],
    },
    tagNames: [...(schema.tagNames ?? []), ...TRAYCER_TAG_NAMES],
    attributes: mergeTraycerTagAttributes(schema.attributes),
  };
}

/**
 * Standalone product schema (tests / docs). Prefer
 * {@link extendTraycerSanitizeSchema} when composing with Tailmark's base.
 */
export const TRAYCER_SANITIZE_SCHEMA: Schema =
  extendTraycerSanitizeSchema(defaultSchema);
