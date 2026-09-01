import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { serializeArtifactMarkdown } from "@/lib/artifacts/artifact-export";
import { artifactDocumentBundle } from "@/editor-core";
import { createArtifactExport } from "@/lib/artifacts";
import { unzipSync } from "fflate";

/**
 * Still round-trips through a real `Y.XmlFragment` rather than handing the
 * builder its input string back: the export used to serialize the fragment
 * itself, so parsing and re-serializing here keeps these expectations pinned to
 * the same bytes that change moved OUT of the builder.
 */
function createBody(markdown: string): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("artifact-body");
  prosemirrorJSONToYXmlFragment(
    artifactDocumentBundle.schema,
    artifactDocumentBundle.markdownManager.parse(markdown),
    fragment,
  );
  return serializeArtifactMarkdown(fragment);
}

describe("createArtifactExport", () => {
  it("requires at least one artifact", async () => {
    await expect(
      createArtifactExport({
        artifacts: [],
        format: "markdown",
        archive: true,
        archiveTitle: "Empty",
      }),
    ).rejects.toThrow("Select at least one artifact to export.");
  });

  it("rejects multiple artifacts without an archive", async () => {
    await expect(
      createArtifactExport({
        artifacts: [
          {
            id: "artifact-1",
            title: "First",
            markdown: createBody("# First"),
          },
          {
            id: "artifact-2",
            title: "Second",
            markdown: createBody("# Second"),
          },
        ],
        format: "markdown",
        archive: false,
        archiveTitle: "ignored",
      }),
    ).rejects.toThrow("Individual export requires exactly one artifact.");
  });

  it("exports one artifact as canonical Markdown", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "artifact-1",
          title: "Release plan",
          markdown: createBody("# Release plan\n\n- [ ] Ship it"),
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
          markdown: createBody("# Parent"),
        },
        {
          id: "child",
          title: "roadmap:/q3",
          markdown: createBody("# Child"),
        },
        {
          id: "reserved",
          title: "CON",
          markdown: createBody("# Reserved"),
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

  it("preserves complete Unicode code points in exported filenames", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "unicode",
          title: `${"a".repeat(119)}🐇tail`,
          markdown: createBody("Unicode"),
        },
      ],
      format: "markdown",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(result.suggestedName).toBe(`${"a".repeat(119)}🐇.md`);
  });

  it("exports a PDF Blob with a valid PDF signature", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "artifact-pdf",
          title: "Design",
          markdown: createBody("# Design\n\nPortable content"),
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
            markdown: null,
          },
        ],
        format: "markdown",
        archive: true,
        archiveTitle: "Reviews",
      }),
    ).rejects.toThrow('Artifact "Missing review" is unavailable for export.');
  });
});
