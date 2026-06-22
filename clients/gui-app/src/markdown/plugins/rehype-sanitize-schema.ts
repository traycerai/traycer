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

export const TRAYCER_SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,

  // Keep `file:` links after react-markdown's urlTransform preserves them: the
  // markdown anchor intercepts every click and routes file links to an in-app
  // workspace tab, so they never trigger an uncontrolled navigation. The
  // drive-letter schemes ride the same intercepted file-link routing.
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "file",
      ...DRIVE_LETTER_SCHEMES,
    ],
  },

  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    TRAYCER_CHAT_TAG,
    TRAYCER_AGENT_TAG,
    TRAYCER_EPIC_TAG,
    TRAYCER_SPEC_TAG,
    TRAYCER_TICKET_TAG,
    TRAYCER_MERMAID_TAG,
  ],

  attributes: {
    ...defaultSchema.attributes,

    [TRAYCER_CHAT_TAG]: ["data-epic-id", "data-chat-id", "data-title"],

    [TRAYCER_AGENT_TAG]: ["data-agent-id", "data-display"],

    [TRAYCER_EPIC_TAG]: ["data-epic-id", "data-title"],

    [TRAYCER_SPEC_TAG]: ["data-epic-id", "data-spec-id", "data-title"],

    [TRAYCER_TICKET_TAG]: ["data-epic-id", "data-ticket-id", "data-title"],

    [TRAYCER_MERMAID_TAG]: ["data-code"],
  },
};
