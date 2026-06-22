import type { JsonContent } from "@traycer/protocol/common/registry";

/**
 * The empty editor document a fresh landing draft starts from.
 *
 * Lives in its own dependency-free leaf module so BOTH `landing-draft-store` and
 * `landing-composer-store` can read it at module-eval time without tripping the
 * stores' import cycle (`landing-draft-store` → `landing-image-gc` →
 * `landing-composer-store` → `landing-draft-store`). Reading it from
 * `landing-draft-store` directly would hit a temporal-dead-zone error when the
 * composer store evaluates first in that cycle.
 */
export const EMPTY_LANDING_DRAFT_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
