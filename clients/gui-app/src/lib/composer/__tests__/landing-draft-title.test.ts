import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  LANDING_DRAFT_TITLE_FALLBACK,
  landingDraftDisplayTitle,
} from "@/lib/composer/landing-draft-title";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";

describe("landingDraftDisplayTitle", () => {
  it("falls back for empty and image-only content", () => {
    expect(landingDraftDisplayTitle(EMPTY_LANDING_DRAFT_CONTENT)).toBe(
      LANDING_DRAFT_TITLE_FALLBACK,
    );
    const imageOnly: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "shot.png",
                hash: "abc123",
                mimeType: "image/png",
                size: 3,
              },
            },
          ],
        },
      ],
    };
    expect(landingDraftDisplayTitle(imageOnly)).toBe(
      LANDING_DRAFT_TITLE_FALLBACK,
    );
  });

  it("uses the first non-empty line", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    };
    expect(landingDraftDisplayTitle(content)).toBe("first line");
  });
});
