import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { draftTabModule } from "@/stores/tabs/kinds/draft";
import {
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

function draft(content: JsonContent): LandingDraftTab {
  return {
    id: "draft-1",
    content,
    selection: null,
    lastTouchedAt: 0,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
  };
}

function textContent(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

describe("draftTabModule.build name", () => {
  it("falls back to 'Start Page' for empty content", () => {
    expect(draftTabModule.build(draft(EMPTY_LANDING_DRAFT_CONTENT)).name).toBe(
      "Start Page",
    );
  });

  it("derives the label from the first line of typed content", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      ],
    };
    expect(draftTabModule.build(draft(content)).name).toBe("first line");
  });

  it("trims surrounding whitespace from the derived label", () => {
    expect(draftTabModule.build(draft(textContent("  spaced  "))).name).toBe(
      "spaced",
    );
  });

  it("falls back to 'Start Page' for image-only content (no derived text)", () => {
    const content: JsonContent = {
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
    expect(draftTabModule.build(draft(content)).name).toBe("Start Page");
  });
});
