import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { artifactDocumentBundle } from "@/editor-core";
import { createArtifactExport } from "@/lib/artifacts";
import { unzipSync } from "fflate";

function createFragment(markdown: string): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("artifact-body");
  prosemirrorJSONToYXmlFragment(
    artifactDocumentBundle.schema,
    artifactDocumentBundle.markdownManager.parse(markdown),
    fragment,
  );
  return fragment;
}

describe("createArtifactExport", () => {
  it("exports one artifact as canonical Markdown", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "artifact-1",
          title: "Release plan",
          fragment: createFragment("# Release plan\n\n- [ ] Ship it"),
        },
      ],
      format: "markdown",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(result.suggestedName).toBe("Release plan.md");
    expect(result.blob.type).toBe("text/markdown;charset=utf-8");
    expect(await result.blob.text()).toBe("# Release plan\n\n- [ ] Ship it");
  });

  it("creates cross-platform-safe, collision-deduped ZIP entries in selected order", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "parent",
          title: "Roadmap?/Q3",
          fragment: createFragment("# Parent"),
        },
        {
          id: "child",
          title: "roadmap:/q3",
          fragment: createFragment("# Child"),
        },
        {
          id: "reserved",
          title: "CON",
          fragment: createFragment("# Reserved"),
        },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "../Quarter: 3",
    });

    expect(result.suggestedName).toBe("Quarter 3.zip");
    expect(result.blob.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(entries)).toEqual([
      "Roadmap Q3.md",
      "roadmap q3 (2).md",
      "_CON.md",
    ]);
    expect(new TextDecoder().decode(entries["Roadmap Q3.md"])).toBe("# Parent");
    expect(new TextDecoder().decode(entries["roadmap q3 (2).md"])).toBe(
      "# Child",
    );
    expect(new TextDecoder().decode(entries["_CON.md"])).toBe("# Reserved");
  });

  it("exports a PDF Blob with a valid PDF signature", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "artifact-pdf",
          title: "Design",
          fragment: createFragment("# Design\n\nPortable content"),
        },
      ],
      format: "pdf",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(result.suggestedName).toBe("Design.pdf");
    expect(result.blob.type).toBe("application/pdf");
    const signature = new TextDecoder().decode(
      new Uint8Array(await result.blob.arrayBuffer()).slice(0, 5),
    );
    expect(signature).toBe("%PDF-");
  });

  it("reports which selected artifact is unavailable", async () => {
    await expect(
      createArtifactExport({
        artifacts: [
          {
            id: "missing",
            title: "Missing review",
            fragment: null,
          },
        ],
        format: "markdown",
        archive: true,
        archiveTitle: "Reviews",
      }),
    ).rejects.toThrow('Artifact "Missing review" is unavailable for export.');
  });
});
