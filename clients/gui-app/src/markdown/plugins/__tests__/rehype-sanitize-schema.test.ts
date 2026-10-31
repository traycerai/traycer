import { describe, expect, it } from "vitest";
import type { Schema } from "hast-util-sanitize";
import {
  extendTraycerSanitizeSchema,
  TRAYCER_SANITIZE_SCHEMA,
} from "@/markdown/plugins/rehype-sanitize-schema";
import {
  TRAYCER_CHAT_TAG,
  TRAYCER_MENTION_TAG,
} from "@/markdown/plugins/const";

describe("extendTraycerSanitizeSchema", () => {
  it("merges Traycer tag attributes with an existing allowlist for the same tag", () => {
    const base: Schema = {
      attributes: {
        [TRAYCER_CHAT_TAG]: ["data-caller-extra"],
        a: ["href"],
      },
    };

    const extended = extendTraycerSanitizeSchema(base);
    const chatAttrs = extended.attributes?.[TRAYCER_CHAT_TAG];

    expect(Array.isArray(chatAttrs)).toBe(true);
    expect(chatAttrs).toEqual(
      expect.arrayContaining([
        "data-caller-extra",
        "data-epic-id",
        "data-chat-id",
        "data-title",
      ]),
    );
    // Unrelated tag attributes stay intact.
    expect(extended.attributes?.a).toEqual(["href"]);
  });

  it("keeps a bot mention's element and the user id it carries", () => {
    expect(TRAYCER_SANITIZE_SCHEMA.tagNames).toContain(TRAYCER_MENTION_TAG);
    expect(TRAYCER_SANITIZE_SCHEMA.attributes?.[TRAYCER_MENTION_TAG]).toContain(
      "data-user-id",
    );
  });
});
