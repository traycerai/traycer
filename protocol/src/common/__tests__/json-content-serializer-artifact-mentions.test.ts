import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import { ContextType, jsonContentToMarkdown } from "../json-content-serializer";

function canvasMentionDoc(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          {
            type: "mention",
            attrs: {
              contextType: ContextType.Canvas,
              id: "screens",
              label: "Checkout screens",
              relPath: "/abs/epics/e1/artifacts/screens",
            },
          },
        ],
      },
    ],
  };
}

describe("html and canvas artifact mention serialization", () => {
  it("gives the LLM the artifact path and the user a typed label", () => {
    const llm = jsonContentToMarkdown(canvasMentionDoc(), {
      mentionFormat: "llm",
      platform: "POSIX",
    });
    const user = jsonContentToMarkdown(canvasMentionDoc(), {
      mentionFormat: "user",
      platform: "POSIX",
    });

    expect(llm).toContain("@/abs/epics/e1/artifacts/screens");
    expect(user).toContain("`canvas:Checkout screens`");
  });
});
