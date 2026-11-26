import { expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { commentDraftText } from "../comment-draft-text";

function paragraph(...content: JsonContent[]): JsonContent {
  return { type: "paragraph", content };
}

function text(value: string): JsonContent {
  return { type: "text", text: value };
}

function doc(...content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

it("keeps mention labels and list items in the attached comment", () => {
  const comment = doc(
    paragraph(
      text("Ask "),
      { type: "mention", attrs: { id: "user-1", label: "Ada" } },
      text(" to look"),
    ),
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [paragraph(text("first"))] },
        { type: "listItem", content: [paragraph(text("second"))] },
      ],
    },
    paragraph(),
  );
  expect(commentDraftText(comment)).toBe("Ask @Ada to look\nfirst\nsecond");
});
