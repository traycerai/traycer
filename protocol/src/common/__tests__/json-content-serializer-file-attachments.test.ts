import { describe, expect, it } from "vitest";
import type { JsonContent } from "../registry";
import { jsonContentToMarkdown } from "../json-content-serializer";

const FILE_ATTRS = {
  id: "node-1",
  hash: "ab".repeat(32),
  fileName: "report.pdf",
  mediaType: "application/pdf",
  size: 1024,
};

function paragraphWith(node: JsonContent): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          node,
          { type: "text", text: " ok" },
        ],
      },
    ],
  };
}

describe("jsonContentToMarkdown fileAttachment nodes", () => {
  it.each(["llm", "user"] as const)(
    "writes the file name in place (%s)",
    (mentionFormat) => {
      expect(
        jsonContentToMarkdown(
          paragraphWith({ type: "fileAttachment", attrs: FILE_ATTRS }),
          { mentionFormat, platform: "POSIX" },
        ),
      ).toBe("see [file: report.pdf] ok");
    },
  );

  it("renders a node without file attachment attrs as an unknown node", () => {
    const { hash: _hash, ...withoutHash } = FILE_ATTRS;
    expect(
      jsonContentToMarkdown(
        paragraphWith({ type: "fileAttachment", attrs: withoutHash }),
        { mentionFormat: "llm", platform: "POSIX" },
      ),
    ).toBe("see  ok");
  });
});
