import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { artifactDocumentBundle } from "@/editor-core";

describe("artifact document links", () => {
  it("uses an explicit non-navigating Link extension", () => {
    const extension = artifactDocumentBundle.extensions.find(
      (candidate) => candidate.name === "link",
    );

    expect(extension).toBeDefined();
    expect(extension?.options).toMatchObject({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { target: null, rel: null },
    });
    expect(artifactDocumentBundle.schema.marks.link).toBeDefined();
  });

  it("round-trips markdown links through the shared Yjs schema", () => {
    const markdown = "Read [the plan](https://example.com/plan).";
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("artifact-body");
    prosemirrorJSONToYXmlFragment(
      artifactDocumentBundle.schema,
      artifactDocumentBundle.markdownManager.parse(markdown),
      fragment,
    );

    expect(artifactDocumentBundle.markdown.serialize(fragment)).toBe(markdown);
  });
});
