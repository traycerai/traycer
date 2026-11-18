/**
 * GUI artifact document authority: image node markdown round-trip and
 * schema acceptance of collaboration-only attachmentHash.
 */
import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { artifactDocumentBundle } from "@/editor-core";

const SRC = "images/cafe0123.png";
const ALT = "wireframe";
/** Distinct from the path so serialization can assert it never appears. */
const HASH = "collab-only-hash-xyz";

describe("artifactDocumentBundle image node", () => {
  it("accepts image attrs including attachmentHash via nodeFromJSON", () => {
    const doc = artifactDocumentBundle.schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: SRC, alt: ALT, attachmentHash: HASH },
        },
      ],
    });
    expect(doc.firstChild?.type.name).toBe("image");
    expect(doc.firstChild?.attrs).toMatchObject({
      src: SRC,
      alt: ALT,
      attachmentHash: HASH,
    });
  });

  it("parses ![alt](relative/path) into an image node", () => {
    const parsed = artifactDocumentBundle.markdownManager.parse(
      `![${ALT}](${SRC})`,
    );
    const image = parsed.content?.[0];
    expect(image?.type).toBe("image");
    expect(image?.attrs?.src).toBe(SRC);
    expect(image?.attrs?.alt).toBe(ALT);
  });

  it("serializes image nodes as ![alt](src) without attachmentHash", () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("artifact-body");
    prosemirrorJSONToYXmlFragment(
      artifactDocumentBundle.schema,
      {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: { src: SRC, alt: ALT, attachmentHash: HASH },
          },
        ],
      },
      fragment,
    );

    const markdown = artifactDocumentBundle.markdown.serialize(fragment);
    expect(markdown).toBe(`![${ALT}](${SRC})`);
    expect(markdown).not.toContain("attachmentHash");
    expect(markdown).not.toContain(HASH);
  });
});
