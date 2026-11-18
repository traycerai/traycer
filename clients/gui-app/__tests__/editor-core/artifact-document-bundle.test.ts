import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { artifactDocumentBundle } from "@/editor-core";

describe("artifactDocumentBundle", () => {
  it("serializes a Y.XmlFragment with the artifact editor's canonical Markdown manager", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body");
    prosemirrorJSONToYXmlFragment(
      artifactDocumentBundle.schema,
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Export me" }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Keep formatting" }],
                  },
                ],
              },
            ],
          },
          {
            type: "mermaidBlock",
            attrs: { code: "graph TD\n  A --> B" },
          },
        ],
      },
      fragment,
    );

    expect(artifactDocumentBundle.markdown.serialize(fragment)).toBe(
      [
        "# Export me",
        "",
        "- [ ] Keep formatting",
        "",
        "```mermaid",
        "graph TD",
        "  A --> B",
        "```",
      ].join("\n"),
    );
  });
});
